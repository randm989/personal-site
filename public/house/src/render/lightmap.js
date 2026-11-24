// Baked, CPU-side lookups that make the fake lighting behave physically without any real lights:
//
//  * bakeField():  per storey, a distance field of the solid plan (walls, furniture, the footprint). The clay
//                  shader reads it for soft ambient occlusion where walls meet floors and for the contact
//                  shadow around the house.
//  * bakeLamps():  per light fixture, a small 2D visibility map ("what floor can this lamp see?") computed by
//                  casting against the wall plan. Lamplight is multiplied by it, so it cannot pass through a
//                  wall, but does spill through doorways, open-plan gaps and glass. Up to three nearby doors
//                  per lamp are kept in separate channels so the spill follows how far each door is open.
//
// Pure functions of the plan: no three.js, no DOM.

import { wallPieces } from '../plan/index.js';

export const FIELD_CELL = 0.04;        // metres per texel
export const FIELD_MARGIN = 3.2;       // metres of ground around the plan bounds
export const FIELD_WALL_RANGE = 0.6;   // R channel: distance to a wall, 0..range
export const FIELD_FURN_RANGE = 0.4;   // G channel: distance to furniture
export const FIELD_OUT_RANGE = 2.6;    // B channel: distance outside the footprint

export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Oriented rectangle: centre c, unit direction u, half extents (along u, across u). */
function stampRect(mask, W, H, ox, oy, cx, cy, ux, uy, ha, hb) {
  const ex = Math.abs(ux) * ha + Math.abs(uy) * hb, ey = Math.abs(uy) * ha + Math.abs(ux) * hb;
  const i0 = Math.max(0, Math.floor((cx - ex - ox) / FIELD_CELL)), i1 = Math.min(W - 1, Math.ceil((cx + ex - ox) / FIELD_CELL));
  const j0 = Math.max(0, Math.floor((cy - ey - oy) / FIELD_CELL)), j1 = Math.min(H - 1, Math.ceil((cy + ey - oy) / FIELD_CELL));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const px = ox + (i + 0.5) * FIELD_CELL - cx, py = oy + (j + 0.5) * FIELD_CELL - cy;
      if (Math.abs(px * ux + py * uy) <= ha && Math.abs(-px * uy + py * ux) <= hb) mask[j * W + i] = 1;
    }
  }
}

/** Two-pass chamfer distance transform. Returns distances in cells (0 inside the mask), capped at maxCells. */
function distanceField(mask, W, H, maxCells) {
  const d = new Float32Array(W * H);
  const BIG = maxCells + 2, A = 1, B = Math.SQRT2;
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? 0 : BIG;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      let v = d[k];
      if (v === 0) continue;
      if (i > 0) v = Math.min(v, d[k - 1] + A);
      if (j > 0) {
        v = Math.min(v, d[k - W] + A);
        if (i > 0) v = Math.min(v, d[k - W - 1] + B);
        if (i < W - 1) v = Math.min(v, d[k - W + 1] + B);
      }
      d[k] = v;
    }
  }
  for (let j = H - 1; j >= 0; j--) {
    for (let i = W - 1; i >= 0; i--) {
      const k = j * W + i;
      let v = d[k];
      if (v === 0) continue;
      if (i < W - 1) v = Math.min(v, d[k + 1] + A);
      if (j < H - 1) {
        v = Math.min(v, d[k + W] + A);
        if (i < W - 1) v = Math.min(v, d[k + W + 1] + B);
        if (i > 0) v = Math.min(v, d[k + W - 1] + B);
      }
      d[k] = v;
    }
  }
  return d;
}

