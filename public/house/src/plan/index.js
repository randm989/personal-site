// The plan compiler: data/house.json (authored) -> CompiledPlan. See docs/CONTRACTS.md §1.
// Pure: no DOM and no three.js in compilePlan / wallPieces / footprints. Only loadPlan touches fetch.
//
// Conventions decided here (the contract leaves them open):
//
// * Winding. Room polygons are normalised to counter-clockwise AS SEEN ON THE PAGE, where x grows right
//   and y grows down. In numbers: the standard shoelace sum(x_i*y_{i+1} - x_{i+1}*y_i) is NEGATIVE.
//   (In 3D with X = x, Z = y, Y up, that is counter-clockwise when looking straight down on the house.)
//
// * Walls run a -> b in a canonical direction: increasing x, or increasing y for walls that run straight
//   down the page. `dir` is the unit vector a -> b; the wall's side normal is n = [-dir.y, dir.x]
//   (a wall running east has n pointing south; a wall running south has n pointing west).
//   wall.rooms[0] is the indoor room on the -n side, wall.rooms[1] the indoor room on the +n side.
//   An exterior wall has null on its outside, even when an outdoor room (porch, patio) is there.
//   opening.rooms uses the same two sides but DOES name an outdoor room when one is at the opening.
//
// * Object rotation r: local x points along [cos r, sin r], local y along [-sin r, cos r] in plan coords.
//
// Fields added beyond the contract: Wall.height, Wall.dir, Opening.opensInto, Fixture.length/rotation
// (pass-through for strips), Room.height, and the extra export footprints().

import {
  EPS, round6, signedArea, polygonBounds, unionBounds, distToSegment, pointInPolygon,
  labelPoint, selfIntersects, polygonsOverlap, rectCorners,
} from './geometry.js';

const SNAP_DISTANCE = 0.3;
const MOUNT_HEIGHT = { lamp: 1.4, strip: 0.9, exterior: 2.2 };   // ceiling = level height - 0.05
const DOOR_STYLES = ['hinged', 'sliding', 'garage'];
const CAMERA_DEFAULTS = { fov: 90, range: 6 };
// Room, object and fixture `type` are free text for styling: an unknown value is never a problem.

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isPoint = (p) => Array.isArray(p) && p.length >= 2 && isNum(p[0]) && isNum(p[1]);
const fmt = (p) => `[${round6(p[0])}, ${round6(p[1])}]`;

/**
 * @param {object} house  the authored plan (CONTRACTS §1)
 * @returns {object} CompiledPlan. Never throws on bad input: everything wrong is listed in `problems`.
 */
