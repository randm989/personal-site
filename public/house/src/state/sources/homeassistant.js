// Home Assistant WebSocket state source (docs/research/02-platform-hardware-brain.md §2).
//
//   server: auth_required  →  client: auth  →  server: auth_ok | auth_invalid
//   client: subscribe_events(state_changed) (id 1), get_states (id 2)
//   server: result(get_states) → onSnapshot, then every state_changed event → onChange / onRemove
//   client: ping every 30 s; no pong in time, or the socket closing, → 'offline' and a backed-off reconnect
//
// The subscription is sent before get_states so no change can fall in the gap between them; events that
// arrive before the snapshot are held and replayed after it. The access token is never logged or put in an error.

const DEFAULTS = {
  pingIntervalMs: 30000,
  pongTimeoutMs: 10000,
  backoffBaseMs: 1000,
  backoffMaxMs: 30000,
};

/**
 * @param {Object} options
 * @param {string} options.url      'ws://host:8123/api/websocket', or the plain 'http://host:8123' address
 * @param {string} options.token    long-lived access token
 * @param {Function} [options.WebSocketImpl]  WebSocket constructor (tests inject a fake)
 * @param {{setTimeout:Function, clearTimeout:Function}} [options.timers]  (tests)
 * @param {number} [options.pingIntervalMs] @param {number} [options.pongTimeoutMs]
 * @param {number} [options.backoffBaseMs]  @param {number} [options.backoffMaxMs]
 */
