// derive: plan + bindings + entity states + connection + clock → Derived (docs/CONTRACTS.md §2).
// Pure. The renderer, the UI and the brain read only its output, so they cannot disagree.
//
// The honesty rules live here:
//   1 unsensed  no entity bound → no claim, 'No sensor', never in the attention list
//   2 unknown   entity reports unknown / unavailable, or never reported → no claim
//   3 stale     not heard from for longer than staleAfterHours[role] → no claim, last value only as a lastKnown fact
//   4 offline   connection down → every sensed thing is offline, no claims, nothing is lit
//   5 a thing takes the worst freshness of its roles; a claim survives only from a role that is itself fresh
//   6 attention list   7 headline

//
// Round 2 adds:
//   8 a person's room is a claim: only while home and the phone's room reading is fresh
//   9 cameras are a security role; a quiet camera is an unknown-severity item; never in unsensedExterior
//  10 motion / person detection are attention only while the alarm is armed
//  11 appliance phases: done → info, error or paused → attention; a running console or TV is never listed
//  12 phone battery under 15% and not charging → batteryLow on the person, never in the attention list
//
// Round 3 adds:
//  13 a camera's picture (`feed`) is a claim: only while the camera entity is fresh, not in privacy, and
//     carries a picture URL. Privacy (lens shut on purpose) is a healthy state: never an attention item.

import { formatTemp, formatPercent, formatRemaining } from './format.js';

const HOUR = 3600 * 1000;
const RANK = { fresh: 0, stale: 1, unknown: 2, offline: 3 };
const SEVERITY_RANK = { alert: 0, attention: 1, unknown: 2, info: 3 };
const LOW_BATTERY = 0.15;

/** Roles each thing kind accepts (the tables in the contract). */
export const ROLES_BY_KIND = {
  light: ['light'],
  door: ['contact', 'lock', 'cover'],
  window: ['contact', 'cover'],
  room: ['temperature', 'humidity', 'occupancy', 'motion', 'leak', 'smoke', 'climate'],
  object: ['power', 'progress', 'remaining', 'presence', 'charging'],
  camera: ['camera', 'motion', 'person_detected'],
  house: ['person', 'alarm', 'outdoor_temperature', 'phone_battery', 'phone_charging', 'phone_room'],
};

/** House roles that describe a person's phone. They need a `person` key and never touch the house thing. */
const PHONE_ROLES = new Set(['phone_battery', 'phone_charging', 'phone_room']);

/** A role whose silence matters for security (rules 6 and 9). Everything on a camera is one. */
function isSecurityRole(kind, role) {
  if (kind === 'camera') return true;
  if (role === 'contact' || role === 'lock' || role === 'leak' || role === 'smoke') return true;
  return role === 'cover' && kind === 'door';
}

/**
 * Problems with a bindings file against a plan: unknown things, roles that do not fit the thing's kind.
 * @returns {string[]} empty when sound
 */
export function checkBindings(plan, bindings) {
  const problems = [];
  const things = (plan && plan.things) || {};
  const entities = (bindings && bindings.entities) || {};
  for (const [entityId, b] of Object.entries(entities)) {
    const ref = b && things[b.thing];
    if (!ref) { problems.push(`${entityId}: thing "${b && b.thing}" is not in the plan`); continue; }
    const roles = ROLES_BY_KIND[ref.kind] || [];
    if (!roles.includes(b.role)) { problems.push(`${entityId}: role "${b.role}" is not valid for a ${ref.kind} (${b.thing})`); continue; }
    if (PHONE_ROLES.has(b.role) && !b.person) problems.push(`${entityId}: role "${b.role}" needs a "person" key`);
  }
  for (const [area, roomId] of Object.entries((bindings && bindings.areas) || {})) {
    const ref = things[roomId];
    if (!ref || ref.kind !== 'room') problems.push(`areas: "${area}" points at "${roomId}", which is not a room in the plan`);
  }
  return problems;
}

const normalName = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const NO_ROOM = new Set(['', 'not_home', 'unknown', 'unavailable', 'none', 'away']);

/**
 * A `phone_room` state → room: through bindings.areas, then room id, then room name, case-insensitively
 * (and last, ignoring punctuation: 'game_room' finds 'Game room'). Anything else is no room.
 * @returns {(state:any) => {id:string, name:string, level:string|null}|null}
 */
function roomResolver(plan, bindings) {
  const rooms = Object.values(plan.things).filter((t) => t.kind === 'room');
  const byId = new Map(rooms.map((r) => [r.id.toLowerCase(), r]));
  const byName = new Map();
  const loose = new Map();
  for (const r of rooms) {
    const name = String(r.name || r.id).toLowerCase();
    if (!byName.has(name)) byName.set(name, r);
    for (const key of [normalName(r.id), normalName(r.name)]) if (key && !loose.has(key)) loose.set(key, r);
  }
  const byArea = new Map();
  for (const [area, roomId] of Object.entries((bindings && bindings.areas) || {})) {
    const r = plan.things[roomId];
    if (r && r.kind === 'room') byArea.set(String(area).trim().toLowerCase(), r);
  }
  return (state) => {
    const key = String(state == null ? '' : state).trim().toLowerCase();
    if (NO_ROOM.has(key)) return null;
    const r = byArea.get(key) || byId.get(key) || byName.get(key) || loose.get(normalName(key)) || null;
    return r ? { id: r.id, name: r.name || r.id, level: r.level == null ? null : r.level } : null;
  };
}

/**
 * Precompute the binding index once.
 * @returns {((states:any, connection:string, now:number, snapshotAt?:number|null) => object) & { problems: string[] }}
 */
