// Hand-written CompiledPlan and Derived fixtures for dev/ui.html and tests/ui.test.js.
// They follow CONTRACTS.md sections 1 and 2 by hand; nothing here runs derive().
// Entity ids appear only inside action `call` payloads, which the UI passes through unread.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/** Stands for the short-lived token a real feed URL carries. Tests check it never reaches the DOM. */
export const FEED_TOKEN = 'tok-3f9a-do-not-show';

/** Monday 23 November 2026, 21:04 local. */
export const NOW = new Date(2026, 10, 23, 21, 4, 0).getTime();

// ---- plan -------------------------------------------------------------------
function rect(x0, y0, x1, y1) { return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]; }

function room(id, name, type, level, r, outdoor = false) {
  const [x0, y0, x1, y1] = r;
  return {
    id, name, type, level, outdoor, polygon: rect(x0, y0, x1, y1), area: (x1 - x0) * (y1 - y0),
    centroid: [(x0 + x1) / 2, (y0 + y1) / 2], bounds: { minX: x0, minY: y0, maxX: x1, maxY: y1 },
  };
}

const levels = [
  { id: 'ground', name: 'Ground floor', short: 'G', elevation: 0, height: 2.7, bounds: { minX: 0, minY: 0, maxX: 11, maxY: 10.5 } },
  { id: 'first', name: 'First floor', short: '1', elevation: 2.7, height: 2.6, bounds: { minX: 0, minY: 0, maxX: 11, maxY: 5 } },
  { id: 'loft', name: 'Loft', short: '2', elevation: 5.3, height: 2.2, bounds: { minX: 3, minY: 0, maxX: 8, maxY: 5 } },
];

const rooms = [
  room('living', 'Living room', 'living', 'ground', [0, 0, 6, 5]),
  room('kitchen', 'Kitchen', 'kitchen', 'ground', [6, 0, 11, 5]),
  room('entry', 'Entry', 'hall', 'ground', [0, 5, 3, 8]),
  room('laundry', 'Laundry', 'laundry', 'ground', [3, 5, 6, 8]),
  room('garage', 'Garage', 'garage', 'ground', [6, 5, 11, 10.5]),
  room('bedroom', 'Main bedroom', 'bedroom', 'first', [0, 0, 5, 5]),
  room('landing', 'Landing', 'hall', 'first', [5, 0, 7, 5]),
  room('study', 'Study', 'office', 'first', [7, 0, 11, 5]),
  room('attic', 'Loft room', 'bedroom', 'loft', [3, 0, 8, 5]),
];

function opening(id, name, type, style, level, center, roomId, exterior) {
  return { id, name, type, style, level, wall: `w_${id}`, center, width: 0.9, sill: 0, head: 2.05, dir: [1, 0], normal: [0, 1], hingeEnd: 'from', exterior, rooms: [roomId, null] };
}

const openings = [
  opening('front_door', 'Front door', 'door', 'hinged', 'ground', [1.5, 8], 'entry', true),
  opening('back_door', 'Back door', 'door', 'sliding', 'ground', [0, 2.5], 'living', true),
  opening('garage_door', 'Garage door', 'door', 'garage', 'ground', [8.5, 10.5], 'garage', true),
  opening('laundry_door', 'Laundry door', 'door', 'hinged', 'ground', [3, 6.5], 'laundry', false),
  opening('kitchen_window', 'Kitchen window', 'window', null, 'ground', [8.5, 0], 'kitchen', true),
  opening('living_window', 'Living room window', 'window', null, 'ground', [3, 0], 'living', true),
  opening('bedroom_window', 'Bedroom window', 'window', null, 'first', [2.5, 0], 'bedroom', true),
];

function light(id, name, mount, level, roomId, at) {
  return { id, name, type: 'light', mount, level, room: roomId, at, height: mount === 'lamp' ? 1.4 : 2.65 };
}

