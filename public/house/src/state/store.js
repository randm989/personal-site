// Entity state store. Holds Home Assistant-shaped states by entity_id and the connection status.
// Knows nothing about the plan or bindings; derive.js turns its contents into what is shown.

/**
 * @param {{ now?: () => number, schedule?: (fn: () => void) => void }} [options]
 *   now: clock (tests). schedule: how a batched notification is queued (default: one animation frame).
 */
export function createStore(options = {}) {
  const now = options.now || (() => Date.now());
  const schedule = options.schedule || defaultSchedule;

  /** @type {Map<string, object>} */
  const states = new Map();
  const subscribers = new Set();
  let connection = 'connecting';
  let snapshotAt = null;
  let queued = false;

  function notify() {
    if (queued) return;
    queued = true;
    schedule(() => {
      queued = false;
      for (const fn of [...subscribers]) {
        try { fn(); } catch (err) { console.error('store subscriber failed', err); }
      }
    });
  }

  function valid(state) {
    return state && typeof state.entity_id === 'string';
  }

  return {
    applySnapshot(list) {
      if (!Array.isArray(list)) throw new Error('store.applySnapshot expects an array of entity states');
      states.clear();
      for (const s of list) if (valid(s)) states.set(s.entity_id, s);
      snapshotAt = now();
      notify();
    },
    applyChange(state) {
      if (!valid(state)) throw new Error('store.applyChange expects an entity state with an entity_id');
      states.set(state.entity_id, state);
      if (connection !== 'offline') snapshotAt = now();
      notify();
    },
    remove(entityId) {
      if (states.delete(entityId)) notify();
    },
    setConnection(status) {
      if (status !== 'connecting' && status !== 'live' && status !== 'offline') {
        throw new Error(`store.setConnection: unknown status "${status}"`);
      }
      if (status === connection) return;
      // The state was good up to the moment the link was seen to drop; after that the time stands still.
      if (connection === 'live' && status !== 'live') snapshotAt = now();
      connection = status;
      notify();
    },
    get(entityId) { return states.get(entityId); },
    all() { return [...states.values()]; },
    get connection() { return connection; },
    get snapshotAt() { return snapshotAt; },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };
}

function defaultSchedule(fn) {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => fn());
  else setTimeout(fn, 16);
}