/** Solid wall boxes of a level as oriented rectangles { cx, cy, ux, uy, ha, hb, full }. */
export function wallRects(plan, levelId, cutHeight) {
  const out = [];
  for (const wall of plan.walls) {
    if (wall.level !== levelId) continue;
    for (const piece of wallPieces(wall, Infinity)) {
      if (piece.bottom > 0.001) continue;                       // lintels do not touch the floor
      const mid = (piece.from + piece.to) / 2;
      out.push({
        cx: wall.a[0] + wall.dir[0] * mid, cy: wall.a[1] + wall.dir[1] * mid,
        ux: wall.dir[0], uy: wall.dir[1],
        ha: (piece.to - piece.from) / 2, hb: wall.thickness / 2,
        full: piece.top >= Math.min(cutHeight, wall.height) - 1e-6,   // false for a window sill
        opaque: piece.top >= wall.height - 1e-6,                      // floor-to-ceiling: blocks lamplight
      });
    }
  }
  for (const post of plan.posts) {
    if (post.level !== levelId) continue;
    out.push({ cx: post.at[0], cy: post.at[1], ux: 1, uy: 0, ha: post.size / 2, hb: post.size / 2, full: true, opaque: true });
  }
  return out;
}

/**
 * @returns {{ data:Uint8Array, width:number, height:number, originX:number, originY:number, cell:number }}
 *          RGBA: R wall distance, G furniture distance, B distance outside the footprint (all 0..255 over
 *          their range), A 255.
 */
export function bakeField(plan, levelId, cutHeight) {
  const ox = plan.bounds.minX - FIELD_MARGIN, oy = plan.bounds.minY - FIELD_MARGIN;
  const W = Math.ceil((plan.bounds.maxX - plan.bounds.minX + FIELD_MARGIN * 2) / FIELD_CELL);
  const H = Math.ceil((plan.bounds.maxY - plan.bounds.minY + FIELD_MARGIN * 2) / FIELD_CELL);

  const walls = new Uint8Array(W * H);
  for (const r of wallRects(plan, levelId, cutHeight)) stampRect(walls, W, H, ox, oy, r.cx, r.cy, r.ux, r.uy, r.ha, r.hb);

  const furn = new Uint8Array(W * H);
  for (const o of plan.objects) {
    if (o.level !== levelId || o.type === 'car' || o.type === 'rug' || o.type === 'pool') continue;
    // tables and desks stand on legs: only a faint, smaller footprint
    const shrink = o.type === 'table' || o.type === 'desk' ? 0.12 : 0.02;
    stampRect(furn, W, H, ox, oy, o.at[0], o.at[1], Math.cos(o.rotation), Math.sin(o.rotation),
      Math.max(0.02, o.size[0] / 2 - shrink), Math.max(0.02, o.size[1] / 2 - shrink));
  }

  const foot = new Uint8Array(W * H);
  for (const room of plan.rooms) {
    if (room.level !== levelId || room.outdoor) continue;
    const b = room.bounds;
    const i0 = Math.max(0, Math.floor((b.minX - ox) / FIELD_CELL) - 4), i1 = Math.min(W - 1, Math.ceil((b.maxX - ox) / FIELD_CELL) + 4);
    const j0 = Math.max(0, Math.floor((b.minY - oy) / FIELD_CELL) - 4), j1 = Math.min(H - 1, Math.ceil((b.maxY - oy) / FIELD_CELL) + 4);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (pointInPolygon(ox + (i + 0.5) * FIELD_CELL, oy + (j + 0.5) * FIELD_CELL, room.polygon)) foot[j * W + i] = 1;
      }
    }
  }
  for (let i = 0; i < foot.length; i++) if (walls[i]) foot[i] = 1;   // the walls stand half outside the room outlines

  const dw = distanceField(walls, W, H, FIELD_WALL_RANGE / FIELD_CELL);
  const df = distanceField(furn, W, H, FIELD_FURN_RANGE / FIELD_CELL);
  const dout = distanceField(foot, W, H, FIELD_OUT_RANGE / FIELD_CELL);
  const data = new Uint8Array(W * H * 4);
  const q = (d, range) => Math.max(0, Math.min(255, Math.round((d * FIELD_CELL / range) * 255)));
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = q(dw[i], FIELD_WALL_RANGE);
    data[i * 4 + 1] = q(df[i], FIELD_FURN_RANGE);
    data[i * 4 + 2] = q(dout[i], FIELD_OUT_RANGE);
    data[i * 4 + 3] = 255;
  }
  return { data, width: W, height: H, originX: ox, originY: oy, cell: FIELD_CELL };
}