const fixtures = [
  light('living_ceiling', 'Living room ceiling', 'ceiling', 'ground', 'living', [3, 2.6]),
  light('living_lamp', 'Reading lamp', 'lamp', 'ground', 'living', [0.9, 4.2]),
  light('kitchen_island_light', 'Island pendants', 'ceiling', 'ground', 'kitchen', [8.5, 2.6]),
  light('entry_light', 'Entry light', 'ceiling', 'ground', 'entry', [1.5, 6.4]),
  light('garage_light', 'Garage light', 'ceiling', 'ground', 'garage', [8.5, 7.6]),
  light('bedroom_light', 'Bedroom ceiling', 'ceiling', 'first', 'bedroom', [2.5, 2.5]),
  light('study_lamp', 'Desk lamp', 'lamp', 'first', 'study', [9.5, 1.2]),
  // Round 2: cameras are fixtures too (kind 'camera').
  { id: 'driveway_camera', name: 'Driveway camera', type: 'camera', mount: 'exterior', level: 'ground', room: 'garage', at: [10.6, 10.5], height: 2.2, rotation: 0, fov: 90, range: 6, pitch: 30, aspect: 16 / 9, indoor: false },
  { id: 'porch_camera', name: 'Front porch camera', type: 'camera', mount: 'exterior', level: 'ground', room: 'entry', at: [0.3, 8], height: 2.2, rotation: 0, fov: 90, range: 6, pitch: 30, aspect: 16 / 9, indoor: false },
  // Round 3: an indoor camera (it can be in privacy, and its card says "Indoor").
  { id: 'living_camera', name: 'Living room camera', type: 'camera', mount: 'ceiling', level: 'ground', room: 'living', at: [5.6, 0.5], height: 2.4, rotation: 0.9, fov: 100, range: 5, pitch: 35, aspect: 16 / 9, indoor: true },
];

const objects = [
  { id: 'washer', name: 'Washer', type: 'washer', role: 'appliance', level: 'ground', room: 'laundry', at: [5.4, 5.6], size: [0.6, 0.6, 0.85], rotation: 0 },
  { id: 'car_bay_1', name: 'Car', type: 'car', role: 'vehicle', level: 'ground', room: 'garage', at: [8.5, 8.2], size: [1.9, 4.6, 1.45], rotation: 0 },
  { id: 'living_tv', name: 'Living room TV', type: 'tv', role: 'appliance', level: 'ground', room: 'living', at: [3, 0.3], size: [1.4, 0.1, 0.8], rotation: 0 },
  { id: 'console', name: 'PlayStation', type: 'console', role: 'appliance', level: 'ground', room: 'living', at: [4.2, 0.4], size: [0.3, 0.25, 0.1], rotation: 0 },
  { id: 'printer', name: '3D printer', type: 'printer3d', role: 'appliance', level: 'first', room: 'study', at: [10.2, 4.2], size: [0.5, 0.5, 0.5], rotation: 0 },
  { id: 'sofa', name: null, type: 'sofa', role: null, level: 'ground', room: 'living', at: [3, 3.8], size: [2.2, 0.95, 0.75], rotation: 0 },
];

function buildThings() {
  const things = {};
  for (const r of rooms) things[r.id] = { id: r.id, kind: 'room', name: r.name, level: r.level, room: r.id };
  for (const o of openings) things[o.id] = { id: o.id, kind: o.type, name: o.name, level: o.level, room: o.rooms[0], exterior: o.exterior };
  for (const f of fixtures) things[f.id] = { id: f.id, kind: f.type === 'camera' ? 'camera' : 'light', name: f.name, level: f.level, room: f.room };
  for (const o of objects) if (o.role) things[o.id] = { id: o.id, kind: 'object', name: o.name, level: o.level, room: o.room };
  things.house = { id: 'house', kind: 'house', name: 'Placeholder House', level: null, room: null };
  return things;
}

/** A CompiledPlan-shaped stand-in (no walls or posts: the UI never reads them). */
export const devPlan = {
  name: 'Placeholder House',
  bounds: { minX: 0, minY: 0, maxX: 11, maxY: 10.5 },
  levels, rooms, walls: [], posts: [], openings, fixtures, objects,
  things: buildThings(),
  problems: [],
};

// ---- derived builders ----------------------------------------------------------
const call = (domain, service, id) => ({ domain, service, data: { entity_id: `${domain}.${id}` } });

function base(id, extra) {
  const ref = devPlan.things[id];
  return {
    id, kind: ref.kind, name: ref.name, levelId: ref.level, room: ref.room,   // storey is levelId; on a light, level is brightness
    freshness: 'fresh', status: 'off', text: '', since: null, reportedAt: null, facts: [], actions: [],
    ...extra,
  };
}