export function compilePlan(house) {
  const problems = [];
  const said = new Set();
  const say = (m) => { if (!said.has(m)) { said.add(m); problems.push(m); } };

  const plan = {
    name: 'House',
    bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    levels: [], rooms: [], walls: [], posts: [], openings: [], fixtures: [], objects: [],
    things: {}, problems,
  };
  if (!house || typeof house !== 'object') {
    say('The plan is not an object.');
    return plan;
  }
  plan.name = typeof house.name === 'string' && house.name ? house.name : 'House';
  if (house.compass !== undefined) plan.compass = house.compass;   // informational, passed through untouched

  const thick = {
    exterior: isNum(house.wall?.exterior) && house.wall.exterior > 0 ? house.wall.exterior : 0.25,
    interior: isNum(house.wall?.interior) && house.wall.interior > 0 ? house.wall.interior : 0.12,
  };

  // One id space for rooms, openings, fixtures and objects, because `things` is one index.
  const owners = new Map();
  const claim = (id, what) => {
    if (typeof id !== 'string' || !id) { say(`A ${what} has no id.`); return false; }
    if (id === 'house') { say(`The id "house" is reserved for the whole house, but a ${what} uses it.`); return false; }
    if (owners.has(id)) { say(`Duplicate id "${id}": used by a ${owners.get(id)} and a ${what}.`); return false; }
    owners.set(id, what);
    return true;
  };

  // ---- levels and rooms -------------------------------------------------------------------------
  const levelById = new Map();
  const roomById = new Map();
  const rawLevels = Array.isArray(house.levels) ? house.levels : [];
  if (!rawLevels.length) say('The plan has no levels.');
  const ordered = rawLevels
    .map((raw, index) => ({ raw, index }))
    .sort((p, q) => ((isNum(p.raw?.elevation) ? p.raw.elevation : 0) - (isNum(q.raw?.elevation) ? q.raw.elevation : 0)) || (p.index - q.index));

  for (const { raw } of ordered) {
    if (!raw || typeof raw.id !== 'string' || !raw.id) { say('A level has no id.'); continue; }
    if (levelById.has(raw.id)) { say(`Duplicate level id "${raw.id}".`); continue; }
    if (!isNum(raw.height) || raw.height <= 0) say(`Level "${raw.id}" needs a positive height.`);
    const level = {
      id: raw.id,
      name: raw.name || raw.id,
      short: raw.short != null ? String(raw.short) : raw.id.slice(0, 1).toUpperCase(),
      elevation: isNum(raw.elevation) ? raw.elevation : 0,
      height: isNum(raw.height) && raw.height > 0 ? raw.height : 2.6,
      bounds: null,
    };
    levelById.set(level.id, level);
    plan.levels.push(level);

    const levelRooms = [];
    for (const rr of Array.isArray(raw.rooms) ? raw.rooms : []) {
      if (!rr || !claim(rr.id, 'room')) continue;
      const polygon = cleanPolygon(rr.polygon);
      if (!polygon) {
        owners.delete(rr.id);
        say(`Room "${rr.id}" needs a polygon of at least three [x, y] points.`);
        continue;
      }
      if (selfIntersects(polygon)) say(`Room "${rr.id}" has an outline that crosses itself.`);
      const signed = signedArea(polygon);
      if (Math.abs(signed) < 1e-6) say(`Room "${rr.id}" has no area.`);
      if (signed > 0) polygon.reverse();   // clockwise on the page -> make it counter-clockwise on the page
      const room = {
        id: rr.id,
        name: rr.name || rr.id,
        type: rr.type || 'room',
        level: level.id,
        outdoor: rr.outdoor === true,
        polygon,
        area: round6(Math.abs(signed)),
        centroid: labelPoint(polygon),
        bounds: polygonBounds(polygon),
        height: level.height,
      };
      roomById.set(room.id, room);
      levelRooms.push(room);
      plan.rooms.push(room);
    }
    level.bounds = unionBounds(levelRooms.map((r) => r.bounds));
    if (!levelRooms.some((r) => !r.outdoor)) say(`Level "${level.id}" has no indoor rooms.`);

    for (let i = 0; i < levelRooms.length; i++) {
      for (let j = i + 1; j < levelRooms.length; j++) {
        if (polygonsOverlap(levelRooms[i].polygon, levelRooms[j].polygon)) {
          say(`Rooms "${levelRooms[i].id}" and "${levelRooms[j].id}" overlap on level "${level.id}".`);
        }
      }
    }

    const derived = deriveWalls(level, levelRooms.filter((r) => !r.outdoor), thick, say);
    plan.walls.push(...derived.walls);
    plan.posts.push(...derived.posts);
  }
  plan.bounds = unionBounds(plan.levels.map((l) => l.bounds));

  // ---- openings ---------------------------------------------------------------------------------
  for (const ro of Array.isArray(house.openings) ? house.openings : []) {
    if (!ro) continue;
    const type = ro.type;
    const what = type === 'window' ? 'window' : type === 'gap' ? 'gap' : 'door';
    if (!claim(ro.id, what)) continue;
    const fail = (m) => { owners.delete(ro.id); say(m); };
    if (type !== 'door' && type !== 'window' && type !== 'gap') { fail(`Opening "${ro.id}" has unknown type "${type}" (use door, window or gap).`); continue; }
    const level = levelById.get(ro.level);
    if (!level) { fail(`Opening "${ro.id}" refers to unknown level "${ro.level}".`); continue; }
    if (!isPoint(ro.at)) { fail(`Opening "${ro.id}" needs an "at" point.`); continue; }
    if (!isNum(ro.width) || ro.width <= 0) { fail(`Opening "${ro.id}" needs a positive width.`); continue; }
    let style = null;
    if (type === 'door') {
      style = ro.style || 'hinged';
      if (!DOOR_STYLES.includes(style)) { say(`Door "${ro.id}" has unknown style "${style}"; drawn as hinged.`); style = 'hinged'; }
    }

    // Snap to the nearest wall on the level. Among walls within reach, prefer one the opening fits in.
    const at = [ro.at[0], ro.at[1]];
    let best = null;
    for (const wall of plan.walls) {
      if (wall.level !== level.id) continue;
      const d = distToSegment(at, wall.a, wall.b);
      if (d > SNAP_DISTANCE + EPS) continue;
      const s = (at[0] - wall.a[0]) * wall.dir[0] + (at[1] - wall.a[1]) * wall.dir[1];
      const fits = s - ro.width / 2 >= wall.spanFrom - EPS && s + ro.width / 2 <= wall.spanTo + EPS;
      const cand = { wall, d, s, fits };
      if (!best || (cand.fits && !best.fits) || (cand.fits === best.fits && d < best.d - EPS)) best = cand;
    }
    if (!best) {
      fail(`Opening "${ro.id}" at ${fmt(at)} is not on a wall: nothing within ${SNAP_DISTANCE} m on level "${level.id}".`);
      continue;
    }
    const wall = best.wall;
    let from = best.s - ro.width / 2;
    let to = best.s + ro.width / 2;
    if (type === 'gap') {
      // A gap means "no wall here": it is clamped to the wall's own span rather than rejected.
      from = Math.max(from, wall.spanFrom);
      to = Math.min(to, wall.spanTo);
      if (to - from < 0.01) { fail(`Gap "${ro.id}" at ${fmt(at)} does not cover any wall.`); continue; }
    } else if (!best.fits) {
      fail(`Opening "${ro.id}" (${round6(ro.width)} m wide) does not fit in its wall at ${fmt(at)}: the wall has room from ${round6(wall.spanFrom)} to ${round6(wall.spanTo)} m but the opening needs ${round6(from)} to ${round6(to)} m.`);
      continue;
    }
    const clash = wall.openings.find((o) => from < o.to - EPS && to > o.from + EPS);
    if (clash) { fail(`Openings "${ro.id}" and "${clash.id}" overlap on the same wall.`); continue; }

    const defaults = type === 'window' ? { sill: 0.9, head: 2.1 }
      : type === 'gap' ? { sill: 0, head: level.height }
      : { sill: 0, head: style === 'garage' ? 2.2 : 2.05 };
    let sill = isNum(ro.sill) ? ro.sill : defaults.sill;
    let head = isNum(ro.head) ? ro.head : defaults.head;
    if (head > level.height + EPS) { say(`Opening "${ro.id}" has its head at ${head} m, above the ${level.height} m storey; lowered to fit.`); head = level.height; }
    if (sill < 0 || sill >= head) { say(`Opening "${ro.id}" has a sill (${sill}) that is not below its head (${head}).`); sill = defaults.sill; }

    const mid = (from + to) / 2;
    const width = to - from;
    const dir = wall.dir;
    const n = [-dir[1], dir[0]];
    const center = [round6(wall.a[0] + dir[0] * mid), round6(wall.a[1] + dir[1] * mid)];

    // Who is on each side here: the wall's indoor rooms, or an outdoor room standing at the opening.
    const reach = wall.thickness / 2 + 0.2;
    const sideRoom = (index, sign) => {
      if (wall.rooms[index]) return wall.rooms[index];
      const probe = [center[0] + n[0] * reach * sign, center[1] + n[1] * reach * sign];
      const out = plan.rooms.find((r) => r.level === level.id && r.outdoor && pointInPolygon(probe, r.polygon));
      return out ? out.id : null;
    };
    const rooms = [sideRoom(0, -1), sideRoom(1, 1)];

    let sign = 0;
    let opensInto = null;
    if (ro.opensInto != null) {
      if (!roomById.has(ro.opensInto)) say(`Opening "${ro.id}" opens into unknown room "${ro.opensInto}".`);
      else if (rooms[1] === ro.opensInto) { sign = 1; opensInto = ro.opensInto; }
      else if (rooms[0] === ro.opensInto) { sign = -1; opensInto = ro.opensInto; }
      else say(`Opening "${ro.id}" is said to open into "${ro.opensInto}", but that room is not on either side of its wall.`);
    }
    if (!sign) {
      // No (valid) opensInto: point to the indoor side of an exterior wall; for an interior wall, to rooms[1].
      sign = wall.exterior ? (wall.rooms[1] ? 1 : -1) : 1;
    }
    const normal = [round6(n[0] * sign), round6(n[1] * sign)];

    let hingeEnd = 'from';
    if (isPoint(ro.hinge)) {
      const sh = (ro.hinge[0] - wall.a[0]) * dir[0] + (ro.hinge[1] - wall.a[1]) * dir[1];
      hingeEnd = sh > mid ? 'to' : 'from';
    }

    wall.openings.push({ id: ro.id, from: round6(from), to: round6(to), sill, head });
    wall.openings.sort((p, q) => p.from - q.from);
    plan.openings.push({
      id: ro.id,
      name: ro.name || ro.id,
      type, style,
      level: level.id,
      wall: wall.id,
      center, width: round6(width), sill, head,
      dir: [dir[0], dir[1]],
      normal, hingeEnd,
      exterior: wall.exterior,
      rooms,
      opensInto,
    });
  }

  // ---- fixtures ---------------------------------------------------------------------------------
  for (const rf of Array.isArray(house.fixtures) ? house.fixtures : []) {
    if (!rf || !claim(rf.id, 'fixture')) continue;
    const fail = (m) => { owners.delete(rf.id); say(m); };
    const room = roomById.get(rf.room);
    if (!room) { fail(`Fixture "${rf.id}" refers to unknown room "${rf.room}".`); continue; }
    if (!isPoint(rf.at)) { fail(`Fixture "${rf.id}" needs an "at" point.`); continue; }
    const level = levelById.get(room.level);
    const mount = rf.mount || 'ceiling';
    if (mount !== 'ceiling' && !(mount in MOUNT_HEIGHT)) say(`Fixture "${rf.id}" has unknown mount "${mount}" (use ceiling, lamp, strip or exterior).`);
    if (!pointInPolygon(rf.at, room.polygon)) say(`Fixture "${rf.id}" at ${fmt(rf.at)} is outside its room "${room.id}".`);
    const fixture = {
      id: rf.id,
      name: rf.name || rf.id,
      type: rf.type || 'light',
      mount,
      level: room.level,
      room: room.id,
      at: [rf.at[0], rf.at[1]],
      height: isNum(rf.height) ? rf.height : (MOUNT_HEIGHT[mount] ?? round6(level.height - 0.05)),
    };
    fixture.z = fixture.height;   // Round 2 name for the mounting height; `height` stays for round 1 readers
    if (isNum(rf.length)) fixture.length = rf.length;
    if (isNum(rf.rotation)) fixture.rotation = rf.rotation;
    if (fixture.type === 'camera') {
      // Looks along local +y = [-sin r, cos r]; fov in degrees, range in metres.
      fixture.rotation = isNum(rf.rotation) ? rf.rotation : 0;
      fixture.fov = isNum(rf.fov) && rf.fov > 0 ? Math.min(rf.fov, 360) : CAMERA_DEFAULTS.fov;
      fixture.range = isNum(rf.range) && rf.range > 0 ? rf.range : CAMERA_DEFAULTS.range;
      // Round 3: the lens pose, for projecting the camera's picture onto the model.
      // pitch = degrees below horizontal; aspect = picture width / height; indoor = a camera inside the house.
      fixture.pitch = isNum(rf.pitch) ? Math.max(0, Math.min(rf.pitch, 90)) : 30;
      fixture.aspect = isNum(rf.aspect) && rf.aspect > 0 ? rf.aspect : 16 / 9;
      fixture.indoor = typeof rf.indoor === 'boolean' ? rf.indoor : mount !== 'exterior';
    }
    plan.fixtures.push(fixture);
  }

  // ---- objects ----------------------------------------------------------------------------------
  for (const rob of Array.isArray(house.objects) ? house.objects : []) {
    if (!rob || !claim(rob.id, 'object')) continue;
    const fail = (m) => { owners.delete(rob.id); say(m); };
    const room = roomById.get(rob.room);
    if (!room) { fail(`Object "${rob.id}" refers to unknown room "${rob.room}".`); continue; }
    if (!isPoint(rob.at)) { fail(`Object "${rob.id}" needs an "at" point.`); continue; }
    if (!Array.isArray(rob.size) || rob.size.length !== 3 || !rob.size.every((v) => isNum(v) && v > 0)) {
      fail(`Object "${rob.id}" needs a size of [width, depth, height] in metres.`);
      continue;
    }
    let role = rob.role ?? null;
    if (role !== null && role !== 'appliance' && role !== 'vehicle') {
      say(`Object "${rob.id}" has unknown role "${role}" (use appliance or vehicle).`);
      role = null;
    }
    const rotation = isNum(rob.rotation) ? rob.rotation : 0;
    const corners = rectCorners(rob.at, rob.size, rotation);
    if (![rob.at, ...corners].every((p) => pointInPolygon(p, room.polygon, 1e-4))) {
      say(`Object "${rob.id}" does not sit inside its room "${room.id}".`);
    } else {
      const hit = plan.walls.find((w) => w.level === room.level && corners.some((p) => insideWallMass(p, w)));
      if (hit) say(`Object "${rob.id}" in "${room.id}" pokes into a wall.`);
    }
    plan.objects.push({
      id: rob.id,
      name: rob.name || rob.id,
      type: rob.type || 'box',
      role,
      level: room.level,
      room: room.id,
      at: [rob.at[0], rob.at[1]],
      size: [rob.size[0], rob.size[1], rob.size[2]],
      rotation,
    });
  }

  // ---- things -----------------------------------------------------------------------------------
  const things = plan.things;
  for (const r of plan.rooms) things[r.id] = { id: r.id, kind: 'room', name: r.name, level: r.level, room: r.id };
  for (const o of plan.openings) {
    if (o.type === 'gap') continue;
    const indoor = o.rooms.find((id) => id && !roomById.get(id).outdoor) ?? null;
    things[o.id] = {
      id: o.id, kind: o.type, name: o.name, level: o.level,
      room: o.exterior ? (indoor ?? o.rooms.find(Boolean) ?? null) : (o.opensInto ?? indoor),
      exterior: o.exterior,
    };
  }
  for (const f of plan.fixtures) {
    if (f.type === 'light' || f.type === 'camera') things[f.id] = { id: f.id, kind: f.type, name: f.name, level: f.level, room: f.room };
  }
  for (const ob of plan.objects) {
    if (ob.role) things[ob.id] = { id: ob.id, kind: 'object', name: ob.name, level: ob.level, room: ob.room };
  }
  things.house = { id: 'house', kind: 'house', name: plan.name, level: null, room: null };

  return plan;
}