export function createDeriver(plan, bindings) {
  if (!plan || !plan.things) throw new Error('derive: the plan has no things index');
  const things = plan.things;
  const order = Object.keys(things);
  const staleAfter = (bindings && bindings.staleAfterHours) || {};
  const problems = checkBindings(plan, bindings);
  if (problems.length) console.warn(`bindings.json has ${problems.length} problem(s); those entities are ignored:\n  ${problems.join('\n  ')}`);

  /** thing id → role → entity ids */
  const byThing = new Map();
  const securityEntities = [];
  const securityPresent = (ctx) => (ctx.connection === 'live' ? securityEntities.some((id) => ctx.get(id)) : securityEntities.length > 0);
  /** People, in the order of bindings.people, then anyone only named by an entity. */
  const peopleDefs = new Map();
  const personDef = (id, name, declared) => {
    if (!peopleDefs.has(id)) peopleDefs.set(id, { id, name: name || null, declared, roles: {} });
    return peopleDefs.get(id);
  };
  for (const [id, p] of Object.entries((bindings && bindings.people) || {})) personDef(id, (p && p.name) || words(id), true);
  /** person entity id → the name bindings.people gives that person */
  const personNames = new Map();

  for (const [entityId, b] of Object.entries((bindings && bindings.entities) || {})) {
    const ref = b && things[b.thing];
    if (!ref || !(ROLES_BY_KIND[ref.kind] || []).includes(b.role)) continue;
    if (PHONE_ROLES.has(b.role)) {
      // A phone's readings belong to its person, not to the house thing.
      if (b.person) { const def = personDef(b.person, words(b.person), true); if (!def.roles[b.role]) def.roles[b.role] = entityId; }
      continue;
    }
    if (b.role === 'person') {
      const def = b.person
        ? personDef(b.person, words(b.person), true)
        : personDef(entityId.split('.').slice(1).join('.'), null, false);
      if (!def.roles.person) def.roles.person = entityId;
      if (def.name) personNames.set(entityId, def.name);
    }
    if (!byThing.has(ref.id)) byThing.set(ref.id, {});
    const roles = byThing.get(ref.id);
    (roles[b.role] = roles[b.role] || []).push(entityId);
    if (isSecurityRole(ref.kind, b.role)) securityEntities.push(entityId);
  }
  const resolveRoom = roomResolver(plan, bindings);
  const objectTypes = new Map((plan.objects || []).map((o) => [o.id, o.type]));
  /** camera id → is it inside the house? From the plan fixture; a plan without fixtures falls back to the room. */
  const cameraIndoor = new Map();
  {
    const outdoor = new Set((plan.rooms || []).filter((r) => r.outdoor).map((r) => r.id));
    const fixtures = new Map((plan.fixtures || []).map((f) => [f.id, f]));
    for (const t of Object.values(things)) {
      if (t.kind !== 'camera') continue;
      const f = fixtures.get(t.id);
      cameraIndoor.set(t.id, f && typeof f.indoor === 'boolean' ? f.indoor
        : typeof t.indoor === 'boolean' ? t.indoor
          : f && f.mount ? f.mount !== 'exterior'
            : !!t.room && (plan.rooms || []).some((r) => r.id === t.room) && !outdoor.has(t.room));
    }
  }

  const lightsByRoom = new Map();
  for (const id of order) {
    const ref = things[id];
    if (ref.kind !== 'light' || !ref.room) continue;
    if (!lightsByRoom.has(ref.room)) lightsByRoom.set(ref.room, []);
    lightsByRoom.get(ref.room).push(id);
  }
  const outdoorRooms = new Set((plan.rooms || []).filter((r) => r.outdoor).map((r) => r.id));

  function deriver(states, connection, now, snapshotAt = null) {
    if (connection !== 'live' && connection !== 'offline' && connection !== 'connecting') {
      throw new Error(`derive: unknown connection status "${connection}"`);
    }
    if (typeof now !== 'number' || !Number.isFinite(now)) throw new Error('derive: now must be epoch milliseconds');
    const get = stateGetter(states);
    const ctx = { get, connection, now, staleAfter, personNames, armed: null, typeOf: (id) => objectTypes.get(id) || null, indoorOf: (id) => cameraIndoor.get(id) === true };
    // Rule 10 needs the alarm before anything else is read: 'away' | 'home' | null (disarmed or not known).
    const houseRoles = presentRoles(byThing.get('house'), ctx);
    if (houseRoles && houseRoles.alarm) {
      const a = readRole(houseRoles.alarm[0], 'alarm', ctx);
      if (a.fresh) ctx.armed = ARMED_AWAY.has(a.st.state) ? 'away' : ARMED_HOME.has(a.st.state) ? 'home' : null;
    }
    const out = {};
    const issues = [];

    // Lights first: rooms need them for `lit`.
    for (const id of order) if (things[id].kind === 'light') out[id] = deriveThing(things[id], byThing.get(id), ctx, issues, null);
    for (const id of order) {
      const ref = things[id];
      if (ref.kind === 'light') continue;
      let lit = null;
      if (ref.kind === 'room') {
        lit = 0;
        for (const lightId of lightsByRoom.get(id) || []) {
          const l = out[lightId];
          if (l.freshness === 'fresh' && l.on === true) lit = Math.max(lit, l.level == null ? 1 : l.level);
        }
      }
      out[id] = deriveThing(ref, byThing.get(id), ctx, issues, lit);
      if (ref.kind === 'room') {
        const row = lightsFact((lightsByRoom.get(id) || []).map((lightId) => out[lightId]));
        if (row) out[id].facts.push(row);
      }
    }
    const ordered = {};
    for (const id of order) ordered[id] = out[id];

    // Rule 6. Nothing is claimed while offline or still connecting, so nothing is listed either.
    const attention = connection === 'live'
      ? issues
        .map((it) => ({ ...it, order: order.indexOf(it.id) }))
        .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
          || (a.since == null ? Infinity : a.since) - (b.since == null ? Infinity : b.since)
          || a.order - b.order)
        .map(({ order: _o, ...it }) => it)
      : [];

    const people = [];
    for (const def of peopleDefs.values()) {
      const person = derivePerson(def, ctx, resolveRoom);
      if (person) people.push(person);
    }

    return {
      now, connection, snapshotAt: snapshotAt == null ? null : snapshotAt,
      things: ordered, attention, people,
      summary: summarise(ordered, attention, connection, securityPresent(ctx), byThing, ctx, outdoorRooms, people),
    };
  }
  deriver.problems = problems;
  return deriver;
}

/** A room's 'Lights' row: '3 on: Kitchen light 90%, …', 'All off', '1 on, 1 no data'. Levels only for fresh lights. */
function lightsFact(lights) {
  const sensed = lights.filter((l) => l.freshness !== 'unsensed');
  if (!sensed.length) return null;
  const on = sensed.filter((l) => l.freshness === 'fresh' && l.on === true);
  const off = sensed.filter((l) => l.freshness === 'fresh' && l.on === false);
  const quiet = sensed.length - on.length - off.length;
  let value;
  if (!on.length && !quiet) value = 'All off';
  else {
    const parts = [];
    if (on.length) parts.push(`${on.length} on`);
    else if (off.length) parts.push(`${off.length} off`);
    if (quiet) parts.push(`${quiet} no data`);
    value = parts.join(', ');
    if (on.length) value += `: ${on.map((l) => (l.brightness == null ? l.name : `${l.name} ${formatPercent(l.brightness)}`)).join(', ')}`;
  }
  return { label: 'Lights', value, at: null };
}

