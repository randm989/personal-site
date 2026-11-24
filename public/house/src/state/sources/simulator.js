// Simulator state source. Fabricates one Home Assistant-shaped entity for every binding and emits
// states exactly as the Home Assistant adapter would, so nothing downstream can tell them apart.
//
//   createSimulatorSource(plan, bindings, { scenario, scenarios, freeze, speed, now, auto, seed })
//     scenario  one of SCENARIOS (default 'evening'); each is a deterministic starting state
//     scenarios the house's scenario tables (the default export of data/scenarios.js)
//     freeze    true: the scenario holds still (service calls and their motion still work)
//     speed     script speed multiplier (2 = things happen twice as often)
//     now       epoch ms, or a function returning it (tests); default is the real clock
//     auto      false: no timer; drive it with source.advance(ms) (tests)
//     seed      PRNG seed for the script
//
// Extra beyond the StateSource contract, for tests and tools: snapshot(), advance(ms), scenario, and
// problems (entity ids a scenario table names that bindings.json does not have).

export const SCENARIOS = ['evening', 'quiet', 'away', 'alert', 'stale', 'empty', 'offline'];

const MIN = 60 * 1000;
const GARAGE_TRAVEL_MS = 12000;
const BLIND_TRAVEL_MS = 6000;
const STEP_MS = 1000;
const HEARTBEAT_MS = 10 * MIN;
const OFFLINE_AFTER_MS = 4000;

// Scenario tables are per house and live next to each house's data (data/scenarios.js,
// data/placeholder/scenarios.js): scenario name → { entity id → { state, attributes, ago (minutes since
// last_changed), reportedAgo, silent, clear } }. A table may also be a function returning one.
// Entities a table does not name start in a quiet default; with no tables at all every scenario is that
// quiet house, which still works for any plan and bindings.
const LIVELY = new Set(['evening', 'alert', 'offline']);

// ---------------------------------------------------------------------------------------------