export function createHomeAssistantSource(options = {}) {
  const { url, token } = options;
  const WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
  const cfg = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) if (typeof options[key] === 'number') cfg[key] = options[key];
  const timers = options.timers || {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id),
  };
  if (!url) throw new Error('Home Assistant source: a url is required');
  if (!token) throw new Error('Home Assistant source: an access token is required');
  if (typeof WebSocketImpl !== 'function') throw new Error('Home Assistant source: no WebSocket implementation available');
  const endpoint = normaliseUrl(url);
  // http(s)://host:port, for turning the hub's relative picture paths into fetchable addresses.
  const baseUrl = endpoint.replace(/^ws/i, 'http').replace(/\/api\/websocket\/?$/, '');

  let handlers = null;
  let ws = null;
  let stopped = true;
  let status = null;
  let nextId = 1;
  let subscriptionId = null;
  let gotSnapshot = false;
  let held = [];
  let attempt = 0;
  let pingTimer = null;
  let pongTimer = null;
  let retryTimer = null;
  /** @type {Map<number, {resolve:Function, reject:Function}>} */
  let pending = new Map();

  const source = {
    name: 'homeassistant',
    /** The last fatal error (rejected token), or null. */
    error: null,
    start(h) {
      if (!stopped) throw new Error('Home Assistant source: already started');
      handlers = h || {};
      stopped = false;
      source.error = null;
      attempt = 0;
      setStatus('connecting');
      connect();
    },
    stop() {
      stopped = true;
      clearTimers();
      failPending('Home Assistant source stopped');
      const socket = ws;
      ws = null;
      if (socket) { detach(socket); try { socket.close(); } catch { /* already closed */ } }
    },
    /** Home Assistant service call, e.g. call('light', 'turn_off', { entity_id }). Resolves when the action finished. */
    call(domain, service, data = {}) {
      if (!ws || status !== 'live') return Promise.reject(new Error('Not connected to Home Assistant'));
      const { entity_id: entityId, ...serviceData } = data || {};
      const message = { type: 'call_service', domain, service };
      if (Object.keys(serviceData).length) message.service_data = serviceData;
      if (entityId != null) message.target = { entity_id: entityId };
      return request(message).then(() => undefined);
    },
  };
  return source;

  function setStatus(next) {
    if (status === next) return;
    status = next;
    if (handlers && handlers.onConnection) handlers.onConnection(next);
  }

  function connect() {
    retryTimer = null;
    if (stopped) return;
    nextId = 1;
    subscriptionId = null;
    gotSnapshot = false;
    held = [];
    pending = new Map();
    let socket;
    try {
      socket = new WebSocketImpl(endpoint);
    } catch (err) {
      console.error('Home Assistant: could not open a socket', err && err.message);
      dropped(null);
      return;
    }
    ws = socket;
    socket.onmessage = (ev) => { if (ws === socket) receive(socket, ev.data); };
    socket.onclose = () => dropped(socket);
    socket.onerror = () => { /* a close event follows; the reconnect is handled there */ };
  }

  function detach(socket) {
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
  }

  function send(socket, message) {
    socket.send(JSON.stringify(message));
  }

  /** Send a command; the callbacks run synchronously when its result (or the loss of the link) arrives. */
  function command(message, resolve, reject) {
    const socket = ws;
    const id = nextId++;
    pending.set(id, { resolve, reject });
    try { send(socket, { id, ...message }); } catch (err) { pending.delete(id); reject(err); }
    return id;
  }

  function request(message) {
    return new Promise((resolve, reject) => { command(message, resolve, reject); });
  }

  function receive(socket, raw) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { console.error('Home Assistant: unreadable frame ignored'); return; }
    // With coalesce_messages a frame may be an array; accept both.
    for (const msg of Array.isArray(parsed) ? parsed : [parsed]) {
      if (ws !== socket) return;
      if (msg && typeof msg === 'object') handle(socket, msg);
    }
  }

  function handle(socket, msg) {
    switch (msg.type) {
      case 'auth_required':
        send(socket, { type: 'auth', access_token: token });
        break;
      case 'auth_ok': {
        const failed = (what) => (err) => {
          if (ws !== socket) return;
          console.error(`Home Assistant: ${what} failed:`, err && err.message);
          restart(socket);
        };
        subscriptionId = command({ type: 'subscribe_events', event_type: 'state_changed' }, () => {}, failed('subscribing'));
        command({ type: 'get_states' }, (states) => {
          if (ws !== socket) return;
          gotSnapshot = true;
          if (handlers.onSnapshot) handlers.onSnapshot((Array.isArray(states) ? states : []).map(withFeedUrl));
          const replay = held;
          held = [];
          for (const data of replay) applyEvent(data);
          attempt = 0;
          setStatus('live');
          schedulePing(socket);
        }, failed('get_states'));
        break;
      }
      case 'auth_invalid': {
        // A wrong token will not fix itself: say so and stop. No retry.
        const error = new Error(`Home Assistant rejected the access token${msg.message ? `: ${msg.message}` : ''}. Create a new long-lived token and try again.`);
        error.code = 'auth_invalid';
        source.error = error;
        stopped = true;
        clearTimers();
        ws = null;
        detach(socket);
        try { socket.close(); } catch { /* the server closes it anyway */ }
        setStatus('offline');
        if (handlers.onError) handlers.onError(error);
        else console.error(error.message);
        break;
      }
      case 'result': {
        const p = pending.get(msg.id);
        if (!p) break;
        pending.delete(msg.id);
        if (msg.success) p.resolve(msg.result);
        else {
          const e = msg.error || {};
          const error = new Error(e.message || e.code || 'Home Assistant refused the request');
          error.code = e.code;
          p.reject(error);
        }
        break;
      }
      case 'event':
        if (msg.id === subscriptionId && msg.event && msg.event.event_type === 'state_changed' && msg.event.data) {
          if (gotSnapshot) applyEvent(msg.event.data);
          else held.push(msg.event.data);
        }
        break;
      case 'pong': {
        if (pongTimer != null) { timers.clearTimeout(pongTimer); pongTimer = null; }
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); p.resolve(); }
        schedulePing(socket);
        break;
      }
      default:
        break;
    }
  }

  function applyEvent(data) {
    if (data.new_state == null) {
      if (data.entity_id && handlers.onRemove) handlers.onRemove(data.entity_id);
    } else if (handlers.onChange) {
      handlers.onChange(withFeedUrl(data.new_state));
    }
  }

  /**
   * A camera's `entity_picture` is a path on the hub ('/api/camera_proxy/camera.x?token=…') carrying its own
   * short-lived token. Add `feed_url`, the same picture as a full address. The long-lived access token is
   * never put in a URL.
   */
  function withFeedUrl(state) {
    if (!state || typeof state.entity_id !== 'string' || !state.entity_id.startsWith('camera.')) return state;
    const picture = state.attributes && state.attributes.entity_picture;
    if (typeof picture !== 'string' || !picture.startsWith('/') || picture.startsWith('//')) return state;
    return { ...state, attributes: { ...state.attributes, feed_url: baseUrl + picture } };
  }

  function schedulePing(socket) {
    if (pingTimer != null) timers.clearTimeout(pingTimer);
    pingTimer = timers.setTimeout(() => {
      pingTimer = null;
      if (ws !== socket || stopped) return;
      command({ type: 'ping' }, () => {}, () => { /* answered by the drop handling */ });
      pongTimer = timers.setTimeout(() => {
        pongTimer = null;
        if (ws === socket) restart(socket);     // silence: treat as a dead link
      }, cfg.pongTimeoutMs);
    }, cfg.pingIntervalMs);
  }

  /** Give up on this socket and go through the normal drop path. */
  function restart(socket) {
    if (ws !== socket) return;
    detach(socket);
    try { socket.close(); } catch { /* already closed */ }
    dropped(socket);
  }

  function dropped(socket) {
    if (socket && ws !== socket) return;
    ws = null;
    if (socket) detach(socket);
    if (pingTimer != null) { timers.clearTimeout(pingTimer); pingTimer = null; }
    if (pongTimer != null) { timers.clearTimeout(pongTimer); pongTimer = null; }
    failPending('Connection to Home Assistant lost');
    if (stopped) return;
    setStatus('offline');
    const delay = Math.min(cfg.backoffMaxMs, cfg.backoffBaseMs * 2 ** attempt);
    attempt += 1;
    retryTimer = timers.setTimeout(connect, delay);
  }

  function failPending(reason) {
    const waiting = [...pending.values()];
    pending = new Map();
    for (const p of waiting) p.reject(new Error(reason));
  }

  function clearTimers() {
    for (const t of [pingTimer, pongTimer, retryTimer]) if (t != null) timers.clearTimeout(t);
    pingTimer = pongTimer = retryTimer = null;
  }
}

/** Accepts ws(s)://…/api/websocket, or the address people actually know: http(s)://host:8123. */
function normaliseUrl(url) {
  let u = String(url).trim();
  if (/^https?:/i.test(u)) u = u.replace(/^http/i, 'ws');
  else if (!/^wss?:/i.test(u)) u = `ws://${u}`;
  if (!/\/api\/websocket\/?$/.test(u)) u = `${u.replace(/\/+$/, '')}/api/websocket`;
  return u;
}
