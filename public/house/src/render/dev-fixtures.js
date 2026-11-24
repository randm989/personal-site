// Hand-built Derived objects for dev/render.html and tests/render.test.js. Only the fields the renderer
// reads are faithful (CONTRACTS §2 and "Round 2"); texts and facts are placeholders. Nothing here imports
// src/state/.
//
// The claims below name ids from both houses (data/house.json and data/placeholder/house.json). An id the
// loaded plan does not have is simply ignored, so the same fixtures drive either house.
//
// Note the contract's naming: a thing's storey is `levelId`; on a light, `level` is brightness 0..1.

const NOW = new Date(2026, 10, 23, 21, 4, 0).getTime();

function base(plan, id) {
  const t = plan.things[id];
  const s = {
    id, kind: t.kind, name: t.name, levelId: t.level, room: t.room,
    freshness: 'unsensed', status: 'none', text: 'No sensor', since: null, reportedAt: null, facts: [], actions: [],
  };
  if (t.kind === 'light') Object.assign(s, { on: null, level: null, colorTempK: null, rgb: null });
  if (t.kind === 'door') Object.assign(s, { open: null, position: null, locked: null, moving: null, exterior: !!t.exterior });
  if (t.kind === 'window') Object.assign(s, { open: null, blind: null, exterior: !!t.exterior });
  if (t.kind === 'room') Object.assign(s, { temperature: null, humidity: null, occupied: null, alert: null, hvac: null, lit: 0, motion: null, lastMotionAt: null, active: false });
  if (t.kind === 'object') Object.assign(s, { running: null, present: null, charging: null, phase: null, progress: null, remainingMin: null, title: null });
  if (t.kind === 'camera') {
    // Round 3: feed is a claim (null unless the camera is fresh, not in privacy and has a picture)
    const f = plan.fixtures.find((x) => x.id === id);
    Object.assign(s, { motion: null, person: null, recording: null, lastMotionAt: null, feed: null, privacy: false, indoor: !!(f && f.indoor) });
  }
  return s;
}

const SENSED_ROOMS = [
  'kitchen', 'living', 'entry', 'primary_bedroom',                       // placeholder house
  'family', 'loft', 'garage', 'driveway', 'terrace', 'deck', 'study',    // real house
];
const BLINDS = ['living_window_1', 'living_window_2', 'dining_window', 'primary_bedroom_window_1', 'bedroom_2_window',
  'primary_bedroom_window_back', 'family_window_1', 'family_window_2'];

/** Which things have a device in the demo house, and their resting (fresh, quiet) claims. */
function sensed(plan) {
  const out = {};
  for (const [id, t] of Object.entries(plan.things)) {
    if (t.kind === 'light') out[id] = { on: false, level: 0 };
    else if (t.kind === 'door' && t.exterior) out[id] = { open: false, position: 0, locked: id === 'front_door' ? true : null };
    else if (t.kind === 'window' && t.exterior) out[id] = { open: false };
    else if (t.kind === 'object') out[id] = /car/.test(id) ? { present: true, charging: false } : { running: false, phase: 'idle' };
    else if (t.kind === 'camera') out[id] = { motion: false, person: false, recording: false, status: 'off' };
  }
  for (const id of BLINDS) if (out[id]) out[id].blind = 1;
  for (const id of SENSED_ROOMS) if (plan.things[id]) out[id] = { occupied: false, motion: false, active: false };
  if (plan.things.laundry) out.laundry = { alert: null };
  return out;
}

function person(plan, id, name, room, extra = {}) {
  const ok = !!room && plan.things[room] && plan.things[room].kind === 'room';
  return {
    id, name, home: true, room: ok ? room : null, levelId: ok ? plan.things[room].level : null,
    battery: 0.64, charging: false, batteryLow: false, freshness: 'fresh',
    text: ok ? plan.things[room].name : 'Home', since: NOW - 20 * 60000, facts: [], ...extra,
  };
}

/** The first of these room ids the plan has. */
const firstRoom = (plan, ...ids) => ids.find((id) => plan.things[id] && plan.things[id].kind === 'room') || null;