export function createSimulatorSource(plan, bindings, options = {}) {
  const scenario = options.scenario || 'evening';
  if (!SCENARIOS.includes(scenario)) {
    throw new Error(`Simulator: unknown scenario "${scenario}". Known scenarios: ${SCENARIOS.join(', ')}.`);
  }
  if (!plan || !plan.things) throw new Error('Simulator: the plan has no things index');
  const freeze = !!options.freeze;
  const speed = typeof options.speed === 'number' && options.speed > 0 ? options.speed : 1;
  const auto = options.auto !== false;
  const nowFn = typeof options.now === 'function' ? options.now : null;
  const fixed = typeof options.now === 'number' ? options.now : null;
  let offset = 0;
  const clock = () => (nowFn ? nowFn() : (fixed != null ? fixed : Date.now()) + offset);
  const random = mulberry32(options.seed == null ? 20261123 : options.seed);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const between = (a, b) => a + random() * (b - a);

  const bound = Object.entries((bindings && bindings.entities) || {})
    .filter(([, b]) => b && plan.things[b.thing])
    .map(([entityId, b]) => ({ entityId, role: b.role, thing: plan.things[b.thing], person: b.person || null }));
  const roleOf = new Map(bound.map((b) => [b.entityId, b]));
  const peopleNames = (bindings && bindings.people) || {};
  const problems = [];

  /** entity id → { state, attributes, changedAt, updatedAt, reportedAt, silent, memory } */
  const entities = new Map();
  let handlers = null;
  let connection = 'connecting';
  let timer = null;
  let lastTick = 0;
  let t = 0;                       // script time, ms
  let lastHeartbeat = clock();
  /** entity id → { target } */
  const motions = new Map();
  /** { at, fn }[] in script time */
  let schedule = [];
  /** [weight, fn] the script may pick from */
  let events = [];

  build();

  const source = {
    name: 'simulator',
    scenario,
    problems,
    start(h) {
      handlers = h || {};
      setConnection('connecting');
      if (handlers.onSnapshot) handlers.onSnapshot(source.snapshot());
      setConnection('live');
      if (scenario === 'offline') at(OFFLINE_AFTER_MS, () => setConnection('offline'));
      if (!freeze && LIVELY.has(scenario)) startScript();
      else if (!freeze && scenario !== 'empty') at(between(6000, 9000), driftLoop);
      if (auto) {
        lastTick = Date.now();
        timer = setInterval(() => {
          const real = Date.now();
          const delta = Math.min(real - lastTick, 5000);     // a sleeping tab does not replay an hour of script
          lastTick = real;
          if (fixed != null) offset += delta;
          run(delta * speed, false);
        }, 250);
      }
    },
    stop() {
      if (timer != null) clearInterval(timer);
      timer = null;
      handlers = null;
    },
    /** Every current entity state, Home Assistant-shaped. */
    snapshot() { return [...entities.keys()].map(toState); },
    /** Move simulated time forward by `ms` (and the clock with it, unless `now` is a function). */
    advance(ms) { run(ms, !nowFn); },
    call(domain, service, data = {}) {
      try {
        if (connection !== 'live') throw new Error('Not connected');
        const ids = [].concat((data && data.entity_id) || []);
        if (!ids.length) throw new Error(`Simulator: ${domain}.${service} needs an entity_id`);
        for (const id of ids) applyService(domain, service, id, data);
        return Promise.resolve();
      } catch (err) {
        return Promise.reject(err);
      }
    },
  };
  return source;

  // ---- building the starting state

  function build() {
    if (scenario === 'empty') return;                     // a new house on day one
    const tables = options.scenarios || {};
    let patch = tables[scenario];
    if (patch == null && scenario === 'offline') patch = tables.evening;
    if (typeof patch === 'function') patch = patch();
    patch = patch || {};
    for (const entityId of Object.keys(patch)) {
      if (!roleOf.has(entityId)) problems.push(`scenario "${scenario}" names ${entityId}, which is not in the bindings`);
    }
    if (problems.length) console.warn(`Simulator: ${problems.length} scenario entr${problems.length === 1 ? 'y is' : 'ies are'} ignored:\n  ${problems.join('\n  ')}`);
    const now = clock();
    for (const { entityId, role, thing, person } of bound) {
      const d = defaults(entityId, role, thing, person && peopleNames[person] ? peopleNames[person].name : null);
      const p = patch[entityId] || {};
      const state = p.state != null ? p.state : d.state;
      const attributes = p.clear ? { friendly_name: d.attributes.friendly_name } : { ...d.attributes, ...(p.attributes || {}) };
      // Deterministic spread: quiet things last changed some hours ago, and last reported within minutes.
      const h = hash(entityId);
      const changedAt = now - (p.ago != null ? p.ago * MIN : (90 + (h % 600)) * MIN);
      // A device that has gone quiet was last heard from when it did so.
      const reportedAt = p.reportedAgo != null ? now - p.reportedAgo * MIN
        : p.silent ? changedAt
          : Math.max(changedAt, now - (1 + (h % 5)) * MIN - (h % 50) * 1000);
      entities.set(entityId, { state, attributes, changedAt, updatedAt: changedAt, reportedAt, silent: !!p.silent, memory: {} });
    }
  }

  function toState(entityId) {
    const e = entities.get(entityId);
    return {
      entity_id: entityId,
      state: e.state,
      attributes: { ...e.attributes },
      last_changed: new Date(e.changedAt).toISOString(),
      last_updated: new Date(e.updatedAt).toISOString(),
      last_reported: new Date(e.reportedAt).toISOString(),
      context: { id: `sim-${hash(entityId).toString(16)}`, parent_id: null, user_id: null },
    };
  }

  /** Change an entity and emit it. `state` undefined keeps the state; attributes merge (null deletes). */
  function set(entityId, state, attributes) {
    const e = entities.get(entityId);
    if (!e) return;
    const now = clock();
    if (state !== undefined && state !== e.state) { e.state = state; e.changedAt = now; }
    if (attributes) {
      for (const [k, v] of Object.entries(attributes)) {
        if (v == null) delete e.attributes[k]; else e.attributes[k] = v;
      }
    }
    e.updatedAt = now;
    e.reportedAt = now;
    emit(entityId);
  }

  function emit(entityId) {
    if (connection === 'live' && handlers && handlers.onChange) handlers.onChange(toState(entityId));
  }

  function setConnection(next) {
    if (connection === next) return;
    connection = next;
    if (handlers && handlers.onConnection) handlers.onConnection(next);
  }

  // ---- time

  function at(delay, fn) {
    schedule.push({ at: t + delay, fn });
  }

  function run(ms, moveClock) {
    let left = ms;
    while (left > 0) {
      const step = Math.min(left, 250);
      left -= step;
      t += step;
      if (moveClock) offset += step;
      if (connection !== 'live') continue;                // nothing is heard from a dropped link
      const due = schedule.filter((s) => s.at <= t);
      if (due.length) {
        schedule = schedule.filter((s) => s.at > t);
        for (const s of due.sort((a, b) => a.at - b.at)) s.fn();
      }
      stepMotions();
      heartbeat();
    }
  }

  /** Sensors report on a schedule even when nothing changes; without this a long demo would go stale. */
  function heartbeat() {
    const now = clock();
    if (now - lastHeartbeat < HEARTBEAT_MS) return;
    lastHeartbeat = now;
    for (const [entityId, e] of entities) {
      if (e.silent) continue;
      e.reportedAt = now;
      emit(entityId);
    }
  }

  // ---- covers move in steps, the way a real opener reports

  function moveCover(entityId, target) {
    const e = entities.get(entityId);
    if (!e) return;
    const position = Number(e.attributes.current_position) || 0;
    if (position === target) { motions.delete(entityId); return; }
    motions.set(entityId, { target, pos: position, nextAt: t + STEP_MS });
    set(entityId, target > position ? 'opening' : 'closing');
  }

  function stepMotions() {
    for (const [entityId, m] of [...motions]) {
      if (t < m.nextAt) continue;
      m.nextAt += STEP_MS;
      const e = entities.get(entityId);
      const info = roleOf.get(entityId);
      const travel = info && info.thing.kind === 'door' ? GARAGE_TRAVEL_MS : BLIND_TRAVEL_MS;
      const stepSize = 100 / (travel / STEP_MS);
      const dir = m.target > m.pos ? 1 : -1;
      m.pos += dir * stepSize;
      if ((dir > 0 && m.pos >= m.target - 0.01) || (dir < 0 && m.pos <= m.target + 0.01)) m.pos = m.target;
      const next = Math.round(m.pos);
      if (next === m.target) {
        motions.delete(entityId);
        set(entityId, next === 0 ? 'closed' : 'open', { current_position: next });
      } else {
        set(entityId, undefined, { current_position: next });
      }
    }
  }

  // ---- service calls

  function applyService(domain, service, entityId, data) {
    const e = entities.get(entityId);
    if (!e) throw new Error(`Simulator: no such entity "${entityId}"`);
    if (e.state === 'unavailable') throw new Error(`${entityId} is unavailable`);
    const kind = entityId.split('.')[0];
    if ((kind === 'light' || kind === 'switch') && (domain === kind || domain === 'homeassistant')) {
      const on = service === 'turn_on' ? true : service === 'turn_off' ? false : service === 'toggle' ? e.state !== 'on' : null;
      if (on == null) throw unsupported(domain, service);
      if (on) switchOn(entityId, data); else switchOff(entityId);
      return;
    }
    if (kind === 'lock' && domain === 'lock') {
      if (service === 'lock') set(entityId, 'locked');
      else if (service === 'unlock') set(entityId, 'unlocked');
      else throw unsupported(domain, service);
      return;
    }
    if (kind === 'cover' && domain === 'cover') {
      const position = Number(e.attributes.current_position) || 0;
      if (service === 'open_cover') moveCover(entityId, 100);
      else if (service === 'close_cover') moveCover(entityId, 0);
      else if (service === 'toggle') moveCover(entityId, position > 0 ? 0 : 100);
      else if (service === 'set_cover_position') moveCover(entityId, Math.min(100, Math.max(0, Math.round(Number(data.position) || 0))));
      else if (service === 'stop_cover') { motions.delete(entityId); set(entityId, position === 0 ? 'closed' : 'open'); }
      else throw unsupported(domain, service);
      return;
    }
    throw unsupported(domain, service);
  }

  function unsupported(domain, service) {
    return new Error(`Simulator: ${domain}.${service} is not supported for that entity`);
  }

  function switchOn(entityId, data = {}) {
    const e = entities.get(entityId);
    const attrs = {};
    if (entityId.startsWith('light.') && e.attributes.color_mode !== 'onoff') {
      let brightness = data.brightness != null ? Number(data.brightness)
        : data.brightness_pct != null ? Math.round(Number(data.brightness_pct) * 2.55)
          : e.attributes.brightness != null ? e.attributes.brightness : (e.memory.brightness || 204);
      brightness = Math.min(255, Math.max(1, Math.round(brightness)));
      attrs.brightness = brightness;
      attrs.color_temp_kelvin = data.color_temp_kelvin != null ? Number(data.color_temp_kelvin)
        : (e.attributes.color_temp_kelvin || e.memory.kelvin || 2700);
      attrs.color_mode = 'color_temp';
    }
    set(entityId, 'on', attrs);
  }

  function switchOff(entityId) {
    const e = entities.get(entityId);
    if (e.attributes.brightness != null) e.memory.brightness = e.attributes.brightness;
    if (e.attributes.color_temp_kelvin != null) e.memory.kelvin = e.attributes.color_temp_kelvin;
    // Home Assistant drops brightness and colour from a light that is off.
    set(entityId, 'off', { brightness: null, color_temp_kelvin: null });
  }

  // ---- the script: small plausible things on a loop so the demo feels alive

  function idsFor(role, test) {
    return bound.filter((b) => b.role === role && entities.has(b.entityId) && (!test || test(b))).map((b) => b.entityId);
  }
  function usable(entityId) { const e = entities.get(entityId); return !!e && !e.silent && e.state !== 'unavailable' && e.state !== 'unknown'; }
  function entityOf(thingId, role) { const b = bound.find((x) => x.thing.id === thingId && x.role === role); return b && entities.has(b.entityId) ? b.entityId : null; }

  function startScript() {
    at(between(4000, 7000), scriptLoop);
    const garage = bound.find((b) => b.role === 'cover' && b.thing.kind === 'door');
    if (garage) at(25000, () => garageCycle(garage.entityId));
    if (idsFor('progress').length) at(10000, printLoop);
    // Only what this house can do: a house with no cameras spends no turns on camera events.
    const has = (role, kind) => bound.some((b) => b.role === role && (!kind || b.thing.kind === kind) && entities.has(b.entityId));
    events = [
      [30, lightEvent, has('light')],
      [14, driftEvent, has('temperature') || has('outdoor_temperature')],
      [10, occupancyEvent, has('occupancy')],
      [10, blindEvent, has('cover', 'window')],
      [8, backDoorEvent, !!entityOf('back_door', 'contact')],
      [14, personEvent, has('phone_room')],
      [10, cameraEvent, has('motion', 'camera') || has('person_detected', 'camera')],
      [8, roomMotionEvent, has('motion', 'room')],
    ].filter((e) => e[2]);
  }

  function scriptLoop() {
    const total = events.reduce((sum, e) => sum + e[0], 0);
    let roll = random() * total;
    for (const [weight, fn] of events) {
      if (roll < weight) { fn(); break; }
      roll -= weight;
    }
    at(between(5000, 10000), scriptLoop);
  }

  /** Someone who is home walks to another room: their phone's room reading follows, and so does motion. */
  function personEvent() {
    const phones = bound.filter((b) => b.role === 'phone_room' && usable(b.entityId) && isHome(b.person));
    if (!phones.length) return;
    const phone = pick(phones);
    const here = entities.get(phone.entityId).state;
    const areas = areaNames().filter((a) => a.name !== here);
    if (!areas.length) return;
    const next = pick(areas);
    set(phone.entityId, next.name);
    const motion = entityOf(next.room, 'motion');
    if (motion && usable(motion)) blip(motion, between(5000, 9000));
  }

  function isHome(personId) {
    const p = bound.find((b) => b.role === 'person' && b.person === personId);
    return !p || !entities.has(p.entityId) || entities.get(p.entityId).state === 'home';
  }

  /** What a room-presence integration would report: the hub's area names for indoor rooms, else room names. */
  function areaNames() {
    const outdoor = new Set((plan.rooms || []).filter((r) => r.outdoor).map((r) => r.id));
    const fromAreas = Object.entries((bindings && bindings.areas) || {})
      .filter(([, roomId]) => plan.things[roomId] && !outdoor.has(roomId))
      .map(([name, room]) => ({ name, room }));
    if (fromAreas.length) return fromAreas;
    return Object.values(plan.things).filter((t) => t.kind === 'room' && !outdoor.has(t.id)).map((t) => ({ name: t.name || t.id, room: t.id }));
  }

  /** Turn a momentary sensor on now and off again after `ms`. */
  function blip(entityId, ms, after) {
    if (entities.get(entityId).state === 'on') return;
    set(entityId, 'on');
    at(ms, () => { set(entityId, 'off'); if (after) after(); });
  }

  /** Something crosses a camera's view; sometimes it is a person. The camera records while it lasts. */
  function cameraEvent() {
    const cameras = [...new Set(bound.filter((b) => b.thing.kind === 'camera').map((b) => b.thing.id))]
      .filter((id) => ['camera', 'motion', 'person_detected'].every((role) => { const e = entityOf(id, role); return !e || usable(e); }))
      .filter((id) => !inPrivacy(id));
    if (!cameras.length) return;
    const id = pick(cameras);
    const motion = entityOf(id, 'motion');
    const person = entityOf(id, 'person_detected');
    const cam = entityOf(id, 'camera');
    if ((motion && entities.get(motion).state === 'on') || (person && entities.get(person).state === 'on')) return;
    const ms = between(6000, 12000);
    const withPerson = person && (!motion || random() < 0.4);
    if (cam && entities.get(cam).state === 'idle') { set(cam, 'recording'); at(ms + 2000, () => set(cam, 'idle')); }
    if (motion) blip(motion, ms);
    if (withPerson) blip(person, Math.max(3000, ms - 2000));
  }

  /** A camera whose lens is shut sees nothing. */
  function inPrivacy(thingId) {
    const cam = entityOf(thingId, 'camera');
    const e = cam && entities.get(cam);
    return !!e && (e.state === 'off' || e.attributes.privacy === true);
  }

  function roomMotionEvent() {
    const sensors = idsFor('motion', (b) => b.thing.kind === 'room').filter((id) => usable(id) && entities.get(id).state !== 'on');
    if (sensors.length) blip(pick(sensors), between(5000, 10000));
  }

  /** A running print moves on a percent every ten seconds, and finishes. */
  function printLoop() {
    for (const progress of idsFor('progress').filter(usable)) {
      const thingId = roleOf.get(progress).thing.id;
      const status = entityOf(thingId, 'power');
      if (status && entities.get(status).state !== 'printing') continue;
      const remaining = entityOf(thingId, 'remaining');
      const pct = Math.min(100, (parseFloat(entities.get(progress).state) || 0) + 1);
      set(progress, String(pct));
      if (remaining && usable(remaining)) {
        const left = parseFloat(entities.get(remaining).state) || 0;
        set(remaining, String(pct >= 100 ? 0 : Math.max(1, Math.round(left * (100 - pct) / (101 - pct)))));
      }
      if (pct >= 100 && status) set(status, 'finished');
    }
    at(10000, printLoop);
  }

  function driftLoop() {
    driftEvent();
    at(between(20000, 40000), driftLoop);
  }

  function garageCycle(entityId) {
    const e = entities.get(entityId);
    if (!usable(entityId) || motions.has(entityId)) { at(60000, () => garageCycle(entityId)); return; }
    if (e.state === 'closed') {
      moveCover(entityId, 100);
      at(90000, () => garageCycle(entityId));              // open for a minute and a half, then closes again
    } else {
      moveCover(entityId, 0);
      at(240000, () => garageCycle(entityId));             // reopens much later
    }
  }

  function lightEvent() {
    const outdoor = new Set((plan.rooms || []).filter((r) => r.outdoor).map((r) => r.id));
    const lights = idsFor('light', (b) => !outdoor.has(b.thing.room)).filter(usable);
    if (!lights.length) return;
    const onCount = lights.filter((id) => entities.get(id).state === 'on').length;
    const id = pick(lights);
    const e = entities.get(id);
    if (e.state === 'on') {
      const b = e.attributes.brightness;
      if (b != null && (random() < 0.6 || onCount <= 5)) {
        const pct = Math.min(100, Math.max(10, Math.round(b / 2.55 + pick([-20, -10, 10, 15, 20]))));
        set(id, undefined, { brightness: Math.round(pct * 2.55) });
      } else if (onCount > 5) switchOff(id);
    } else if (onCount < 11) {
      switchOn(id, e.memory.brightness ? {} : { brightness_pct: Math.round(between(30, 80)), color_temp_kelvin: pick([2700, 2700, 3000]) });
    }
  }

  function driftEvent() {
    const sensors = [...idsFor('temperature'), ...idsFor('outdoor_temperature')].filter(usable);
    if (!sensors.length) return;
    const id = pick(sensors);
    const e = entities.get(id);
    const value = parseFloat(e.state);
    if (!Number.isFinite(value)) return;
    const outdoorRole = roleOf.get(id).role === 'outdoor_temperature';
    const next = Math.min(outdoorRole ? 14 : 23, Math.max(outdoorRole ? 1 : 17, value + pick([-0.1, 0.1])));
    set(id, next.toFixed(1));
  }

  function occupancyEvent() {
    const sensors = idsFor('occupancy').filter(usable);
    if (!sensors.length) return;
    const occupied = sensors.filter((id) => entities.get(id).state === 'on');
    const id = pick(sensors);
    const isOn = entities.get(id).state === 'on';
    if (isOn && occupied.length > 1) set(id, 'off');
    else if (!isOn && occupied.length < 3) set(id, 'on');
  }

  function blindEvent() {
    const blinds = idsFor('cover', (b) => b.thing.kind === 'window').filter((id) => usable(id) && !motions.has(id));
    if (!blinds.length) return;
    const id = pick(blinds);
    const position = Number(entities.get(id).attributes.current_position) || 0;
    moveCover(id, pick([0, 30, 50, 100].filter((p) => p !== position)));
  }

  function backDoorEvent() {
    const contact = entityOf('back_door', 'contact');
    const lock = entityOf('back_door', 'lock');
    if (!contact || !usable(contact) || entities.get(contact).state === 'on') return;
    if (lock && entities.get(lock).state !== 'unlocked') return;     // a locked door does not open by itself
    set(contact, 'on');
    at(between(8000, 15000), () => set(contact, 'off'));
  }
}