/** Exterior doors and windows with no security sensor: a door needs a contact, lock or cover; a window a contact. */
function unsensedExterior(things, byThing, ctx) {
  const ids = [];
  for (const t of Object.values(things)) {
    if ((t.kind !== 'door' && t.kind !== 'window') || !t.exterior) continue;
    const bound = presentRoles(byThing.get(t.id), ctx) || {};
    const sensed = t.kind === 'door' ? (bound.contact || bound.lock || bound.cover) : bound.contact;
    if (!sensed) ids.push(t.id);
  }
  return ids;
}

const cache = new WeakMap();

/** derive(plan, bindings, states, connection, now[, snapshotAt]) → Derived */
export function derive(plan, bindings, states, connection, now, snapshotAt = null) {
  let perPlan = cache.get(plan);
  if (!perPlan) { perPlan = new WeakMap(); cache.set(plan, perPlan); }
  const key = bindings && typeof bindings === 'object' ? bindings : EMPTY_BINDINGS;
  let deriver = perPlan.get(key);
  if (!deriver) { deriver = createDeriver(plan, key); perPlan.set(key, deriver); }
  return deriver(states, connection, now, snapshotAt);
}
const EMPTY_BINDINGS = { entities: {} };

// ---------------------------------------------------------------------------------------------

function stateGetter(states) {
  if (!states) return () => undefined;
  if (Array.isArray(states)) {
    const map = new Map();
    for (const s of states) if (s && s.entity_id) map.set(s.entity_id, s);
    return (id) => map.get(id);
  }
  if (states instanceof Map) return (id) => states.get(id);
  return (id) => states[id];
}