/** A quiet, fully sensed house: everything closed, locked and off. */
function quiet(now) {
  const t = {};
  const temps = { living: 21.5, kitchen: 21.9, entry: 20.4, laundry: 19.8, garage: 12.1, bedroom: 19.6, landing: 20.2, study: 20.9, attic: 18.7 };
  for (const r of rooms) {
    t[r.id] = base(r.id, {
      status: 'off', text: `${temps[r.id]} °C`, since: null, reportedAt: now - 4 * MIN,
      facts: [
        { label: 'Temperature', value: `${temps[r.id]} °C`, at: now - 4 * MIN },
        { label: 'Occupancy', value: 'Clear', at: now - 12 * MIN },
      ],
      temperature: temps[r.id], temperatureUnit: '°C', humidity: null, occupied: false, alert: null, hvac: null, lit: 0,
    });
  }
  for (const f of fixtures) {
    if (f.type === 'camera') {
      t[f.id] = base(f.id, {
        status: 'off', text: 'Clear', since: now - 52 * MIN, reportedAt: now - 1 * MIN,
        facts: [
          { label: 'Camera', value: 'Idle', at: now - 6 * HOUR, checkedAt: now - 20 * 1000 },
          { label: 'Motion', value: 'Clear', at: now - 52 * MIN, checkedAt: now - 20 * 1000 },
          { label: 'Person', value: 'Clear', at: now - 3 * HOUR, checkedAt: now - 20 * 1000 },
        ],
        motion: false, person: false, recording: false, lastMotionAt: now - 52 * MIN, lastPersonAt: now - 3 * HOUR,
        // Round 3. The driveway and living room cameras stand for real pictures from the hub
        // (the URL carries a token and must never reach the screen); the porch feed is simulated.
        indoor: f.indoor === true, privacy: false,
        feed: f.id === 'porch_camera'
          ? { url: `sim:${f.id}`, simulated: true, at: now - 2 * 1000 }
          : { url: `https://hub.invalid/api/camera_proxy/camera.${f.id}?token=${FEED_TOKEN}`, simulated: false, at: now - 2 * 1000 },
      });
      continue;
    }
    t[f.id] = base(f.id, {
      status: 'off', text: 'Off', since: now - 3 * HOUR, reportedAt: now - 3 * HOUR,
      facts: [{ label: 'State', value: 'Off', at: now - 3 * HOUR }],
      actions: [{ id: 'toggle', label: 'Turn on', call: call('light', 'turn_on', f.id) }],
      on: false, level: null, colorTempK: null, rgb: null,
    });
  }
  t.front_door = base('front_door', {
    status: 'secure', text: 'Locked', since: now - 2 * HOUR, reportedAt: now - 20 * MIN,
    facts: [
      { label: 'Door', value: 'Closed', at: now - 2 * HOUR },
      { label: 'Lock', value: 'Locked', at: now - 2 * HOUR },
    ],
    actions: [{ id: 'unlock', label: 'Unlock', call: call('lock', 'unlock', 'front_door') }],
    open: false, position: 0, locked: true, moving: null, exterior: true,
  });
  t.back_door = base('back_door', {
    status: 'secure', text: 'Locked', since: now - 5 * HOUR, reportedAt: now - 35 * MIN,
    facts: [
      { label: 'Door', value: 'Closed', at: now - 5 * HOUR },
      { label: 'Lock', value: 'Locked', at: now - 5 * HOUR },
    ],
    actions: [{ id: 'unlock', label: 'Unlock', call: call('lock', 'unlock', 'back_door') }],
    open: false, position: 0, locked: true, moving: null, exterior: true,
  });
  t.garage_door = base('garage_door', {
    status: 'secure', text: 'Closed', since: now - 90 * MIN, reportedAt: now - 90 * MIN,
    facts: [{ label: 'Position', value: 'Closed', at: now - 90 * MIN }],
    actions: [{ id: 'open', label: 'Open', call: call('cover', 'open_cover', 'garage_door') }],
    open: false, position: 0, locked: null, moving: null, exterior: true,
  });
  // An interior door with no sensor is plain architecture (honesty rule 1).
  t.laundry_door = base('laundry_door', {
    freshness: 'unsensed', status: 'none', text: 'No sensor',
    facts: [{ label: 'Sensors', value: 'None installed', at: null }],
    open: null, position: null, locked: null, moving: null, exterior: false,
  });
  for (const id of ['kitchen_window', 'living_window', 'bedroom_window']) {
    t[id] = base(id, {
      status: 'secure', text: 'Closed', since: now - 6 * HOUR, reportedAt: now - 50 * MIN,
      facts: [{ label: 'Window', value: 'Closed', at: now - 6 * HOUR }],
      open: false, blind: null, exterior: true,
    });
  }
  t.washer = base('washer', {
    status: 'off', text: 'Idle', since: now - 26 * HOUR, reportedAt: now - 2 * MIN,
    facts: [{ label: 'Power', value: 'Idle', at: now - 2 * MIN }],
    running: false, present: null, charging: null,
  });
  for (const id of ['living_tv', 'console', 'printer']) {
    t[id] = base(id, {
      status: 'off', text: id === 'printer' ? 'Idle' : 'Off', since: now - 20 * HOUR, reportedAt: now - 2 * MIN,
      facts: [{ label: 'Power', value: id === 'printer' ? 'Idle' : 'Off', at: now - 20 * HOUR }],
      running: false, present: null, charging: null, phase: 'idle', progress: null, remainingMin: null, title: null,
    });
  }
  t.car_bay_1 = base('car_bay_1', {
    status: 'off', text: 'In the bay', since: now - 3 * HOUR, reportedAt: now - 3 * HOUR,
    facts: [
      { label: 'Presence', value: 'In the bay', at: now - 3 * HOUR },
      { label: 'Charging', value: 'Not charging', at: now - 3 * HOUR },
    ],
    running: null, present: true, charging: false,
  });
  t.house = base('house', { status: 'none', text: '', facts: [] });
  return t;
}