/** Drop repeated and closing points; null when what is left is not a polygon. */
function cleanPolygon(raw) {
  if (!Array.isArray(raw)) return null;
  const pts = [];
  for (const p of raw) {
    if (!isPoint(p)) return null;
    const last = pts[pts.length - 1];
    if (last && Math.abs(last[0] - p[0]) < EPS && Math.abs(last[1] - p[1]) < EPS) continue;
    pts.push([p[0], p[1]]);
  }
  if (pts.length > 1) {
    const f = pts[0], l = pts[pts.length - 1];
    if (Math.abs(f[0] - l[0]) < EPS && Math.abs(f[1] - l[1]) < EPS) pts.pop();
  }
  return pts.length >= 3 ? pts : null;
}

/** Is the point inside the solid part of a wall (ignoring the stretch removed by a gap)? */
function insideWallMass(p, wall) {
  const s = (p[0] - wall.a[0]) * wall.dir[0] + (p[1] - wall.a[1]) * wall.dir[1];
  if (s < 0 || s > wall.length) return false;
  const off = Math.abs((p[0] - wall.a[0]) * -wall.dir[1] + (p[1] - wall.a[1]) * wall.dir[0]);
  if (off >= wall.thickness / 2 - 0.005) return false;
  return !wall.openings.some((o) => o.sill === 0 && s > o.from && s < o.to);
}

