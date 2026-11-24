// Fallback only: builds the `things` index (CONTRACTS §1) straight from an authored house.json, for the
// simulator and the tests when src/plan's compilePlan is not available. The real application uses the
// compiled plan. Exterior is approximated: an opening is exterior when a point 0.35 m to one side of it
// lies in no indoor room on its level (good for plans whose walls run along the axes).

export function thingsFromHouse(house) {
  const things = {};
  const add = (ref) => { things[ref.id] = ref; };
  const indoorByLevel = {};
  const roomLevel = {};
  for (const level of house.levels || []) {
    indoorByLevel[level.id] = [];
    for (const room of level.rooms || []) {
      roomLevel[room.id] = level.id;
      if (!room.outdoor) indoorByLevel[level.id].push(room.polygon);
      add({ id: room.id, kind: 'room', name: room.name || room.id, level: level.id, room: null });
    }
  }
  for (const o of house.openings || []) {
    if (o.type !== 'door' && o.type !== 'window') continue;
    const polys = indoorByLevel[o.level] || [];
    const d = 0.35;
    const probes = [[d, 0], [-d, 0], [0, d], [0, -d]].map(([dx, dy]) => [o.at[0] + dx, o.at[1] + dy]);
    const exterior = probes.some((p) => !polys.some((poly) => inside(p, poly)));
    add({ id: o.id, kind: o.type, name: o.name || o.id, level: o.level, room: null, exterior });
  }
  for (const f of house.fixtures || []) {
    if (f.type === 'light' || f.type === 'camera') add({ id: f.id, kind: f.type, name: f.name || f.id, level: roomLevel[f.room] || null, room: f.room || null });
  }
  for (const o of house.objects || []) {
    if (o.role) add({ id: o.id, kind: 'object', name: o.name || o.id, level: roomLevel[o.room] || null, room: o.room || null });
  }
  add({ id: 'house', kind: 'house', name: house.name || 'House', level: null, room: null });
  return things;
}

/** A CompiledPlan-shaped object with only what state/ and brain/ read. */
export function minimalPlanFromHouse(house) {
  const rooms = [];
  const levels = [];
  const roomLevel = {};
  for (const level of house.levels || []) {
    for (const room of level.rooms || []) roomLevel[room.id] = level.id;
    levels.push({ id: level.id, name: level.name, short: level.short, elevation: level.elevation, height: level.height });
    for (const room of level.rooms || []) rooms.push({ id: room.id, name: room.name, type: room.type, level: level.id, outdoor: !!room.outdoor });
  }
  const objects = (house.objects || []).map((o) => ({ id: o.id, name: o.name || o.id, type: o.type, role: o.role || null, level: roomLevel[o.room] || null, room: o.room || null }));
  return { name: house.name || 'House', levels, rooms, objects, things: thingsFromHouse(house), problems: [] };
}

function inside([x, y], poly) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