function lightOn(t, id, now, level, agoMs) {
  const pct = level == null ? null : Math.round(level * 100);
  Object.assign(t[id], {
    status: 'on', text: pct == null ? 'On' : `On ${pct}%`, since: now - agoMs, reportedAt: now - agoMs,
    facts: [
      { label: 'State', value: 'On', at: now - agoMs },
      ...(pct == null ? [] : [{ label: 'Brightness', value: `${pct}%`, at: now - agoMs }]),
      { label: 'Colour temperature', value: '2700 K', at: null },
    ],
    actions: [{ id: 'toggle', label: 'Turn off', call: call('light', 'turn_off', id) }],
    on: true, level, colorTempK: 2700,
  });
  const r = t[t[id].room];
  r.lit = Math.max(r.lit, level == null ? 1 : level);
}

function people(sam, alex) {
  return [{ name: 'Sam', home: sam }, { name: 'Alex', home: alex }];
}

function summary(headline, headlineStatus, t, extra = {}) {
  const lightsOn = Object.values(t).filter((x) => x.kind === 'light' && x.on === true).length;
  const openCount = Object.values(t).filter((x) => (x.kind === 'door' || x.kind === 'window') && x.open === true).length;
  return {
    headline, headlineStatus, lightsOn, openCount,
    people: people(true, true), alarm: null,
    outdoor: { value: 8.2, unit: '°C' }, indoor: { value: 21.5, unit: '°C' },
    ...extra,
  };
}

function openGarage(t, now, agoMs) {
  Object.assign(t.garage_door, {
    status: 'attention', text: 'Open', since: now - agoMs, reportedAt: now - agoMs,
    facts: [{ label: 'Position', value: 'Open 100%', at: now - agoMs }],
    actions: [{ id: 'close', label: 'Close', call: call('cover', 'close_cover', 'garage_door') }],
    open: true, position: 1,
  });
  return { id: 'garage_door', severity: 'attention', text: 'Garage door open', since: now - agoMs, level: 'ground', room: 'garage' };
}

function unlockBack(t, now, agoMs) {
  Object.assign(t.back_door, {
    status: 'attention', text: 'Unlocked', since: now - agoMs, reportedAt: now - agoMs,
    facts: [
      { label: 'Door', value: 'Closed', at: now - 5 * HOUR },
      { label: 'Lock', value: 'Unlocked', at: now - agoMs },
    ],
    actions: [{ id: 'lock', label: 'Lock', call: call('lock', 'lock', 'back_door') }],
    locked: false,
  });
  return { id: 'back_door', severity: 'attention', text: 'Back door unlocked', since: now - agoMs, level: 'ground', room: 'living' };
}

// ---- the fixtures ------------------------------------------------------------------
function evening(now = NOW) {
  const t = quiet(now);
  lightOn(t, 'living_ceiling', now, 0.6, 2 * HOUR + 10 * MIN);
  lightOn(t, 'living_lamp', now, null, 48 * MIN);
  lightOn(t, 'kitchen_island_light', now, 0.8, 95 * MIN);
  lightOn(t, 'entry_light', now, 0.4, 14 * MIN);
  lightOn(t, 'bedroom_light', now, 0.3, 22 * MIN);
  Object.assign(t.washer, {
    status: 'on', text: 'Running', since: now - 38 * MIN,
    facts: [{ label: 'Power', value: 'Running', at: now - 1 * MIN }], running: true,
  });
  t.living.occupied = true;
  t.living.facts[1] = { label: 'Occupancy', value: 'Occupied', at: now - 2 * MIN };
  const attention = [openGarage(t, now, 14 * MIN), unlockBack(t, now, 3 * MIN)];
  return { now, connection: 'live', snapshotAt: now, things: t, attention, summary: summary('2 need attention', 'attention', t) };
}

function secure(now = NOW) {
  const t = quiet(now);
  lightOn(t, 'living_lamp', now, 0.5, 70 * MIN);
  lightOn(t, 'bedroom_light', now, 0.3, 12 * MIN);
  return { now, connection: 'live', snapshotAt: now, things: t, attention: [], summary: summary('Secure where sensed', 'secure', t, { unsensedExterior: 5 }) };
}