/**
 * Walls of one level from its indoor room outlines.
 * Every room edge lies on an infinite line. Per line, the edges are cut at every room corner that falls on
 * the line; each resulting stretch has a room on one side (exterior wall) or on both (interior wall).
 * Collinear neighbours are then merged back together wherever no other wall meets them.
 */
function deriveWalls(level, rooms, thick, say) {
  const lines = new Map();
  const vertices = [];
  for (const room of rooms) {
    const P = room.polygon;
    for (let i = 0; i < P.length; i++) {
      const p = P[i], q = P[(i + 1) % P.length];
      vertices.push(p);
      let dx = q[0] - p[0], dy = q[1] - p[1];
      const len = Math.hypot(dx, dy);
      if (len < EPS) continue;
      dx /= len; dy /= len;
      // Polygons are counter-clockwise on the page, so the room is on the visual left of travel: (dy, -dx).
      const inX = dy, inY = -dx;
      let ux = dx, uy = dy;
      if (ux < -EPS || (Math.abs(ux) <= EPS && uy < 0)) { ux = -ux; uy = -uy; }
      const nx = -uy, ny = ux;
      const c = p[0] * nx + p[1] * ny;
      const key = `${Math.round(ux * 1e5)},${Math.round(uy * 1e5)},${Math.round(c * 1e4)}`;
      let line = lines.get(key);
      if (!line) { line = { key, u: [ux, uy], n: [nx, ny], c, edges: [] }; lines.set(key, line); }
      const t0 = p[0] * ux + p[1] * uy, t1 = q[0] * ux + q[1] * uy;
      line.edges.push({ from: Math.min(t0, t1), to: Math.max(t0, t1), side: inX * nx + inY * ny > 0 ? 1 : 0, room: room.id });
    }
  }

  const nodeKey = (p) => `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)}`;
  const pieces = [];
  for (const line of lines.values()) {
    const { u, n, c } = line;
    const lo = Math.min(...line.edges.map((e) => e.from));
    const hi = Math.max(...line.edges.map((e) => e.to));
    const cuts = [];
    for (const e of line.edges) cuts.push(e.from, e.to);
    for (const v of vertices) {
      if (Math.abs(v[0] * n[0] + v[1] * n[1] - c) > 1e-5) continue;
      const t = v[0] * u[0] + v[1] * u[1];
      if (t > lo && t < hi) cuts.push(t);
    }
    cuts.sort((p, q) => p - q);
    const at = (t) => [round6(u[0] * t + n[0] * c), round6(u[1] * t + n[1] * c)];
    let prev = cuts[0];
    for (const t of cuts) {
      if (t - prev < 1e-5) continue;
      const mid = (prev + t) / 2;
      const on = [[], []];
      for (const e of line.edges) if (e.from < mid && e.to > mid) on[e.side].push(e.room);
      for (const side of on) {
        if (side.length > 1) say(`Rooms "${side[0]}" and "${side[1]}" overlap on level "${level.id}".`);
      }
      if (on[0].length || on[1].length) {
        const pair = [on[0][0] ?? null, on[1][0] ?? null];
        pieces.push({ line, from: prev, to: t, a: at(prev), b: at(t), rooms: pair, exterior: !(pair[0] && pair[1]) });
      }
      prev = t;
    }
  }

  // How many wall stretches meet at each point (before merging).
  const degree = new Map();
  for (const p of pieces) {
    for (const end of [p.a, p.b]) degree.set(nodeKey(end), (degree.get(nodeKey(end)) || 0) + 1);
  }

  // Merge collinear neighbours where nothing else meets them and they are the same kind of wall.
  const merged = [];
  const byLine = new Map();
  for (const p of pieces) {
    if (!byLine.has(p.line)) byLine.set(p.line, []);
    byLine.get(p.line).push(p);
  }
  for (const list of byLine.values()) {
    list.sort((p, q) => p.from - q.from);
    let cur = null;
    for (const p of list) {
      const joins = cur && Math.abs(p.from - cur.to) < 1e-5 && degree.get(nodeKey(cur.b)) === 2 &&
        p.exterior === cur.exterior &&
        (cur.exterior || (p.rooms[0] === cur.rooms[0] && p.rooms[1] === cur.rooms[1]));
      if (joins) { cur.to = p.to; cur.b = p.b; }
      else { if (cur) merged.push(cur); cur = { ...p }; }
    }
    if (cur) merged.push(cur);
  }
  merged.sort((p, q) => (p.a[1] - q.a[1]) || (p.a[0] - q.a[0]) || (p.b[1] - q.b[1]) || (p.b[0] - q.b[0]));

  // Posts: one at every wall end, as wide as the thickest wall meeting there.
  const postAt = new Map();
  for (const m of merged) {
    m.thickness = m.exterior ? thick.exterior : thick.interior;
    for (const end of [m.a, m.b]) {
      const k = nodeKey(end);
      const post = postAt.get(k);
      if (!post) postAt.set(k, { level: level.id, at: [end[0], end[1]], size: m.thickness });
      else post.size = Math.max(post.size, m.thickness);
    }
  }

  const walls = merged.map((m, i) => {
    const length = Math.hypot(m.b[0] - m.a[0], m.b[1] - m.a[1]);
    let spanFrom = postAt.get(nodeKey(m.a)).size / 2;
    let spanTo = length - postAt.get(nodeKey(m.b)).size / 2;
    if (spanTo < spanFrom) spanFrom = spanTo = length / 2;   // a wall shorter than its posts has no mass of its own
    return {
      id: `${level.id}_w${i + 1}`,
      level: level.id,
      a: m.a, b: m.b,
      length: round6(length),
      thickness: m.thickness,
      exterior: m.exterior,
      rooms: m.rooms,
      spanFrom: round6(spanFrom),
      spanTo: round6(spanTo),
      openings: [],
      height: level.height,
      dir: [round6((m.b[0] - m.a[0]) / length), round6((m.b[1] - m.a[1]) / length)],
    };
  });
  return { walls, posts: [...postAt.values()] };
}