// ---------------------------------------------------------------------------------------------

function defaults(entityId, role, thing, personName) {
  const domain = entityId.split('.')[0];
  const name = thing.name || thing.id;
  const who = personName || 'Phone';
  if (thing.kind === 'camera') {
    // The picture a real hub would serve from /api/camera_proxy/…; here a scheme the renderer draws itself.
    if (role === 'camera') return { state: 'idle', attributes: { friendly_name: name, supported_features: 2, entity_picture: `sim:${thing.id}` } };
    if (role === 'motion') return { state: 'off', attributes: { friendly_name: `${name} motion`, device_class: 'motion' } };
    if (role === 'person_detected') return { state: 'off', attributes: { friendly_name: `${name} person`, device_class: 'occupancy' } };
  }
  const mk = (state, attributes = {}, suffix = '') => ({ state, attributes: { friendly_name: suffix ? `${name} ${suffix}` : name, ...attributes } });
  switch (role) {
    case 'light': return mk('off', domain === 'light' ? { supported_color_modes: ['color_temp'] } : {});
    case 'contact': return mk('off', { device_class: thing.kind === 'window' ? 'window' : 'door' }, 'contact');
    case 'lock': return mk('locked', {}, 'lock');
    case 'cover':
      return thing.kind === 'door'
        ? mk('closed', { current_position: 0, device_class: 'garage' })
        : mk('open', { current_position: 100, device_class: 'blind' }, 'blind');
    case 'temperature': return mk('21.0', { unit_of_measurement: '°C', device_class: 'temperature', state_class: 'measurement' }, 'temperature');
    case 'humidity': return mk('48', { unit_of_measurement: '%', device_class: 'humidity', state_class: 'measurement' }, 'humidity');
    case 'occupancy': return mk('off', { device_class: 'occupancy' }, 'occupancy');
    case 'leak': return mk('off', { device_class: 'moisture' }, 'leak sensor');
    case 'smoke': return mk('off', { device_class: 'smoke' }, 'smoke alarm');
    case 'climate': return mk('heat', { hvac_action: 'idle', current_temperature: 21, temperature: 21, hvac_modes: ['off', 'heat', 'cool'], temperature_unit: '°C' }, 'thermostat');
    case 'motion': return mk('off', { device_class: 'motion' }, 'motion');
    case 'power':
      // A sensor named ..._power reads watts; any other sensor is a status word ('idle', 'printing', …).
      if (domain === 'sensor' && /_(power|watts)$/.test(entityId)) return mk('0', { unit_of_measurement: 'W', device_class: 'power', state_class: 'measurement' }, 'power');
      if (domain === 'sensor') return mk('idle', {}, 'status');
      return mk('off');
    case 'progress': return mk('0', { unit_of_measurement: '%', state_class: 'measurement' }, 'progress');
    case 'remaining': return mk('0', { unit_of_measurement: 'min', device_class: 'duration' }, 'time remaining');
    case 'phone_battery': return { state: '80', attributes: { friendly_name: `${who} phone battery level`, unit_of_measurement: '%', device_class: 'battery' } };
    case 'phone_charging':
      return domain === 'binary_sensor'
        ? { state: 'off', attributes: { friendly_name: `${who} phone charging`, device_class: 'battery_charging' } }
        : { state: 'not_charging', attributes: { friendly_name: `${who} phone battery state` } };
    case 'phone_room': return { state: 'not_home', attributes: { friendly_name: `${who} phone room` } };
    case 'presence': return mk('on', { device_class: 'presence' }, 'presence');
    case 'charging': return mk('off', { device_class: 'battery_charging' }, 'charging');
    case 'person': {
      const id = entityId.split('.').slice(1).join('.');
      return { state: 'home', attributes: { friendly_name: personName || id.charAt(0).toUpperCase() + id.slice(1).replace(/_/g, ' ') } };
    }
    case 'alarm': return { state: 'disarmed', attributes: { friendly_name: 'Home alarm' } };
    case 'outdoor_temperature': return { state: '8.0', attributes: { friendly_name: 'Outdoor temperature', unit_of_measurement: '°C', device_class: 'temperature' } };
    default: return mk('unknown');
  }
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