function alert(now = NOW) {
  const t = quiet(now);
  lightOn(t, 'living_ceiling', now, 0.6, 2 * HOUR);
  lightOn(t, 'kitchen_island_light', now, 0.8, 95 * MIN);
  Object.assign(t.laundry, {
    status: 'alert', text: 'Leak detected', since: now - 6 * MIN, reportedAt: now - 1 * MIN,
    facts: [
      { label: 'Leak sensor', value: 'Wet', at: now - 6 * MIN },
      { label: 'Temperature', value: '19.8 °C', at: now - 4 * MIN },
    ],
    alert: 'leak',
  });
  const attention = [
    { id: 'laundry', severity: 'alert', text: 'Leak in Laundry', since: now - 6 * MIN, level: 'ground', room: 'laundry' },
    openGarage(t, now, 41 * MIN),
  ];
  return { now, connection: 'live', snapshotAt: now, things: t, attention, summary: summary('1 alert', 'alert', t, { people: people(true, false) }) };
}

function stale(now = NOW) {
  const t = quiet(now);
  lightOn(t, 'living_ceiling', now, 0.6, 2 * HOUR);
  // Contact sensor went quiet 3 h ago; the lock still reports. No claim about open/closed.
  Object.assign(t.front_door, {
    freshness: 'stale', status: 'unknown', text: 'No data', since: null, reportedAt: now - 27 * HOUR,
    facts: [
      { label: 'Door', value: 'Closed', at: now - 27 * HOUR, lastKnown: true },
      { label: 'Lock', value: 'Locked', at: now - 2 * HOUR },
    ],
    actions: [], open: null, position: null, locked: true,
  });
  // Window sensor paired but has never reported a value.
  Object.assign(t.kitchen_window, {
    freshness: 'unknown', status: 'unknown', text: 'No data', since: null, reportedAt: null,
    facts: [{ label: 'Window', value: 'No data', at: null, unknown: true }], open: null,
  });
  // Washer plug unreachable.
  Object.assign(t.washer, {
    freshness: 'unknown', status: 'unknown', text: 'Offline', since: null, reportedAt: now - 3 * HOUR - 12 * MIN,
    facts: [{ label: 'Power', value: 'Idle', at: now - 3 * HOUR - 12 * MIN, lastKnown: true }], running: null,
  });
  // Bedroom climate sensor stale: the room makes no temperature claim.
  Object.assign(t.bedroom, {
    freshness: 'stale', status: 'unknown', text: 'No data', reportedAt: now - 5 * HOUR,
    facts: [
      { label: 'Temperature', value: '19.6 °C', at: now - 5 * HOUR, lastKnown: true },
      { label: 'Occupancy', value: 'Clear', at: now - 12 * MIN },
    ],
    temperature: null,
  });
  const attention = [
    { id: 'front_door', severity: 'unknown', text: 'Front door: no data', since: now - 27 * HOUR, level: 'ground', room: 'entry' },
    { id: 'kitchen_window', severity: 'unknown', text: 'Kitchen window: no data', since: null, level: 'ground', room: 'kitchen' },
  ];
  return { now, connection: 'live', snapshotAt: now, things: t, attention, summary: summary('2 need attention', 'unknown', t) };
}

/** Day one in a new house: nothing bound to anything. */
function empty(now = NOW) {
  const t = {};
  for (const id of Object.keys(devPlan.things)) {
    const ref = devPlan.things[id];
    t[id] = base(id, {
      freshness: 'unsensed', status: 'none', text: id === 'house' ? '' : 'No sensor',
      facts: id === 'house' ? [] : [{ label: 'Sensors', value: 'None installed', at: null }],
      ...(ref.kind === 'room' ? { temperature: null, humidity: null, occupied: null, alert: null, hvac: null, lit: 0 } : {}),
      ...(ref.kind === 'door' ? { open: null, position: null, locked: null, moving: null, exterior: !!ref.exterior } : {}),
      ...(ref.kind === 'window' ? { open: null, blind: null, exterior: true } : {}),
      ...(ref.kind === 'light' ? { on: null, level: null, colorTempK: null, rgb: null } : {}),
      ...(ref.kind === 'object' ? { running: null, present: null, charging: null, phase: null, progress: null, remainingMin: null, title: null } : {}),
      ...(ref.kind === 'camera' ? { motion: null, person: null, recording: null, lastMotionAt: null, feed: null, privacy: false, indoor: id === 'living_camera' } : {}),
    });
  }
  return {
    now, connection: 'live', snapshotAt: now, things: t, attention: [],
    summary: { headline: 'No security sensors', headlineStatus: 'none', lightsOn: 0, openCount: 0, people: [], alarm: null, outdoor: null, indoor: null },
  };
}