function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function num(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

const clamp01 = (n) => Math.min(1, Math.max(0, n));
const capital = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
const words = (s) => capital(String(s).replace(/_/g, ' '));

/** One bound entity read against the clock: is what it says still a claim? */
function readRole(entityId, role, ctx) {
  const st = ctx.get(entityId) || null;
  const changedAt = st ? toMs(st.last_changed) : null;
  const reportedAt = st ? toMs(st.last_reported != null ? st.last_reported : st.last_updated) : null;
  const unavailable = !!st && st.state === 'unavailable';
  const hasValue = !!st && st.state != null && st.state !== 'unknown' && st.state !== 'unavailable';
  let freshness = 'fresh';
  let label = '';
  let pending = false;
  if (!st) {
    freshness = 'unknown'; label = 'No data';
    pending = ctx.connection === 'connecting';
  } else if (unavailable) {
    freshness = 'unknown'; label = 'Offline';
  } else if (!hasValue) {
    freshness = 'unknown'; label = 'No data';
  } else {
    const hours = ctx.staleAfter[role];
    if (typeof hours === 'number' && reportedAt != null && ctx.now - reportedAt > hours * HOUR) {
      freshness = 'stale'; label = 'No data';
    }
  }
  if (ctx.connection === 'offline') { freshness = 'offline'; label = 'Not connected'; pending = false; }
  // Why it is not fresh, for the glyph: the device or the link is unreachable, it went quiet, or it has no value.
  const reason = freshness === 'fresh' ? null
    : freshness === 'offline' || unavailable ? 'offline'
      : freshness === 'stale' ? 'stale' : 'no-data';
  return { reason, role, entityId, st, attrs: (st && st.attributes) || {}, freshness, fresh: freshness === 'fresh', label, pending, changedAt, reportedAt, unavailable, hasValue };
}

function worstOf(list) {
  let worst = null;
  for (const r of list) {
    if (!worst) { worst = r; continue; }
    const d = RANK[r.freshness] - RANK[worst.freshness];
    if (d > 0) worst = r;
    else if (d === 0) {
      // Same freshness: the one heard from longest ago (never heard from is oldest).
      const a = r.reportedAt == null ? -Infinity : r.reportedAt;
      const b = worst.reportedAt == null ? -Infinity : worst.reportedAt;
      if (a < b) worst = r;
    }
  }
  return worst;
}

/** A detail-card row for one role. `value` is the human reading of the entity's current state string. */
function fact(label, r, value, at) {
  // `at`: when this value began (last_changed). `checkedAt`: when the entity was last heard from.
  if (r.fresh) return { label, value, at: at === undefined ? r.changedAt : at, checkedAt: r.reportedAt };
  if ((r.freshness === 'stale' || r.freshness === 'offline') && r.hasValue) {
    return { label, value, at: r.changedAt, checkedAt: r.reportedAt, lastKnown: true };
  }
  return { label, value: r.label, at: r.changedAt, checkedAt: r.reportedAt, unknown: true };
}

function unknownIssue(ref, r, subject) {
  return {
    id: ref.id, severity: 'unknown', reason: r.reason,
    text: `${subject}: ${r.unavailable && r.freshness === 'unknown' ? 'offline' : 'no data'}`,
    since: r.reportedAt, level: ref.level == null ? null : ref.level, room: roomOf(ref),
  };
}

function claimIssue(ref, severity, text, since) {
  return { id: ref.id, severity, text, since: since == null ? null : since, level: ref.level == null ? null : ref.level, room: roomOf(ref) };
}

const roomOf = (ref) => (ref.kind === 'room' ? ref.id : (ref.room == null ? null : ref.room));

// ---------------------------------------------------------------------------------------------

function deriveThing(ref, bound, ctx, issues, lit) {
  const base = {
    id: ref.id, kind: ref.kind, name: ref.name || ref.id,
    level: ref.level == null ? null : ref.level, room: ref.room == null ? null : ref.room,
    // The contract uses `level` twice: the storey id (all things) and a light's brightness 0..1. For a
    // light, `level` is the brightness as the contract's light row says; `levelId` is always the storey.
    levelId: ref.level == null ? null : ref.level,
  };
  const extra = emptyClaims(ref, lit, ctx);

  bound = presentRoles(bound, ctx);
  if (!bound) {
    // Rule 1.
    return {
      ...base, freshness: 'unsensed', reason: null, status: 'none', text: 'No sensor', since: null, reportedAt: null,
      facts: [{ label: 'Sensors', value: 'None installed', at: null }], actions: [], ...extra,
    };
  }

  /** role → readings (first is the one used for single-entity roles) */
  const R = {};
  const all = [];
  for (const role of Object.keys(bound)) {
    R[role] = bound[role].map((entityId) => readRole(entityId, role, ctx));
    all.push(...R[role]);
  }
  const first = (role) => (R[role] ? R[role][0] : null);

  const part = KIND[ref.kind](ref, first, R, ctx, lit);
  // part: { claims, word, since, status, urgent:{severity,text,since,word}|null, facts, actions, unknowns:[issue],
  //         info?:{text,since}   an 'info' item (listed, never counted),
  //         ignore?:reading[]    roles that do not matter for the claim right now (rule 5) }
  const counted = part.ignore && part.ignore.length ? all.filter((r) => !part.ignore.includes(r)) : all;
  const worst = worstOf(counted.length ? counted : all);
  const freshness = worst.freshness;

  let status;
  let text;
  let since;
  if (part.urgent) {
    // A claim from a role that is itself fresh stands, even when a sibling role has gone quiet.
    status = part.urgent.severity;
    text = part.urgent.word;
    since = part.urgent.since == null ? null : part.urgent.since;
  } else if (freshness !== 'fresh') {
    status = 'unknown'; text = worst.label; since = null;
    if (counted.every((r) => r.fresh || r.pending)) { status = 'none'; text = ''; }   // still connecting: no marker yet
  } else {
    status = part.status; text = part.word || ''; since = part.since == null ? null : part.since;
  }

  if (part.urgent) issues.push(claimIssue(ref, part.urgent.severity, part.urgent.text, part.urgent.since));
  else if (part.unknowns.length) issues.push(part.unknowns[0]);
  else if (part.info) issues.push(claimIssue(ref, 'info', part.info.text, part.info.since));

  const live = ctx.connection === 'live' && freshness === 'fresh';
  return {
    ...base, freshness, reason: freshness === 'fresh' ? null : worst.reason, status, text, since, reportedAt: worst.reportedAt,
    facts: part.facts, actions: live ? part.actions : [],
    ...extra, ...part.claims,
  };
}

/**
 * While the hub is live, a bound entity the hub does not have at all is a sensor that is not installed
 * (rule 1), not one that has gone quiet (rule 2: that entity exists and says 'unknown' or 'unavailable').
 * While connecting or offline nothing can be told apart yet, so every binding counts.
 */
function presentRoles(bound, ctx) {
  if (!bound) return null;
  if (ctx.connection !== 'live') return bound;
  let out = null;
  for (const role of Object.keys(bound)) {
    const present = bound[role].filter((entityId) => ctx.get(entityId));
    if (present.length) (out = out || {})[role] = present;
  }
  return out;
}

function emptyClaims(ref, lit, ctx) {
  switch (ref.kind) {
    case 'light': return { on: null, level: null, brightness: null, colorTempK: null, rgb: null };
    case 'door': return { open: null, position: null, locked: null, moving: null, exterior: !!ref.exterior };
    case 'window': return { open: null, blind: null, exterior: !!ref.exterior };
    case 'room': return { temperature: null, humidity: null, occupied: null, motion: null, lastMotionAt: null, active: false, alert: null, hvac: null, lit: lit || 0 };
    case 'object': return { running: null, present: null, charging: null, phase: null, progress: null, remainingMin: null, title: null };
    case 'camera': return { motion: null, person: null, recording: null, lastMotionAt: null, lastPersonAt: null, feed: null, privacy: false, indoor: ctx.indoorOf(ref.id) };
    default: return {};
  }
}

const KIND = {
  light(ref, first) {
    const r = first('light');
    const claims = {};
    const facts = [];
    const actions = [];
    let word = '';
    let status = 'off';
    if (r.hasValue) {
      const on = r.st.state === 'on';
      const b = num(r.attrs.brightness);
      const level = on && b != null ? clamp01(b / 255) : null;
      word = on ? (level != null ? `On ${formatPercent(level)}` : 'On') : 'Off';
      facts.push(fact('Light', r, on ? 'On' : 'Off'));
      if (level != null) facts.push(fact('Brightness', r, formatPercent(level), r.fresh ? null : undefined));
      if (r.fresh) {
        const kelvin = num(r.attrs.color_temp_kelvin) || (num(r.attrs.color_temp) ? Math.round(1e6 / num(r.attrs.color_temp)) : null);
        const rgb = Array.isArray(r.attrs.rgb_color) && r.attrs.rgb_color.length === 3 ? r.attrs.rgb_color.map(Number) : null;
        claims.on = on;
        claims.level = level;
        claims.brightness = level;
        claims.colorTempK = on ? kelvin : null;
        claims.rgb = on ? rgb : null;
        status = on ? 'on' : 'off';
        if (on && kelvin) facts.push({ label: 'Colour temperature', value: `${kelvin} K`, at: null, checkedAt: r.reportedAt });
        const domain = r.entityId.split('.')[0] === 'switch' ? 'switch' : 'light';
        actions.push({ id: 'toggle', label: on ? 'Turn off' : 'Turn on', call: { domain, service: on ? 'turn_off' : 'turn_on', data: { entity_id: r.entityId } } });
      }
    } else {
      facts.push(fact('Light', r, ''));
    }
    return { claims, word, since: r.changedAt, status, urgent: null, facts, actions, unknowns: [] };
  },

  door(ref, first) {
    const c = first('contact');
    const l = first('lock');
    const v = first('cover');
    const exterior = !!ref.exterior;
    const name = ref.name || ref.id;
    const claims = {};
    const facts = [];
    const actions = [];
    const unknowns = [];
    let urgent = null;
    let word = '';
    let since = null;

    let coverWord = null;
    if (v) {
      const s = v.hasValue ? v.st.state : null;
      const p = num(v.attrs.current_position);
      const moving = s === 'opening' || s === 'closing' ? s : null;
      const position = p != null ? clamp01(p / 100) : (s === 'closed' ? 0 : s === 'open' ? 1 : null);
      const open = s != null && s !== 'closed';
      if (s != null) {
        coverWord = moving ? capital(moving) : open ? (position != null && position > 0 && position < 1 ? `Open ${formatPercent(position)}` : 'Open') : 'Closed';
      }
      facts.push(fact(c ? 'Door' : 'Position', v, coverWord || ''));
      if (v.fresh) {
        claims.open = open; claims.position = position; claims.moving = moving;
        if (open) urgent = { severity: 'attention', text: `${name} ${moving || 'open'}`, since: v.changedAt, word: coverWord };
        if (open) actions.push(coverAction('close', 'Close door', v.entityId));
        if (!open || (position != null && position < 1)) actions.push(coverAction('open', 'Open door', v.entityId));
        word = coverWord; since = v.changedAt;
      } else unknowns.push(unknownIssue(ref, v, name));
    }
    if (c) {
      const open = c.hasValue ? c.st.state === 'on' : null;
      facts.unshift(fact('Contact', c, open ? 'Open' : 'Closed'));
      if (c.fresh) {
        claims.open = open;
        if (claims.position == null) claims.position = open ? 1 : 0;
        if (!v || !v.fresh) { word = open ? 'Open' : 'Closed'; since = c.changedAt; }
        if (open && exterior && !urgent) urgent = { severity: 'attention', text: `${name} open`, since: c.changedAt, word: 'Open' };
      } else unknowns.unshift(unknownIssue(ref, c, name));
    }
    if (l) {
      const s = l.hasValue ? l.st.state : null;
      facts.push(fact('Lock', l, s ? words(s) : ''));
      if (l.fresh) {
        const locked = s === 'locked' ? true : s === 'jammed' ? null : false;
        claims.locked = locked;
        if (claims.open !== true) { word = words(s); since = l.changedAt; }
        if (exterior && !urgent) {
          if (s === 'jammed') urgent = { severity: 'attention', text: `${name} lock jammed`, since: l.changedAt, word: 'Jammed' };
          else if (locked === false) urgent = { severity: 'attention', text: `${name} ${s === 'locking' || s === 'unlocking' ? s : 'unlocked'}`, since: l.changedAt, word: words(s) };
        }
        if (locked === true) actions.push({ id: 'unlock', label: 'Unlock', call: { domain: 'lock', service: 'unlock', data: { entity_id: l.entityId } } });
        else actions.push({ id: 'lock', label: 'Lock', call: { domain: 'lock', service: 'lock', data: { entity_id: l.entityId } } });
      } else unknowns.push(unknownIssue(ref, l, `${name} lock`));
    }
    const status = claims.locked === true && claims.open !== true ? 'secure' : 'off';
    return { claims, word, since, status, urgent, facts, actions, unknowns };
  },

  window(ref, first) {
    const c = first('contact');
    const v = first('cover');
    const exterior = !!ref.exterior;
    const name = ref.name || ref.id;
    const claims = {};
    const facts = [];
    const actions = [];
    const unknowns = [];
    let urgent = null;
    let word = '';
    let since = null;
    if (c) {
      const open = c.hasValue ? c.st.state === 'on' : null;
      facts.push(fact('Contact', c, open ? 'Open' : 'Closed'));
      if (c.fresh) {
        claims.open = open; word = open ? 'Open' : 'Closed'; since = c.changedAt;
        if (open && exterior) urgent = { severity: 'attention', text: `${name} open`, since: c.changedAt, word: 'Open' };
      } else unknowns.push(unknownIssue(ref, c, name));
    }
    if (v) {
      const s = v.hasValue ? v.st.state : null;
      const p = num(v.attrs.current_position);
      const blind = p != null ? clamp01(p / 100) : (s === 'closed' ? 0 : s === 'open' ? 1 : null);
      const blindWord = s == null ? '' : s === 'opening' ? 'Raising' : s === 'closing' ? 'Lowering'
        : blind == null ? words(s) : blind >= 1 ? 'Raised' : blind <= 0 ? 'Lowered' : `${formatPercent(blind)} raised`;
      facts.push(fact('Blind', v, blindWord));
      if (v.fresh) {
        claims.blind = blind;
        if (!c) { word = `Blind ${blindWord.toLowerCase()}`; since = v.changedAt; }
        if (blind == null || blind > 0) actions.push(coverAction('close_blind', 'Close blind', v.entityId));
        if (blind == null || blind < 1) actions.push(coverAction('open_blind', 'Open blind', v.entityId));
      }
    }
    return { claims, word, since, status: 'off', urgent, facts, actions, unknowns };
  },

  room(ref, first, R, ctx, lit) {
    const name = ref.name || ref.id;
    const t = first('temperature');
    const h = first('humidity');
    const o = first('occupancy');
    const k = first('leak');
    const m = first('smoke');
    const cl = first('climate');
    const claims = { lit: lit || 0 };
    const facts = [];
    const unknowns = [];
    let urgent = null;
    let word = '';

    for (const [r, kind] of [[m, 'smoke'], [k, 'leak']]) {
      if (!r) continue;
      const detected = r.hasValue && r.st.state === 'on';
      if (r.fresh) {
        if (detected && !urgent) {
          claims.alert = kind;
          urgent = { severity: 'alert', text: `${capital(kind)} in ${name}`, since: r.changedAt, word: `${capital(kind)} detected` };
        }
      } else unknowns.push(unknownIssue(ref, r, `${name} ${kind} sensor`));
    }
    let unit = '°C';
    if (t) {
      const value = t.hasValue ? num(t.st.state) : null;
      unit = t.attrs.unit_of_measurement || unit;
      if (t.hasValue && value == null) facts.push({ label: 'Temperature', value: 'No data', at: t.changedAt, checkedAt: t.reportedAt, unknown: true });
      else facts.push(fact('Temperature', t, formatTemp(value, unit)));
      if (t.fresh && value != null) claims.temperature = value;
    }
    if (cl) {
      const mode = cl.hasValue ? cl.st.state : null;
      const action = cl.attrs.hvac_action;
      const target = num(cl.attrs.temperature);
      const cUnit = cl.attrs.temperature_unit || unit;
      const to = target != null ? ` to ${formatTemp(target, cUnit)}` : '';
      const hvac = action === 'heating' || action === 'preheating' ? 'heating' : action === 'cooling' ? 'cooling'
        : action === 'idle' || action === 'fan' || action === 'drying' || action === 'defrosting' ? 'idle' : null;
      const said = mode === 'off' ? 'Off' : hvac === 'heating' ? `Heating${to}` : hvac === 'cooling' ? `Cooling${to}`
        : target != null ? `Idle, set${to}` : words(mode || '');
      facts.push(fact('Thermostat', cl, said));
      if (cl.fresh) {
        claims.hvac = mode === 'off' ? null : hvac;
        const current = num(cl.attrs.current_temperature);
        if (claims.temperature == null && current != null) {
          claims.temperature = current;
          if (!t) { unit = cUnit; facts.unshift({ label: 'Temperature', value: formatTemp(current, cUnit), at: cl.changedAt, checkedAt: cl.reportedAt }); }
        }
      }
    }
    if (h) {
      const value = h.hasValue ? num(h.st.state) : null;
      facts.push(fact('Humidity', h, value == null ? '' : `${Math.round(value)}%`));
      if (h.fresh && value != null) claims.humidity = value;
    }
    if (o) {
      const occupied = o.hasValue ? o.st.state === 'on' : null;
      facts.push(fact('Occupancy', o, occupied ? 'Occupied' : 'Clear'));
      if (o.fresh) claims.occupied = occupied;
    }
    const mo = first('motion');
    if (mo) {
      // Momentary, and not a problem by itself (rule 10): attention only while the alarm is armed away.
      const moving = mo.hasValue ? mo.st.state === 'on' : null;
      facts.push(fact('Motion', mo, moving ? 'Detected' : 'Clear'));
      if (mo.fresh) {
        claims.motion = moving;
        claims.lastMotionAt = mo.changedAt;          // while moving: when it began; when clear: when it was last seen
        if (moving && ctx.armed === 'away' && !urgent) {
          urgent = { severity: 'attention', text: `Motion in ${name}`, since: mo.changedAt, word: 'Motion' };
        }
      }
    }
    claims.active = claims.occupied === true || claims.motion === true;
    if (m) facts.push(fact('Smoke sensor', m, m.hasValue && m.st.state === 'on' ? 'Smoke detected' : 'Clear'));
    if (k) facts.push(fact('Leak sensor', k, k.hasValue && k.st.state === 'on' ? 'Leak detected' : 'Dry'));

    if (claims.temperature != null) word = formatTemp(claims.temperature, unit);
    claims.temperatureUnit = claims.temperature != null ? unit : null;
    return { claims, word, since: null, status: 'none', urgent, facts, actions: [], unknowns };
  },

  object(ref, first, R, ctx) {
    const p = first('power');
    const pg = first('progress');
    const rem = first('remaining');
    const pr = first('presence');
    const ch = first('charging');
    const name = ref.name || ref.id;
    const claims = {};
    const facts = [];
    const ignore = [];
    let urgent = null;
    let info = null;
    let word = '';
    let since = null;

    let progress = null;
    let progressFact = null;
    if (pg) {
      const v = pg.hasValue ? num(pg.st.state) : null;
      progressFact = fact('Progress', pg, v == null ? '' : `${Math.round(Math.min(100, Math.max(0, v)))}%`);
      if (pg.fresh && v != null) progress = clamp01(v / 100);
    }
    let remainingMin = null;
    let remainingFact = null;
    if (rem) {
      const v = rem.hasValue ? num(rem.st.state) : null;
      const unit = String(rem.attrs.unit_of_measurement || 'min').toLowerCase();
      const minutes = v == null ? null : Math.max(0, unit === 's' || unit === 'sec' || unit === 'seconds' ? v / 60 : unit === 'h' || unit === 'hours' ? v * 60 : v);
      remainingFact = fact('Time left', rem, minutes == null ? '' : formatRemaining(minutes));
      if (rem.fresh && minutes != null) remainingMin = minutes;
    }

    if (p) {
      const s = p.hasValue ? String(p.st.state) : null;
      const media = p.entityId.startsWith('media_player.');
      const printer = ctx.typeOf(ref.id) === 'printer3d' || /print/i.test(`${ref.id} ${name}`);
      const phase = s == null ? null : phaseOf(s, media);
      const base = s == null ? '' : media ? words(s)
        : phase === 'running' ? (printer ? 'Printing' : 'Running')
          : phase === 'paused' ? 'Paused'
            : phase === 'done' ? (printer ? 'Print finished' : 'Finished')
              : phase === 'error' ? 'Error'
                : /^(idle|standby|ready|operational)$/i.test(s) ? 'Idle' : 'Off';
      facts.push(fact('Status', p, base));
      if (p.fresh) {
        claims.phase = phase;
        claims.running = phase === 'running';
        word = base;
        since = p.changedAt;
        const active = phase === 'running' || phase === 'paused';
        if (media) {
          // What is on: only while the player says it is doing something.
          const title = active ? (p.attrs.media_title || p.attrs.app_name || p.attrs.source || null) : null;
          claims.title = title == null ? null : String(title);
          if (claims.title) {
            facts.push({ label: 'Playing', value: claims.title, at: null, checkedAt: p.reportedAt });
            if (s.toLowerCase() === 'playing') word = `Playing ${claims.title}`;
          }
        } else {
          if (active && progress != null) word = `${base} ${formatPercent(progress)}`;
          // Rule 11. A console or TV (media player) is never listed.
          if (phase === 'done') info = { text: `${name}: ${printer ? 'print finished' : 'finished'}`, since: p.changedAt };
          else if (phase === 'error' || phase === 'paused') {
            urgent = { severity: 'attention', text: `${name}: ${phase}`, since: p.changedAt, word };
          }
        }
        // Rule 5: progress and time left matter only while a job is under way. A printer that is idle or
        // done is not made unknown by a progress sensor that has nothing to say.
        if (!active) for (const r of [pg, rem]) if (r) ignore.push(r);
      }
    }
    if (progressFact) facts.push(progressFact);
    if (remainingFact) facts.push(remainingFact);
    claims.progress = progress;
    claims.remainingMin = remainingMin;
    if (pr) {
      const present = pr.hasValue ? pr.st.state === 'on' : null;
      facts.push(fact('Presence', pr, present ? 'In the bay' : 'Away'));
      if (pr.fresh) { claims.present = present; word = present ? 'Parked' : 'Away'; since = pr.changedAt; }
    }
    if (ch) {
      const charging = ch.hasValue ? ch.st.state === 'on' : null;
      facts.push(fact('Charging', ch, charging ? 'Charging' : 'Not charging'));
      if (ch.fresh) {
        claims.charging = charging;
        if (charging && claims.present !== false) { word = 'Charging'; since = ch.changedAt; }
        else if (!pr) { word = 'Not charging'; since = ch.changedAt; }
      }
    }
    const status = claims.running === true || (claims.charging === true && claims.present !== false) ? 'on' : 'off';
    return { claims, word, since, status, urgent, info, ignore, facts, actions: [], unknowns: [] };
  },

  camera(ref, first, R, ctx) {
    const c = first('camera');
    const m = first('motion');
    const p = first('person_detected');
    const name = ref.name || ref.id;
    const claims = {};
    const facts = [];
    const unknowns = [];
    const ignore = [];
    let urgent = null;
    let word = '';
    let since = null;
    // Rule 13. Privacy: the camera itself says its lens is shut on purpose ('off', or attributes.privacy).
    // That is a healthy state, not a silence: no picture, no detections, and nothing to list.
    const s = c && c.hasValue ? String(c.st.state).toLowerCase() : null;
    const privacy = !!c && c.fresh && (s === 'off' || c.attrs.privacy === true);
    if (c) {
      facts.push(fact('Camera', c, s == null ? '' : s === 'off' || c.attrs.privacy === true ? 'Privacy' : words(s)));
      if (c.fresh) {
        claims.recording = !privacy && s === 'recording';
        word = privacy ? 'Privacy' : words(s);
        since = c.changedAt;
        if (privacy) claims.privacy = true;
        else {
          // The picture is a claim of the camera entity alone. The URL may carry a token: it goes nowhere but here.
          const url = [c.attrs.feed_url, c.attrs.entity_picture].find((u) => typeof u === 'string' && u.trim() !== '');
          if (url) claims.feed = { url, simulated: /^sim:/.test(url), at: c.reportedAt };
        }
      } else unknowns.push(unknownIssue(ref, c, name));               // rule 9
    }
    if (privacy) {
      // A shut lens detects nothing, and its detectors going quiet is expected (rule 5: they do not matter now).
      for (const r of [m, p]) if (r) ignore.push(r);
      return { claims, word, since, status: 'none', urgent: null, ignore, facts, actions: [], unknowns: [] };
    }
    if (m) {
      const on = m.hasValue ? m.st.state === 'on' : null;
      facts.push(fact('Motion', m, on ? 'Detected' : 'Clear'));
      if (m.fresh) { claims.motion = on; claims.lastMotionAt = m.changedAt; }
      else unknowns.push(unknownIssue(ref, m, name));
    }
    if (p) {
      const on = p.hasValue ? p.st.state === 'on' : null;
      facts.push(fact('Person', p, on ? 'In view' : 'Clear'));
      if (p.fresh) {
        claims.person = on; claims.lastPersonAt = p.changedAt;
        // Rule 10: a person in view is a concern only while the alarm is armed (home, night or away).
        if (on && ctx.armed) urgent = { severity: 'attention', text: `Person at ${name}`, since: p.changedAt, word: 'Person' };
      } else unknowns.push(unknownIssue(ref, p, name));
    }
    if (claims.person === true) { word = 'Person'; since = p.changedAt; }
    else if (claims.motion === true) { word = 'Motion'; since = m.changedAt; }
    else if (claims.person === false || claims.motion === false) {
      word = 'Clear';
      since = Math.max(claims.person === false && p.changedAt != null ? p.changedAt : -Infinity, claims.motion === false && m.changedAt != null ? m.changedAt : -Infinity);
      if (!Number.isFinite(since)) since = null;
    }
    const status = claims.person === true || claims.motion === true ? 'on' : 'off';
    return { claims, word, since, status, urgent, facts, actions: [], unknowns };
  },

  house(ref, first, R, ctx) {
    const facts = [];
    let urgent = null;
    let word = '';
    let since = null;
    for (const r of R.person || []) {
      facts.push(fact(ctx.personNames.get(r.entityId) || personName(r), r, r.hasValue && r.st.state === 'home' ? 'Home' : 'Away'));
    }
    const a = first('alarm');
    if (a) {
      const said = a.hasValue ? alarmWord(a.st.state) : '';
      facts.push(fact('Alarm', a, said));
      if (a.fresh) {
        word = said; since = a.changedAt;
        if (a.st.state === 'triggered') urgent = { severity: 'alert', text: 'Alarm triggered', since: a.changedAt, word: said };
      }
    }
    const ot = first('outdoor_temperature');
    if (ot) {
      const reading = outdoorReading(ot);
      facts.push(fact('Outdoor', ot, reading ? formatTemp(reading.value, reading.unit) : 'No data'));
    }
    return { claims: {}, word, since, status: 'none', urgent, facts, actions: [], unknowns: [] };
  },
};

function coverAction(id, label, entityId) {
  const service = id.startsWith('close') ? 'close_cover' : 'open_cover';
  return { id, label, call: { domain: 'cover', service, data: { entity_id: entityId } } };
}

const ARMED_AWAY = new Set(['armed_away', 'armed_vacation']);
const ARMED_HOME = new Set(['armed_home', 'armed_night', 'armed_custom_bypass']);

const NOT_RUNNING = new Set(['off', 'idle', 'standby', 'paused', 'stopped', 'not_running', 'complete', 'finished', 'none', 'closed', 'false', 'ready', 'operational']);
const PHASE_WORDS = {
  printing: 'running',
  paused: 'paused', pause: 'paused', pausing: 'paused',
  error: 'error', failed: 'error', fault: 'error',
  complete: 'done', completed: 'done', finished: 'done', finish: 'done', done: 'done',
};

/** Appliance `power` state → 'idle' | 'running' | 'paused' | 'done' | 'error'. */
function phaseOf(state, media) {
  const s = String(state).trim().toLowerCase();
  if (media) return s === 'playing' || s === 'on' || s === 'buffering' ? 'running' : s === 'paused' ? 'paused' : 'idle';
  if (PHASE_WORDS[s]) return PHASE_WORDS[s];
  return isRunning(state) ? 'running' : 'idle';
}

const ON_CHARGE = new Set(['charging', 'full', 'on', 'true', 'wireless', 'ac', 'usb']);

/** One person, from the person entity and the phone sensors bound to them (rules 8 and 12). */
function derivePerson(def, ctx, resolveRoom) {
  const read = (role) => {
    const entityId = def.roles[role];
    if (!entityId) return null;
    if (ctx.connection === 'live' && !ctx.get(entityId)) return null;      // not installed (rule 1)
    return readRole(entityId, role, ctx);
  };
  const p = read('person');
  const rm = read('phone_room');
  const b = read('phone_battery');
  const c = read('phone_charging');
  // Someone only ever named by a person entity does not exist until the hub has that entity.
  if (!def.declared && !p) return null;

  const name = def.name || (p ? personName(p) : words(def.id));
  const facts = [];
  let home = null;
  let since = null;
  if (p) {
    const isHome = p.hasValue ? p.st.state === 'home' : null;
    facts.push(fact('Presence', p, isHome ? 'Home' : 'Away'));
    if (p.fresh) { home = isHome; since = p.changedAt; }
  }
  let room = null;
  let roomSince = null;
  if (rm) {
    const resolved = rm.hasValue ? resolveRoom(rm.st.state) : null;
    const away = rm.hasValue && String(rm.st.state).trim().toLowerCase() === 'not_home';
    // It is the phone's location, and it says so.
    facts.push(fact('Phone', rm, resolved ? `In ${resolved.name}` : away ? 'Away' : 'Not in a known room'));
    if (rm.fresh) {
      // With no person entity, the phone is all there is to go on.
      if (!p) { home = resolved ? true : away ? false : null; since = home == null ? null : rm.changedAt; }
      // Rule 8: a room only while home and the reading is fresh.
      if (home === true && resolved) { room = resolved; roomSince = rm.changedAt; }
    }
  }
  let battery = null;
  if (b) {
    const v = b.hasValue ? num(b.st.state) : null;
    if (b.hasValue && v == null) facts.push({ label: 'Phone battery', value: 'No data', at: b.changedAt, checkedAt: b.reportedAt, unknown: true });
    else facts.push(fact('Phone battery', b, v == null ? '' : `${Math.round(v)}%`, b.fresh ? null : undefined));
    if (b.fresh && v != null) battery = clamp01(v / 100);
  }
  let charging = null;
  if (c) {
    const s = c.hasValue ? String(c.st.state).trim().toLowerCase().replace(/\s+/g, '_') : null;
    const on = s == null ? null : ON_CHARGE.has(s);
    facts.push(fact('Charging', c, s === 'full' ? 'Full' : on ? 'Charging' : 'Not charging'));
    if (c.fresh) charging = on;
  }

  const sensed = [p, rm, b, c].filter(Boolean);
  const lead = p || rm || (sensed.length ? worstOf(sensed) : null);
  const freshness = lead ? lead.freshness : 'unsensed';
  return {
    id: def.id, name, home,
    room: room ? room.id : null, roomName: room ? room.name : null, levelId: room ? room.level : null,
    battery, charging,
    batteryLow: battery != null && battery < LOW_BATTERY && charging !== true,       // rule 12
    freshness, reason: lead && !lead.fresh ? lead.reason : null,
    text: room ? room.name : home === true ? 'Home' : home === false ? 'Away' : 'No data',
    since, roomSince, facts,
  };
}

/** Appliance `power` role: running when on, playing, or any non-idle state. A number is watts: running above 5 W. */
function isRunning(state) {
  const n = num(state);
  if (n != null && /^-?[\d.]+$/.test(String(state).trim())) return n > 5;
  return !NOT_RUNNING.has(String(state).toLowerCase());
}

function personName(r) {
  if (r.attrs.friendly_name) return String(r.attrs.friendly_name);
  return words(r.entityId.split('.').slice(1).join('.'));
}

function alarmWord(state) {
  if (state === 'armed_home') return 'Armed (home)';
  if (state === 'armed_away') return 'Armed (away)';
  if (state === 'armed_night') return 'Armed (night)';
  return words(state);
}

function outdoorReading(r) {
  if (!r.hasValue) return null;
  const isWeather = r.entityId.startsWith('weather.');
  const value = isWeather ? num(r.attrs.temperature) : num(r.st.state);
  if (value == null) return null;
  const unit = (isWeather ? r.attrs.temperature_unit : r.attrs.unit_of_measurement) || '°C';
  return { value, unit };
}

function summarise(things, attention, connection, hasSecurity, byThing, ctx, outdoorRooms, allPeople) {
  let lightsOn = 0;
  let openCount = 0;
  const temps = [];
  let unit = '°C';
  for (const t of Object.values(things)) {
    if (t.kind === 'light' && t.on === true) lightsOn += 1;
    else if ((t.kind === 'door' || t.kind === 'window') && t.open === true && (t.exterior || isCoverDoor(t, byThing))) openCount += 1;
    else if (t.kind === 'room' && t.temperature != null && !outdoorRooms.has(t.id)) { temps.push(t.temperature); unit = t.temperatureUnit || unit; }
  }

  const house = presentRoles(byThing.get('house'), ctx) || {};
  const people = allPeople.map((p) => ({
    id: p.id, name: p.name, home: p.home, room: p.room, roomName: p.roomName, battery: p.battery, batteryLow: p.batteryLow,
  }));
  let alarm = null;
  if (house.alarm) {
    const r = readRole(house.alarm[0], 'alarm', ctx);
    if (r.fresh) alarm = r.st.state;
  }
  let outdoor = null;
  if (house.outdoor_temperature) {
    const r = readRole(house.outdoor_temperature[0], 'outdoor_temperature', ctx);
    if (r.fresh) outdoor = outdoorReading(r);
  }
  let indoor = null;
  if (temps.length) {
    temps.sort((a, b) => a - b);
    const mid = temps.length >> 1;
    const median = temps.length % 2 ? temps[mid] : (temps[mid - 1] + temps[mid]) / 2;
    indoor = { value: Math.round(median * 10) / 10, unit };
  }

  const unsensedExteriorIds = unsensedExterior(things, byThing, ctx);

  // Rule 7.
  let headline;
  let headlineStatus;
  const alerts = attention.filter((a) => a.severity === 'alert').length;
  // 'info' items are listed and never change the headline.
  const counted = attention.filter((a) => a.severity !== 'info');
  if (connection === 'offline') { headline = 'Not connected'; headlineStatus = 'unknown'; }
  else if (connection === 'connecting') { headline = 'Connecting…'; headlineStatus = 'none'; }
  else if (alerts) { headline = `${alerts} ${alerts === 1 ? 'alert' : 'alerts'}`; headlineStatus = 'alert'; }
  else if (counted.length) {
    headline = `${counted.length} ${counted.length === 1 ? 'needs' : 'need'} attention`;
    headlineStatus = counted.some((a) => a.severity === 'attention') ? 'attention' : 'unknown';
  } else if (!hasSecurity) { headline = 'No security sensors'; headlineStatus = 'none'; }
  // 'All secure' is a claim about every way in. With an exterior opening nobody is watching, say less.
  else if (unsensedExteriorIds.length) { headline = 'Secure where sensed'; headlineStatus = 'secure'; }
  else { headline = 'All secure'; headlineStatus = 'secure'; }

  return { headline, headlineStatus, unsensedExterior: unsensedExteriorIds.length, unsensedExteriorIds, lightsOn, openCount, people, alarm, outdoor, indoor };
}

function isCoverDoor(t, byThing) {
  const bound = byThing.get(t.id);
  return t.kind === 'door' && !!(bound && bound.cover);
}