/**
 * The solid boxes of a wall below the cut plane, in distances along a -> b within spanFrom..spanTo.
 * A door leaves a hole, a window leaves its sill (and its lintel if the cut is above the head), a gap leaves nothing.
 * @returns {{from:number,to:number,bottom:number,top:number}[]}
 */
export function wallPieces(wall, cutHeight = Infinity) {
  const top = Math.min(isNum(cutHeight) ? cutHeight : Infinity, isNum(wall.height) ? wall.height : Infinity);
  const out = [];
  if (!(top > 0)) return out;
  const add = (from, to, bottom, t) => {
    if (to - from > 1e-4 && t - bottom > 1e-4) out.push({ from: round6(from), to: round6(to), bottom, top: t });
  };
  let cursor = wall.spanFrom;
  for (const o of wall.openings) {
    const from = Math.max(o.from, wall.spanFrom), to = Math.min(o.to, wall.spanTo);
    if (to <= from) continue;
    add(cursor, from, 0, top);
    add(from, to, 0, Math.min(o.sill, top));
    add(from, to, o.head, top);
    cursor = Math.max(cursor, to);
  }
  add(cursor, wall.spanTo, 0, top);
  return out;
}

/**
 * The outline(s) of a level's building footprint, traced along its exterior walls.
 * @returns {[number, number][][]} closed loops (first point not repeated). A simple house gives one loop.
 */