// ---------------------------------------------------------------------------------------------- lamps

export const LAMP_TILE = 128;
const ANGLES = 1024;

/** What each mount type's light is like: reach of its map (m), falloff height (m), strength, source radius. */
export const MOUNTS = {
  ceiling: { reach: 5.0, h: 1.2, gain: 1.0, radius: 0.2 },
  lamp: { reach: 3.8, h: 0.9, gain: 0.95, radius: 0.14 },
  strip: { reach: 2.6, h: 0.6, gain: 0.8, radius: 0.05 },
  exterior: { reach: 3.8, h: 1.25, gain: 0.9, radius: 0.1 },
};

function rectSegments(r, grow = 0.012) {
  const ha = r.ha + grow, hb = r.hb;
  const ax = r.ux * ha, ay = r.uy * ha, bx = -r.uy * hb, by = r.ux * hb;
  const p = [
    [r.cx - ax - bx, r.cy - ay - by], [r.cx + ax - bx, r.cy + ay - by],
    [r.cx + ax + bx, r.cy + ay + by], [r.cx - ax + bx, r.cy - ay + by],
  ];
  return [[p[0], p[1]], [p[1], p[2]], [p[2], p[3]], [p[3], p[0]]];
}

/** Write the nearest hit of each segment into a per-angle depth buffer seen from (lx, ly). */
function castSegments(depth, lx, ly, segs, reach) {
  const TAU = Math.PI * 2;
  for (const [p, q] of segs) {
    const ax = p[0] - lx, ay = p[1] - ly, bx = q[0] - lx, by = q[1] - ly;
    const da = Math.hypot(ax, ay), db = Math.hypot(bx, by);
    const ex = bx - ax, ey = by - ay;
    if (Math.min(da, db) > reach * 1.5 + Math.hypot(ex, ey)) continue;
    const cross0 = ax * ey - ay * ex;                 // (P - L) x e
    if (Math.abs(cross0) < 1e-9) continue;            // seen edge-on
    let a0 = Math.atan2(ay, ax), a1 = Math.atan2(by, bx);
    let delta = a1 - a0;
    if (delta > Math.PI) delta -= TAU; else if (delta < -Math.PI) delta += TAU;
    if (delta < 0) { a0 = a0 + delta; delta = -delta; }
    const k0 = Math.floor((a0 / TAU) * ANGLES) - 1, k1 = Math.ceil(((a0 + delta) / TAU) * ANGLES) + 1;
    for (let k = k0; k <= k1; k++) {
      const ang = ((k + 0.5) / ANGLES) * TAU;
      const ux = Math.cos(ang), uy = Math.sin(ang);
      const den = ux * ey - uy * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = cross0 / den;
      if (t <= 0) continue;
      const s = (uy * ax - ux * ay) / den;            // position along the segment
      if (s < -0.02 || s > 1.02) continue;
      const idx = ((k % ANGLES) + ANGLES) % ANGLES;
      if (t < depth[idx]) depth[idx] = t;
    }
  }
}

/**
 * @param fixtures  the level's light fixtures, each with { id, mount, at, length?, rotation?, pos:[x, y] }
 *                  (pos is where the drawn fixture actually sits, e.g. an exterior light snapped to its wall)
 * @returns {{ data:Uint8Array, size:number, grid:number, lamps:Object<string,{tile:number,reach:number,h:number,gain:number,axis:[number,number],portals:string[]}> }}
 */