/** The hub dropped 43 minutes ago. Every sensed thing loses its claim. */
function offline(now = NOW + 43 * MIN) {
  const snapshotAt = NOW;
  const t = quiet(now);
  for (const x of Object.values(t)) {
    if (x.freshness === 'unsensed' || x.kind === 'house') continue;
    x.freshness = 'offline';
    x.status = 'unknown';
    x.text = 'Not connected';
    x.since = null;
    x.actions = [];
    x.facts = x.facts.map((f) => ({ ...f, lastKnown: true }));
    for (const k of ['on', 'colorTempK', 'open', 'position', 'locked', 'moving', 'blind', 'temperature', 'occupied', 'running', 'present', 'charging', 'motion', 'person', 'recording', 'lastMotionAt', 'lastPersonAt', 'phase', 'progress', 'remainingMin', 'title']) {
      if (k in x) x[k] = null;
    }
    if ('lit' in x) x.lit = 0;
    if (x.kind === 'camera') { x.feed = null; x.privacy = false; }   // a feed is a claim
  }
  return {
    now, connection: 'offline', snapshotAt, things: t, attention: [],
    summary: { headline: 'Not connected', headlineStatus: 'unknown', lightsOn: 0, openCount: 0, people: people(null, null), alarm: null, outdoor: null, indoor: null },
  };
}

/** First paint, before any state has arrived. */
function connecting(now = NOW) {
  const t = quiet(now);
  for (const x of Object.values(t)) {
    if (x.freshness === 'unsensed' || x.kind === 'house') continue;
    x.freshness = 'unknown';
    x.status = 'none';
    x.text = '';
    x.since = null;
    x.reportedAt = null;
    x.actions = [];
    x.facts = [];
    for (const k of ['on', 'open', 'position', 'locked', 'blind', 'temperature', 'occupied', 'running', 'present', 'charging', 'motion', 'person', 'recording', 'lastMotionAt', 'lastPersonAt', 'phase', 'progress', 'remainingMin', 'title']) {
      if (k in x) x[k] = null;
    }
    if (x.kind === 'camera') { x.feed = null; x.privacy = false; }
  }
  return {
    now, connection: 'connecting', snapshotAt: null, things: t, attention: [],
    summary: { headline: 'Connecting…', headlineStatus: 'none', lightsOn: 0, openCount: 0, people: [], alarm: null, outdoor: null, indoor: null },
  };
}

/** More than four things at once: exercises the "+N more" row. */
function busy(now = NOW) {
  const d = evening(now);
  const t = d.things;
  Object.assign(t.front_door, {
    status: 'attention', text: 'Open', since: now - 2 * MIN,
    facts: [{ label: 'Door', value: 'Open', at: now - 2 * MIN }, { label: 'Lock', value: 'Unlocked', at: now - 2 * MIN }],
    actions: [], open: true, position: 1, locked: false,
  });
  Object.assign(t.kitchen_window, { status: 'attention', text: 'Open', since: now - 3 * HOUR - 20 * MIN, facts: [{ label: 'Window', value: 'Open', at: now - 3 * HOUR - 20 * MIN }], open: true });
  Object.assign(t.living_window, { status: 'attention', text: 'Open', since: now - 55 * MIN, facts: [{ label: 'Window', value: 'Open', at: now - 55 * MIN }], open: true });
  Object.assign(t.laundry, {
    status: 'alert', text: 'Leak detected', since: now - 6 * MIN,
    facts: [{ label: 'Leak sensor', value: 'Wet', at: now - 6 * MIN }], alert: 'leak',
  });
  d.attention = [
    { id: 'laundry', severity: 'alert', text: 'Leak in Laundry', since: now - 6 * MIN, level: 'ground', room: 'laundry' },
    { id: 'kitchen_window', severity: 'attention', text: 'Kitchen window open', since: now - 3 * HOUR - 20 * MIN, level: 'ground', room: 'kitchen' },
    { id: 'living_window', severity: 'attention', text: 'Living room window open', since: now - 55 * MIN, level: 'ground', room: 'living' },
    d.attention[0],
    d.attention[1],
    { id: 'front_door', severity: 'attention', text: 'Front door open', since: now - 2 * MIN, level: 'ground', room: 'entry' },
  ];
  d.summary = summary('1 alert', 'alert', t);
  return d;
}

// ---- round 2: people, cameras, printer, consoles, motion ------------------------------