export function footprints(plan, levelId) {
  const nodeKey = (p) => `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)}`;
  const walls = plan.walls.filter((w) => w.level === levelId && w.exterior);
  const at = new Map();
  for (const w of walls) {
    for (const end of [w.a, w.b]) {
      const k = nodeKey(end);
      if (!at.has(k)) at.set(k, []);
      at.get(k).push(w);
    }
  }
  const used = new Set();
  const loops = [];
  for (const start of walls) {
    if (used.has(start)) continue;
    const loop = [start.a];
    let wall = start, point = start.b;
    used.add(start);
    for (let guard = 0; guard <= walls.length; guard++) {
      if (nodeKey(point) === nodeKey(loop[0])) break;
      loop.push(point);
      const next = at.get(nodeKey(point)).find((w) => !used.has(w));
      if (!next) break;
      used.add(next);
      point = nodeKey(next.a) === nodeKey(point) ? next.b : next.a;
      wall = next;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/** Fetch and compile a plan. Throws, listing every problem, if the plan is unsound. */
export async function loadPlan(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load the house plan from ${url} (HTTP ${response.status}).`);
  let json;
  try { json = await response.json(); }
  catch (err) { throw new Error(`The house plan at ${url} is not valid JSON: ${err.message}`); }
  const plan = compilePlan(json);
  if (plan.problems.length) {
    const error = new Error(`The house plan at ${url} has ${plan.problems.length} problem(s):\n- ${plan.problems.join('\n- ')}`);
    error.problems = plan.problems;
    throw error;
  }
  return plan;
}