function build(plan, { connection = 'live', claims = {}, lost = {}, bare = false, attention = [], people = [] } = {}) {
  const things = {};
  const rest = bare ? {} : sensed(plan);
  for (const id of Object.keys(plan.things)) {
    const s = base(plan, id);
    if (rest[id]) {
      if (connection === 'offline') {
        s.freshness = 'offline'; s.status = 'unknown'; s.text = 'Offline';
      } else if (lost[id]) {
        s.freshness = lost[id]; s.status = 'unknown'; s.text = 'No data';
      } else {
        s.freshness = 'fresh'; s.text = '';
        Object.assign(s, rest[id], claims[id] || {});
        if (s.kind === 'light' && s.on) s.status = 'on';
        if (s.kind === 'room') s.active = s.occupied === true || s.motion === true;
        if (s.kind === 'object' && s.running === true && (!claims[id] || claims[id].phase == null)) s.phase = 'running';
        if (s.kind === 'camera' && (!claims[id] || claims[id].status == null)) s.status = s.motion || s.person ? 'on' : 'off';
        if (s.kind === 'camera') {
          // the simulator's cameras all have a simulated picture, unless the lens is shut on purpose
          if (s.privacy) Object.assign(s, { feed: null, status: 'none', text: 'Privacy', motion: null, person: null });
          else if (!claims[id] || claims[id].feed === undefined) s.feed = { url: 'sim:' + id, simulated: true, at: NOW };
        }
      }
    }
    things[id] = s;
  }
  // room.lit = brightest light that is on in it
  for (const f of plan.fixtures) {
    const s = things[f.id];
    if (s && s.on && things[f.room]) things[f.room].lit = Math.max(things[f.room].lit, s.level ?? 1);
  }
  const who = people.map((p) => (connection === 'offline' ? { ...p, room: null, levelId: null, freshness: 'offline', text: 'No data' } : p));
  return {
    now: NOW, connection, snapshotAt: NOW - (connection === 'offline' ? 40 * 60000 : 0), things, attention, people: who,
    summary: { headline: '', headlineStatus: 'none', lightsOn: 0, openCount: 0, people: [], alarm: null, outdoor: null, indoor: null },
  };
}

const on = (level, colorTempK = 2700, extra = {}) => ({ on: true, level, colorTempK, ...extra });

const EVENING = {
  // placeholder house
  kitchen_light: on(0.75, 3000), kitchen_island_light: on(1, 2700), kitchen_strip: on(0.7, 3000),
  dining_light: on(0.55, 2200), living_light_1: on(0.45, 2700), living_lamp: on(0.9, 2200),
  entry_light: on(0.7, 2700), porch_light: on(1, 2700), garage_light: on(0.6, 4000),
  primary_bedroom_lamp: on(0.6, 2200), landing_light: on(0.35, 2700),
  garage_door: { open: true, position: 1 },
  front_door: { open: false, position: 0, locked: true },
  back_door: { open: true, position: 1 },
  kitchen_window: { open: true },
  living_window_1: { open: false, blind: 0.5 },
  primary_bedroom_window_1: { open: false, blind: 0.3 },
  kitchen: { occupied: true }, living: { occupied: true },
  car_bay_1: { present: true, charging: true }, car_bay_2: { present: false, charging: false },
  tv: { running: true }, washer: { running: true },
  // real house
  family_light: on(0.5, 2700), family_lamp: on(0.9, 2200), breakfast_light: on(0.5, 2700), hall_light: on(0.4, 2700),
  foyer_light: on(0.6, 2700), driveway_light: on(0.8, 3000), deck_light: on(0.7, 2700),
  loft_light: on(0.45, 2700), loft_lamp: on(0.85, 2200), study_light: on(0.7, 4000),
  family: { occupied: true }, loft: { occupied: true }, driveway: { motion: true }, deck: { motion: true },
  primary_bedroom_window_back: { open: false, blind: 0.3 },
  tv_family: { running: true, title: 'Hades' }, console_playstation: { running: true, title: 'Hades' },
  tv_loft: { running: true }, console_switch: { running: true },
  printer_3d: { running: true, phase: 'running', progress: 0.62, remainingMin: 48 },
  camera_driveway: { motion: true, recording: true }, camera_front_door: { motion: true, person: true, recording: true },
  camera_loft: { privacy: true },        // the game room camera has its lens shut in the evening
};