/** PersonState (CONTRACTS.md, Round 2). `room` is the phone's room and is null unless home and fresh. */
function person(id, name, now, o = {}) {
  const home = o.home === undefined ? true : o.home;
  const room = home === true && o.room ? o.room : null;
  const ref = room ? rooms.find((r) => r.id === room) : null;
  const battery = o.battery == null ? null : o.battery;
  const charging = o.charging == null ? null : o.charging;
  const since = now - (o.sinceAgo == null ? 2 * HOUR : o.sinceAgo);
  const facts = [{ label: 'Presence', value: home === true ? 'Home' : home === false ? 'Away' : 'No data', at: home === null ? null : since, unknown: home === null }];
  if (ref) facts.push({ label: 'Phone', value: `In ${ref.name}`, at: now - (o.roomAgo == null ? 12 * MIN : o.roomAgo), checkedAt: now - (o.roomChecked == null ? 2 * MIN : o.roomChecked) });
  if (battery != null) facts.push({ label: 'Phone battery', value: `${Math.round(battery * 100)}%`, at: now - 9 * MIN, checkedAt: now - 1 * MIN });
  if (charging != null) facts.push({ label: 'Charging', value: charging ? 'Charging' : 'Not charging', at: now - 3 * HOUR, checkedAt: now - 1 * MIN });
  return {
    id, name, home, room, roomName: ref ? ref.name : null, levelId: ref ? ref.level : null,
    battery, charging, batteryLow: battery != null && battery < 0.15 && charging !== true,
    freshness: home === null ? 'unknown' : 'fresh',
    text: ref ? ref.name : home === true ? 'Home' : home === false ? 'Away' : 'No data',
    since: home === null ? null : since, facts,
  };
}

/** Summary.people entries: the short form of the same people. */
function brief(list) {
  return list.map((p) => {
    const ref = p.room ? rooms.find((r) => r.id === p.room) : null;
    return { id: p.id, name: p.name, home: p.home, room: p.room, roomName: ref ? ref.name : null, battery: p.battery, batteryLow: p.batteryLow };
  });
}

function running(t, id, now, text, extra, agoMs) {
  Object.assign(t[id], {
    status: 'on', text, since: now - agoMs, reportedAt: now - 20 * 1000,
    facts: [
      { label: 'Status', value: extra.title ? 'Playing' : 'Printing', at: now - agoMs, checkedAt: now - 20 * 1000 },
      ...(extra.title ? [{ label: 'Playing', value: extra.title, at: null, checkedAt: now - 20 * 1000 }] : []),
      ...(extra.progress != null ? [{ label: 'Progress', value: `${Math.round(extra.progress * 100)}%`, at: now - 2 * MIN, checkedAt: now - 20 * 1000 }] : []),
      ...(extra.remainingMin != null ? [{ label: 'Time left', value: '1 h 35 min', at: now - 1 * MIN, checkedAt: now - 20 * 1000 }] : []),
    ],
    running: true, phase: 'running', ...extra,
  });
}

/** An ordinary evening with everyone's devices wired: phones, cameras, a print running, a game on. */
function household(now = NOW) {
  const d = evening(now);
  const t = d.things;
  running(t, 'printer', now, 'Printing 62%', { progress: 0.62, remainingMin: 95 }, 2 * HOUR + 31 * MIN);
  running(t, 'console', now, 'Playing Hades', { title: 'Hades' }, 47 * MIN);
  running(t, 'living_tv', now, 'Playing The Great British Bake Off: An Extra Slice', { title: 'The Great British Bake Off: An Extra Slice' }, 47 * MIN);
  Object.assign(t.driveway_camera, { status: 'on', text: 'Motion', since: now - 20 * 1000, motion: true, lastMotionAt: now - 20 * 1000 });
  t.driveway_camera.facts[1] = { label: 'Motion', value: 'Detected', at: now - 20 * 1000, checkedAt: now - 20 * 1000 };
  // People are home: the indoor camera's lens is shut on purpose. Not a fault, and no picture.
  Object.assign(t.living_camera, {
    status: 'none', text: 'Privacy', since: now - 3 * HOUR, privacy: true, feed: null,
    facts: [{ label: 'Camera', value: 'Privacy', at: now - 3 * HOUR, checkedAt: now - 20 * 1000 }],
    motion: null, person: null, recording: false, lastMotionAt: null, lastPersonAt: null,
  });
  Object.assign(t.kitchen, { motion: false, lastMotionAt: now - 4 * MIN, active: false });
  t.kitchen.facts.push({ label: 'Motion', value: 'Clear', at: now - 4 * MIN, checkedAt: now - 30 * 1000 });
  Object.assign(t.living, { motion: true, lastMotionAt: now - 10 * 1000, active: true });
  t.living.facts.push({ label: 'Motion', value: 'Detected', at: now - 10 * 1000, checkedAt: now - 10 * 1000 });
  d.people = [
    person('josh', 'Josh', now, { room: 'study', battery: 0.62, charging: false }),
    person('sam', 'Sam', now, { room: 'living', battery: 0.11, charging: false, sinceAgo: 5 * HOUR, roomAgo: 40 * MIN, roomChecked: 30 * 1000 }),
    person('alex', 'Alex', now, { home: false, battery: 0.8, charging: false, sinceAgo: 3 * HOUR + 12 * MIN }),
  ];
  d.summary.people = brief(d.people);
  return d;
}