export function bakeLamps(plan, levelId, fixtures, cutHeight) {
  const grid = Math.max(1, Math.ceil(Math.sqrt(fixtures.length)));
  const size = grid * LAMP_TILE;
  const data = new Uint8Array(size * size * 4);
  const lamps = {};

  const rects = wallRects(plan, levelId, cutHeight).filter((r) => r.opaque);
  const staticSegs = [];
  for (const r of rects) staticSegs.push(...rectSegments(r));

  // Doors that can shut light in: hinged and garage doors. Sliding doors are glass.
  const doors = plan.openings.filter((o) => o.level === levelId && o.type === 'door' && o.style !== 'sliding').map((o) => {
    const h = o.width / 2;
    return {
      id: o.id, center: o.center,
      seg: [[o.center[0] - o.dir[0] * h, o.center[1] - o.dir[1] * h], [o.center[0] + o.dir[0] * h, o.center[1] + o.dir[1] * h]],
    };
  });

  const TAU = Math.PI * 2;
  fixtures.forEach((f, tile) => {
    const m = MOUNTS[f.mount] || MOUNTS.ceiling;
    const half = f.mount === 'strip' ? (f.length || 1) / 2 : 0;
    const rot = f.rotation || 0;
    const axis = [Math.cos(rot) * half, Math.sin(rot) * half];
    const reach = m.reach + half;
    const [lx, ly] = f.pos || f.at;

    const portals = doors
      .map((d) => ({ d, dist: Math.hypot(d.center[0] - lx, d.center[1] - ly) }))
      .filter((p) => p.dist < reach)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 3)
      .map((p) => p.d);

    // Source samples: a small disc (or points along a strip) for a soft penumbra.
    const samples = [];
    if (half > 0) {
      for (const t of [-0.9, -0.45, 0, 0.45, 0.9]) samples.push([lx + axis[0] * t, ly + axis[1] * t]);
    } else {
      samples.push([lx, ly]);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * TAU + 0.4;
        samples.push([lx + Math.cos(a) * m.radius, ly + Math.sin(a) * m.radius]);
      }
    }

    // Per sample: depth with every portal shut, and with each one open in turn.
    const passes = samples.map(([sx, sy]) => {
      const base = new Float32Array(ANGLES).fill(1e9);
      castSegments(base, sx, sy, staticSegs, reach);
      const doorDepth = portals.map((p) => {
        const d = new Float32Array(ANGLES).fill(1e9);
        castSegments(d, sx, sy, [p.seg], reach);
        return d;
      });
      const shut = base.slice();
      for (const d of doorDepth) for (let k = 0; k < ANGLES; k++) if (d[k] < shut[k]) shut[k] = d[k];
      const open = portals.map((_, pi) => {
        const o = base.slice();
        doorDepth.forEach((d, di) => { if (di !== pi) for (let k = 0; k < ANGLES; k++) if (d[k] < o[k]) o[k] = d[k]; });
        return o;
      });
      return { sx, sy, shut, open };
    });

    const col = tile % grid, row = Math.floor(tile / grid);
    const texel = (reach * 2) / LAMP_TILE;
    const inv = 255 / samples.length;
    for (let j = 1; j < LAMP_TILE - 1; j++) {
      for (let i = 1; i < LAMP_TILE - 1; i++) {
        const px = lx - reach + (i + 0.5) * texel, py = ly - reach + (j + 0.5) * texel;
        let v0 = 0; const vp = [0, 0, 0];
        for (const s of passes) {
          const dx = px - s.sx, dy = py - s.sy;
          const dist = Math.hypot(dx, dy) - 0.01;
          let a = Math.atan2(dy, dx) / TAU; if (a < 0) a += 1;
          const k = Math.min(ANGLES - 1, Math.floor(a * ANGLES));
          const seen = dist < s.shut[k];
          if (seen) v0++;
          else for (let p = 0; p < s.open.length; p++) if (dist < s.open[p][k]) vp[p]++;
        }
        const o = ((row * LAMP_TILE + j) * size + col * LAMP_TILE + i) * 4;
        data[o] = Math.round(v0 * inv);
        data[o + 1] = Math.round(vp[0] * inv);
        data[o + 2] = Math.round(vp[1] * inv);
        data[o + 3] = Math.round(vp[2] * inv);
      }
    }
    lamps[f.id] = { tile, reach, h: m.h, gain: m.gain, axis, pos: [lx, ly], portals: portals.map((p) => p.id) };
  });
  return { data, size, grid, lamps };
}