const QUIET = {
  living_lamp: on(0.3, 2200), primary_bedroom_lamp: on(0.25, 2200), family_lamp: on(0.3, 2200),
  living_window_1: { open: false, blind: 0 }, living_window_2: { open: false, blind: 0 }, dining_window: { open: false, blind: 0 },
  primary_bedroom_window_1: { open: false, blind: 0 }, bedroom_2_window: { open: false, blind: 0 },
  primary_bedroom_window_back: { open: false, blind: 0 },
  printer_3d: { running: false, phase: 'done', progress: 1 },
};

export const FIXTURE_NAMES = ['evening', 'quiet', 'alert', 'stale', 'empty', 'offline'];

/** @returns {Object<string, object>} name -> Derived */
export function makeFixtures(plan) {
  const lounge = firstRoom(plan, 'family', 'living'), den = firstRoom(plan, 'loft', 'office', 'bedroom_2');
  const cook = firstRoom(plan, 'kitchen'), bed = firstRoom(plan, 'primary_bedroom');
  const evening = [
    person(plan, 'josh', 'Josh', lounge), person(plan, 'sam', 'Sam', lounge),
    person(plan, 'riley', 'Riley', den, { battery: 0.11, batteryLow: true }),
    person(plan, 'alex', 'Alex', cook),
    person(plan, 'morgan', 'Morgan', null, { home: false, text: 'Away' }),
  ];
  return {
    evening: build(plan, {
      claims: EVENING, people: evening,
      attention: [{ id: 'garage_door', severity: 'attention', text: 'Garage door open', since: NOW - 14 * 60000, level: 'ground', room: 'garage' }],
    }),
    quiet: build(plan, { claims: QUIET, people: [person(plan, 'josh', 'Josh', bed), person(plan, 'sam', 'Sam', bed)] }),
    alert: build(plan, {
      claims: {
        ...QUIET, laundry: { alert: 'leak' }, laundry_light: on(0.8, 4000), entry_light: on(0.5, 2700), foyer_light: on(0.5, 2700), washer: { running: true },
        // armed away: a person at a camera and motion in a room are attention now
        camera_driveway: { motion: true, person: true, recording: true, status: 'attention' }, garage: { motion: true },
        printer_3d: { running: false, phase: 'error', progress: 0.4 },
      },
      attention: [
        { id: 'laundry', severity: 'alert', text: 'Leak detected', since: NOW - 3 * 60000, level: 'ground', room: 'laundry' },
        { id: 'camera_driveway', severity: 'attention', text: 'Person at Driveway camera', since: NOW - 60000, level: 'ground', room: 'driveway' },
      ],
    }),
    stale: build(plan, {
      claims: {
        ...EVENING, garage_door: { open: false, position: 0 }, back_door: { open: false, position: 0 },
        printer_3d: { running: false, phase: 'paused', progress: 0.62 },
      },
      lost: { front_door: 'stale', kitchen_window: 'unknown', office_light: 'unknown', bedroom_2_light: 'stale', car_bay_2: 'unknown', camera_backyard: 'unknown', camera_front_door: 'stale' },
      // a phone that stopped reporting its room: home, but no figure
      people: [person(plan, 'josh', 'Josh', lounge), person(plan, 'sam', 'Sam', null, { freshness: 'stale', text: 'Home' })],
      attention: [{ id: 'front_door', severity: 'unknown', text: 'Front door: no data', since: null, level: 'ground', room: 'entry' }],
    }),
    empty: build(plan, { bare: true }),
    offline: build(plan, { connection: 'offline', claims: EVENING, people: evening }),
  };
}

/** A copy of a Derived with some claims changed, for the dev page's keyboard toggles. */
export function patchDerived(derived, changes) {
  const things = { ...derived.things };
  for (const [id, c] of Object.entries(changes)) if (things[id]) things[id] = { ...things[id], ...c };
  return { ...derived, things };
}