/** Everyone out, alarm armed: motion and a person at a camera now matter; one camera is offline; a print finished. */
function away(now = NOW) {
  const t = quiet(now);
  Object.assign(t.porch_camera, {
    status: 'attention', text: 'Person', since: now - 1 * MIN, motion: true, person: true, recording: true,
    lastMotionAt: now - 1 * MIN, lastPersonAt: now - 1 * MIN,
    facts: [
      { label: 'Camera', value: 'Recording', at: now - 1 * MIN, checkedAt: now - 20 * 1000 },
      { label: 'Motion', value: 'Detected', at: now - 1 * MIN, checkedAt: now - 20 * 1000 },
      { label: 'Person', value: 'In view', at: now - 1 * MIN, checkedAt: now - 20 * 1000 },
    ],
  });
  Object.assign(t.driveway_camera, {
    freshness: 'unknown', status: 'unknown', text: 'Offline', reason: 'offline', since: null, reportedAt: now - 3 * HOUR - 5 * MIN,
    facts: [{ label: 'Camera', value: 'Idle', at: now - 3 * HOUR - 5 * MIN, lastKnown: true }],
    motion: null, person: null, recording: null, lastMotionAt: null, lastPersonAt: null, feed: null,
  });
  Object.assign(t.garage, { status: 'attention', text: 'Motion', since: now - 2 * MIN, motion: true, lastMotionAt: now - 2 * MIN, active: true });
  Object.assign(t.printer, {
    status: 'off', text: 'Print finished', since: now - 25 * MIN, reportedAt: now - 1 * MIN,
    facts: [{ label: 'Printer', value: 'Finished', at: now - 25 * MIN }],
    running: false, phase: 'done', progress: 1, remainingMin: 0,
  });
  const people = [
    person('josh', 'Josh', now, { home: false, battery: 0.09, charging: false, sinceAgo: 95 * MIN }),
    person('sam', 'Sam', now, { home: false, battery: 0.54, charging: true, sinceAgo: 95 * MIN }),
    person('alex', 'Alex', now, { home: null }),
  ];
  const attention = [
    { id: 'porch_camera', severity: 'attention', text: 'Person at Front porch camera', since: now - 1 * MIN, level: 'ground', room: 'entry' },
    { id: 'garage', severity: 'attention', text: 'Motion in Garage', since: now - 2 * MIN, level: 'ground', room: 'garage' },
    { id: 'driveway_camera', severity: 'unknown', reason: 'offline', text: 'Driveway camera: offline', since: now - 3 * HOUR - 5 * MIN, level: 'ground', room: 'garage' },
    { id: 'printer', severity: 'info', text: '3D printer: print finished', since: now - 25 * MIN, level: 'first', room: 'study' },
  ];
  return {
    now, connection: 'live', snapshotAt: now, things: t, attention, people,
    summary: summary('3 need attention', 'attention', t, { people: brief(people), alarm: 'armed_away' }),
  };
}

/** A quiet house whose only news is a notice: listed, but the headline stays as it was. */
function notice(now = NOW) {
  const d = secure(now);
  Object.assign(d.things.printer, {
    status: 'off', text: 'Print finished', since: now - 25 * MIN, reportedAt: now - 1 * MIN,
    facts: [{ label: 'Printer', value: 'Finished', at: now - 25 * MIN }],
    running: false, phase: 'done', progress: 1, remainingMin: 0,
  });
  d.attention = [{ id: 'printer', severity: 'info', text: '3D printer: print finished', since: now - 25 * MIN, level: 'first', room: 'study' }];
  d.people = [person('josh', 'Josh', now, { room: 'study', battery: 0.62, charging: true })];
  d.summary.people = brief(d.people);
  return d;
}

/** name → (now?) → Derived. Each call builds a fresh object. */
export const devFixtures = { evening, secure, alert, stale, empty, offline, connecting, busy, household, away, notice };


/** @param {string} name */
export function makeFixture(name, now) {
  const fn = devFixtures[name];
  if (!fn) throw new Error(`Unknown fixture "${name}". Known: ${Object.keys(devFixtures).join(', ')}`);
  return fn(now);
}
