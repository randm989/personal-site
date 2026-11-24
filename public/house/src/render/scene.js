// Builds the three.js scene graph for a CompiledPlan: per storey one merged static mesh (floors, walls,
// posts, furniture), the wall extension that rises when a storey above is shown, and the small moving
// parts (door leaves, garage door, glass, blinds, fixtures, cars). No state logic lives here: index.js
// drives the handles this module returns.

import * as THREE from 'three';
import { wallPieces } from '../plan/index.js';
import { MassBuilder, MAT } from './builder.js';
import { buildObject, buildStairsAbove } from './furniture.js';
import { bakeField, bakeLamps, pointInPolygon, wallRects, LAMP_TILE, FIELD_WALL_RANGE, FIELD_FURN_RANGE } from './lightmap.js';
import {
  createLevelUniforms, createClayMaterial, createPrepassMaterial, createEmissiveMaterial, createHaloMaterial,
  createGlassMaterial, createLineMaterial, buildLineGeometry, buildHullGeometry, createHullMaterials,
  createWedgeMaterial,
} from './materials.js';
import { Anim } from './tween.js';

export const GROUND_DROP = 0.08;      // the ground sits this far below the ground-storey floor
export const OUTDOOR_TOP = -0.03;     // outdoor slabs (porch, deck, driveway) sit a step below the indoor floor
export const MAX_LAMPS = 24;          // lamplight slots per storey (lights that are on at once)
const LEAF_T = 0.045;
const OPEN_ANGLE = (80 * Math.PI) / 180;
const WINDOW_ANGLE = (40 * Math.PI) / 180;

// ------------------------------------------------------------------------------------------- helpers

/** Boxes whose placement changes at run time (glass panes, blinds), merged into one geometry. */
class DynBoxes {
  constructor(extraName, extraSize) {
    this.extraName = extraName; this.extraSize = extraSize;
    this.boxes = [];
  }
  /** faceExtra(face) -> array of extraSize numbers; face is 'front' | 'back' | 'end' | 'top' | 'bottom'. */
  add(faceExtra) {
    const box = { index: this.boxes.length, faceExtra, placed: null };
    this.boxes.push(box);
    return box;
  }
  build() {
    const n = this.boxes.length * 24;
    this.pos = new Float32Array(n * 3);
    this.nor = new Float32Array(n * 3);
    this.extra = new Float32Array(n * this.extraSize);
    const idx = [];
    const faces = ['front', 'back', 'end', 'end', 'top', 'bottom'];
    for (const box of this.boxes) {
      for (let f = 0; f < 6; f++) {
        const base = box.index * 24 + f * 4;
        const e = box.faceExtra(faces[f]);
        for (let k = 0; k < 4; k++) this.extra.set(e, (base + k) * this.extraSize);
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nor, 3));
    g.setAttribute(this.extraName, new THREE.BufferAttribute(this.extra, this.extraSize));
    g.setIndex(idx);
    this.geometry = g;
    for (const box of this.boxes) if (box.placed) this.place(box, ...box.placed);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);   // contents move; never cull
    return g;
  }
  /**
   * Put a box at plan origin (ox, oy), running along unit direction (dx, dy), spanning x0..x1 along it,
   * y0..y1 across it (toward [-dy, dx]) and z0..z1 in height.
   */
  place(box, ox, oy, dx, dy, x0, x1, y0, y1, z0, z1) {
    box.placed = [ox, oy, dx, dy, x0, x1, y0, y1, z0, z1];
    if (!this.pos) return;
    const P = (x, y, z) => [ox + x * dx - y * dy, z, oy + x * dy + y * dx];
    const N = (x, y, z) => [x * dx - y * dy, z, x * dy + y * dx];
    const faces = [
      [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], N(0, 1, 0)],
      [[x1, y0, z0], [x0, y0, z0], [x0, y0, z1], [x1, y0, z1], N(0, -1, 0)],
      [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1], N(-1, 0, 0)],
      [[x1, y1, z0], [x1, y0, z0], [x1, y0, z1], [x1, y1, z1], N(1, 0, 0)],
      [[x0, y1, z1], [x1, y1, z1], [x1, y0, z1], [x0, y0, z1], N(0, 0, 1)],
      [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], N(0, 0, -1)],
    ];
    for (let f = 0; f < 6; f++) {
      const base = (box.index * 24 + f * 4) * 3;
      const n = faces[f][4];
      const w = [P(...faces[f][0]), P(...faces[f][1]), P(...faces[f][2]), P(...faces[f][3])];
      // The local frame is left-handed; order the corners so the face winds outward.
      const ax = w[1][0] - w[0][0], ay = w[1][1] - w[0][1], az = w[1][2] - w[0][2];
      const bx = w[2][0] - w[0][0], by = w[2][1] - w[0][1], bz = w[2][2] - w[0][2];
      const dot = (ay * bz - az * by) * n[0] + (az * bx - ax * bz) * n[1] + (ax * by - ay * bx) * n[2];
      const order = dot >= 0 ? [0, 1, 2, 3] : [0, 3, 2, 1];
      for (let k = 0; k < 4; k++) {
        this.pos.set(w[order[k]], base + k * 3);
        this.nor.set(n, base + k * 3);
      }
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.normal.needsUpdate = true;
  }
  setExtra(box, component, value) {
    if (!this.extra) return;
    for (let v = 0; v < 24; v++) this.extra[(box.index * 24 + v) * this.extraSize + component] = value;
    this.geometry.attributes[this.extraName].needsUpdate = true;
  }
  /** Current corner positions of some boxes, for a selection outline. */
  snapshot(boxes) {
    const pos = [], idx = [];
    for (const box of boxes) {
      const base = pos.length / 3;
      for (let v = 0; v < 24 * 3; v++) pos.push(this.pos[box.index * 72 + v]);
      for (let f = 0; f < 6; f++) idx.push(base + f * 4, base + f * 4 + 1, base + f * 4 + 2, base + f * 4, base + f * 4 + 2, base + f * 4 + 3);
    }
    return { pos, idx };
  }
}

/** Unlit geometry whose colour is set per keyed range (light fixtures, appliance screens). */
class RangeMesh {
  constructor() { this.pos = []; this.nor = []; this.idx = []; this.ranges = new Map(); this.raws = new Map(); }
  add(key, part) {
    const base = this.pos.length / 3;
    for (const v of part.pos) this.pos.push(v);
    for (const v of part.nor) this.nor.push(v);
    for (const i of part.idx) this.idx.push(base + i);
    this.ranges.set(key, [base, this.pos.length / 3]);
    this.raws.set(key, { pos: part.pos.slice(), idx: part.idx.slice() });
  }
  build() {
    const g = new THREE.BufferGeometry();
    this.col = new Float32Array((this.pos.length / 3) * 4);
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 4));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    this.geometry = g;
    return g;
  }
  setColor(key, r, g, b, a) {
    const range = this.ranges.get(key);
    if (!range) return;
    for (let i = range[0]; i < range[1]; i++) { this.col[i * 4] = r; this.col[i * 4 + 1] = g; this.col[i * 4 + 2] = b; this.col[i * 4 + 3] = a; }
    this.geometry.attributes.color.needsUpdate = true;
  }
  get empty() { return this.idx.length === 0; }
}

function setRangeColor(geometry, range, r, g, b, a) {
  const col = geometry.attributes.color;
  for (let i = range[0]; i < range[1]; i++) col.setXYZW(i, r, g, b, a);
  col.needsUpdate = true;
}

function dataTexture(data, w, h, linear) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.magFilter = t.minFilter = linear ? THREE.LinearFilter : THREE.NearestFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Plan corners of an object's footprint (optionally grown), in the order -x-y, +x-y, +x+y, -x+y of its local frame. */
function footprintCorners(obj, grow = 0) {
  const c = Math.cos(obj.rotation || 0), s = Math.sin(obj.rotation || 0);
  const hw = obj.size[0] / 2 + grow, hd = obj.size[1] / 2 + grow;
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([x, y]) => [obj.at[0] + x * c - y * s, obj.at[1] + x * s + y * c]);
}

function insidePolygon(points, obj, polygon) {
  // every corner, pulled a little toward the centre, lies in the polygon
  return points.every(([x, y]) => pointInPolygon(x + (obj.at[0] - x) * 0.02, y + (obj.at[1] - y) * 0.02, polygon));
}

function segmentDistance(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2)) : 0;
  return Math.hypot(px - a[0] - dx * t, py - a[1] - dy * t);
}

/** Distance along a ray (origin o, unit direction u) to the nearest of the segments, capped at max. */
export function castRay(ox, oy, ux, uy, segs, max) {
  let best = max;
  for (const s of segs) {
    const ex = s[2] - s[0], ey = s[3] - s[1];
    const den = ux * ey - uy * ex;
    if (Math.abs(den) < 1e-9) continue;
    const ax = s[0] - ox, ay = s[1] - oy;
    const t = (ax * ey - ay * ex) / den;
    if (t <= 1e-4 || t >= best) continue;
    const k = (ax * uy - ay * ux) / den;
    if (k >= -1e-3 && k <= 1 + 1e-3) best = t;
  }
  return best;
}

/** The scale figure: a turned peg with a round head, about 1.6 m tall. One geometry serves every figure. */
function buildFigure() {
  const fb = new MassBuilder();
  const N = 14;
  const ring = (r, z) => Array.from({ length: N }, (_, i) => { const a = (i / N) * Math.PI * 2; return [Math.cos(a) * r, Math.sin(a) * r, z]; });
  // a peg doll: broad at the foot, easing in to the shoulders, a short neck
  const body = [[0.158, 0], [0.166, 0.05], [0.158, 0.4], [0.138, 0.92], [0.126, 1.1], [0.1, 1.2], [0.056, 1.262]];
  for (let i = 0; i < body.length - 1; i++) {
    fb.loft(ring(body[i][0], body[i][1]), ring(body[i + 1][0], body[i + 1][1]), { mat: MAT.figure, top: i === body.length - 2, hintZ: i < 1 ? -0.05 : 0.04 });
  }
  const hr = 0.15, hz = 1.4;
  const lat = [-1.15, -0.62, -0.2, 0.2, 0.62, 1.0, 1.32];
  for (let i = 0; i < lat.length - 1; i++) {
    const mid = (lat[i] + lat[i + 1]) / 2;
    fb.loft(ring(hr * Math.cos(lat[i]), hz + hr * Math.sin(lat[i])), ring(hr * Math.cos(lat[i + 1]), hz + hr * Math.sin(lat[i + 1])),
      { mat: MAT.figure, top: i === lat.length - 2, ao: 1, hintZ: hr * Math.cos(mid) * Math.tan(mid) });
  }
  return fb;
}
export const FIGURE_HEIGHT = 1.55;

function nearestWall(plan, levelId, p) {
  let best = null;
  for (const w of plan.walls) {
    if (w.level !== levelId) continue;
    const s = Math.max(0, Math.min(w.length, (p[0] - w.a[0]) * w.dir[0] + (p[1] - w.a[1]) * w.dir[1]));
    const qx = w.a[0] + w.dir[0] * s, qy = w.a[1] + w.dir[1] * s;
    const d = Math.hypot(p[0] - qx, p[1] - qy);
    if (!best || d < best.d) best = { wall: w, d, qx, qy };
  }
  return best;
}

// -------------------------------------------------------------------------------------------- build

/**
 * @param plan CompiledPlan
 * @param o { cut, G (global uniforms), lambert:boolean }
 */
export function buildHouse(plan, o) {
  const cut = o.cut, G = o.G;
  const views = Array.isArray(o.views) ? o.views : [];      // default camera angles [{ az, pol }], for placing figures
  const root = new THREE.Group();
  root.name = 'house';
  const things = new Map();
  const levels = [];
  const disposables = [];
  const track = (x) => { disposables.push(x); return x; };

  plan.levels.forEach((lv, index) => {
    const above = plan.levels[index + 1] || null;
    const below = plan.levels[index - 1] || null;
    const slabT = below ? Math.max(0.12, Math.min(0.4, lv.elevation - (below.elevation + below.height))) : 0;
    const rooms = plan.rooms.filter((r) => r.level === lv.id);
    const roomIndex = new Map(rooms.map((r, i) => [r.id, i]));
    const fixtures = plan.fixtures.filter((f) => f.level === lv.id && f.type === 'light');
    const lampSlots = Math.min(MAX_LAMPS, fixtures.length);
    const S = createLevelUniforms(lampSlots, rooms.length);
    S.uElev.value = lv.elevation;

    const group = new THREE.Group();
    group.name = `level:${lv.id}`;
    group.position.y = lv.elevation;
    root.add(group);

    const L = {
      id: lv.id, index, elev: lv.elevation, height: lv.height, slabT, cut, group, S, rooms, roomIndex,
      fixtures: [], doors: [], windows: [], cars: [], appliances: [], roomHandles: [], cameras: [],
      blocked: [],                          // footprints nobody can stand on: stairwells, pools ([x, y][] each)
      opacity: new Anim(1), subdue: new Anim(0), ext: new Anim(0), lampScale: new Anim(1),
      fadeMeshes: [],                       // materials that must turn transparent while the storey fades
      lampSlots,
    };
    levels.push(L);

    const clayOpts = { lights: lampSlots, rooms: rooms.length, lambert: o.lambert, tilePx: LAMP_TILE };
    const clay = track(createClayMaterial(G, S, { ...clayOpts, roomState: true }));
    L.clay = clay;
    const z0 = index === 0 ? -GROUND_DROP : -slabT;

    // ---- baked lookups ---------------------------------------------------------------------------
    const field = bakeField(plan, lv.id, cut);
    S.uOcc.value = track(dataTexture(field.data, field.width, field.height, true));
    S.uOccXf.value.set(field.originX, field.originY, 1 / (field.width * field.cell), 1 / (field.height * field.cell));
    L.field = field;

    // ---- static geometry -------------------------------------------------------------------------
    const b = new MassBuilder();

    const insetPools = new Set();
    const stairsBelow = below ? plan.objects.filter((ob) => ob.level === below.id && ob.type === 'stairs'
      && ob.size[2] >= lv.elevation - below.elevation - 0.6) : [];
    for (const room of rooms) {
      const ri = roomIndex.get(room.id);
      const top = room.outdoor ? OUTDOOR_TOP : 0;
      let mat = room.outdoor ? MAT.slab : MAT.floor, flag = 0;
      if (room.outdoor && room.type === 'deck') {
        mat = MAT.deck;
        flag = (room.bounds.maxX - room.bounds.minX) >= (room.bounds.maxY - room.bounds.minY) ? 0 : 1;   // boards run the long way
      } else if (room.outdoor && room.type === 'driveway') mat = MAT.drive;

      // Holes: a pool set down into an outdoor slab; the stairwell where a flight arrives from the storey below.
      const holes = [];
      if (room.outdoor) {
        for (const ob of plan.objects) {
          if (ob.level !== lv.id || ob.type !== 'pool' || insetPools.has(ob.id)) continue;
          const ring = footprintCorners(ob);
          if (!insidePolygon(ring, ob, room.polygon)) continue;
          holes.push(ring); insetPools.add(ob.id); L.blocked.push(footprintCorners(ob, 0.15));
        }
      } else {
        for (const ob of stairsBelow) {
          const ring = footprintCorners(ob);
          if (!insidePolygon(ring, ob, room.polygon)) continue;
          holes.push(ring); L.blocked.push(footprintCorners(ob, 0.3));
          // the slab's cut edge around the well, and a guard on the three sides where there is a drop
          for (let i = 0; i < 4; i++) {
            const p = ring[i], q = ring[(i + 1) % 4];
            b.poly([[p[0], p[1], -slabT], [q[0], q[1], -slabT], [q[0], q[1], 0], [p[0], p[1], 0]],
              [ob.at[0] - (p[0] + q[0]) / 2, ob.at[1] - (p[1] + q[1]) / 2, 0], { mat: MAT.edge, room: ri, ao: 0.85 });
          }
          // an open balustrade (posts and a handrail), so the flight below stays visible through it
          const hw = ob.size[0] / 2, hd = ob.size[1] / 2, gt = 0.045, gh = Math.min(0.92, cut - 0.12), go = 0.03;
          const runs = [[[hw + go, -hd], [hw + go, hd + go]], [[hw + go, hd + go], [-hw - go, hd + go]], [[-hw - go, hd + go], [-hw - go, -hd]]];
          b.room = ri;
          b.setFrame(ob.at[0], ob.at[1], 0, ob.rotation || 0);
          for (const [p, q] of runs) {
            const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
            b.box(Math.min(p[0], q[0]) - gt / 2, Math.max(p[0], q[0]) + gt / 2, Math.min(p[1], q[1]) - gt / 2, Math.max(p[1], q[1]) + gt / 2,
              gh - 0.05, gh, { mat: MAT.furnLight, bottom: true, ao: 1 });
            const n = Math.max(1, Math.round(len / 0.55));
            for (let k = 0; k <= n; k++) {
              const x = p[0] + ((q[0] - p[0]) * k) / n, y = p[1] + ((q[1] - p[1]) * k) / n;
              b.box(x - 0.02, x + 0.02, y - 0.02, y + 0.02, 0, gh - 0.05, { mat: MAT.furnLight, top: false });
            }
          }
          b.setFrame(0, 0, 0, 0);
          b.room = 0;
        }
      }
      const all = holes.length ? [...room.polygon, ...holes.flat()] : room.polygon;
      const contour = room.polygon.map(([x, y]) => new THREE.Vector2(x, y));
      const tris = THREE.ShapeUtils.triangulateShape(contour, holes.map((ring) => ring.map(([x, y]) => new THREE.Vector2(x, y))));
      for (const t of tris) {
        b.poly(t.map((i) => [all[i][0], all[i][1], top]), [0, 0, 1], { mat, room: ri, ao: 1, flag });
        if (index > 0 && !room.outdoor) {
          b.poly(t.map((i) => [all[i][0], all[i][1], -slabT]), [0, 0, -1], { mat: MAT.edge, room: ri, ao: 0.8 });
        }
      }
      if (room.outdoor) {
        const P = room.polygon;
        for (let i = 0; i < P.length; i++) {
          const p = P[i], q = P[(i + 1) % P.length];
          let nx = q[1] - p[1], ny = -(q[0] - p[0]);
          const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
          if (pointInPolygon((p[0] + q[0]) / 2 + nx * 0.01, (p[1] + q[1]) / 2 + ny * 0.01, P)) { nx = -nx; ny = -ny; }
          b.poly([[p[0], p[1], z0], [q[0], q[1], z0], [q[0], q[1], top], [p[0], p[1], top]], [nx, ny, 0], { mat, room: ri, ao: 0.9 });
        }
      }
    }

    const ext = above ? new MassBuilder() : null;
    for (const wall of plan.walls) {
      if (wall.level !== lv.id) continue;
      const r = Math.atan2(wall.dir[1], wall.dir[0]);
      const ht = wall.thickness / 2;
      b.setFrame(wall.a[0], wall.a[1], 0, r);
      for (const piece of wallPieces(wall, cut)) {
        const isCut = piece.top >= cut - 1e-6;
        b.box(piece.from, piece.to, -ht, ht, piece.bottom > 0 ? piece.bottom : z0, piece.top,
          { mat: MAT.wall, topMat: isCut ? MAT.cap : MAT.wall, bottom: piece.bottom > 0 });
      }
      if (ext) {
        ext.setFrame(wall.a[0], wall.a[1], 0, r);
        const top = wall.height;
        for (const piece of wallPieces(wall, Infinity)) {
          const lo = Math.max(piece.bottom, cut);
          if (piece.top <= lo + 1e-6) continue;
          ext.box(piece.from, piece.to, -ht, ht, lo, Math.min(piece.top, top), { mat: MAT.wall, topMat: MAT.cap, bottom: lo > cut, ao: 1 });
        }
      }
    }
    // A flat roof over every room the storey above does not cover (a garage beside a two-storey house),
    // so the lower storey reads as a finished block when a higher storey is in focus.
    if (ext) {
      // Worked out on the grid of every wall line of both storeys, so a room that is only partly under the
      // upper storey (a garage projecting past the bedroom above it) is roofed over the part that is not.
      const upper = plan.rooms.filter((r) => r.level === above.id && !r.outdoor);
      const lower = rooms.filter((r) => !r.outdoor);
      const uniq = (k) => [...new Set([...upper, ...lower].flatMap((r) => r.polygon.map((p) => Math.round(p[k] * 1000) / 1000)))].sort((a, c) => a - c);
      const xs = uniq(0), ys = uniq(1);
      const roofZ = lv.height - 0.03;
      ext.setFrame(0, 0, 0, 0);
      for (let j = 0; j < ys.length - 1; j++) {
        let start = null;
        for (let i = 0; i <= xs.length - 1; i++) {
          const cx = (xs[i] + xs[i + 1]) / 2, cy = (ys[j] + ys[j + 1]) / 2;
          const open = i < xs.length - 1 && lower.some((r) => pointInPolygon(cx, cy, r.polygon)) && !upper.some((u) => pointInPolygon(cx, cy, u.polygon));
          if (open && start === null) start = xs[i];
          if (!open && start !== null) {
            const q = [[start, ys[j]], [xs[i], ys[j]], [xs[i], ys[j + 1]], [start, ys[j + 1]]];
            ext.poly(q.map(([x, y]) => [x, y, roofZ]), [0, 0, 1], { mat: MAT.cap, ao: 1 });
            ext.poly(q.map(([x, y]) => [x, y, roofZ - 0.05]), [0, 0, -1], { mat: MAT.edge, ao: 0.8 });
            start = null;
          }
        }
      }
    }
    b.setFrame(0, 0, 0, 0);
    for (const post of plan.posts) {
      if (post.level !== lv.id) continue;
      const h = post.size / 2;
      b.box(post.at[0] - h, post.at[0] + h, post.at[1] - h, post.at[1] + h, z0, cut, { mat: MAT.wall, topMat: MAT.cap });
      if (ext) {
        ext.setFrame(0, 0, 0, 0);
        ext.box(post.at[0] - h, post.at[0] + h, post.at[1] - h, post.at[1] + h, cut, lv.height, { mat: MAT.wall, topMat: MAT.cap, ao: 1 });
      }
    }

    // ---- furniture ---------------------------------------------------------------------------------
    const emissive = new RangeMesh();
    const applianceHalos = [];            // appended to the halo quads after the light fixtures
    for (const obj of plan.objects) {
      if (obj.level !== lv.id) continue;
      const ri = roomIndex.get(obj.room) ?? 0;
      if (obj.type === 'car') { L.cars.push(buildCar(obj, L, ri)); L.blocked.push(footprintCorners(obj, 0.25)); continue; }
      const tb = new MassBuilder();
      tb.room = ri;
      tb.setFrame(obj.at[0], obj.at[1], 0, obj.rotation);
      const meta = buildObject(tb, obj, { cut, inset: insetPools.has(obj.id), top: OUTDOOR_TOP });
      appendPart(b, tb.raw('body'));
      if (ext && obj.type === 'stairs' && obj.size[2] > cut + 0.2) {
        ext.room = ri;
        ext.setFrame(obj.at[0], obj.at[1], 0, obj.rotation);
        buildStairsAbove(ext, obj, cut);
        ext.room = 0;
      }
      if (obj.role) {
        const top = (meta && meta.fill ? meta.fill.z1 + 0.05 : Math.min(obj.size[2], cut));
        const handle = {
          id: obj.id, kind: 'object', sub: 'appliance', type: obj.type, level: L, obj,
          run: new Anim(0), raw: tb.raw('body'), hasGlow: tb.has('glow'),
          anchor: new THREE.Vector3(obj.at[0], lv.elevation + top + 0.2, obj.at[1]),
          pick: { point: new THREE.Vector3(obj.at[0], lv.elevation + top * 0.6, obj.at[1]), radius: Math.max(obj.size[0], obj.size[1]) * 0.6 },
        };
        if (handle.hasGlow) emissive.add(obj.id, tb.raw('glow'));
        if (meta && meta.halo) {
          const [hx, hy, hz] = tb.toWorld(meta.halo[0], meta.halo[1], meta.halo[2]);
          applianceHalos.push({ handle, pos: [hx, hy, hz], radius: meta.halo[3] });
        }
        if (meta && meta.fill) {
          // the print: a block that grows inside the frame (unit height, scaled by progress)
          const f = meta.fill;
          const pb = new MassBuilder();
          pb.baseAO = 1;
          pb.setFrame(obj.at[0], obj.at[1], 0, obj.rotation);
          pb.box(f.x0, f.x1, f.y0, f.y1, 0, 1, { bottom: true });
          const rm = new RangeMesh();
          rm.add('fill', pb.raw('body'));
          const mesh = new THREE.Mesh(track(rm.build()), track(createEmissiveMaterial(G, S)));
          mesh.position.y = f.z0; mesh.visible = false; mesh.name = `print:${obj.id}`;
          group.add(mesh);
          Object.assign(handle, { fill: new Anim(0), done: new Anim(0), fault: new Anim(0), fillMesh: mesh, fillRange: rm, fillSpan: f.z1 - f.z0 });
        }
        L.appliances.push(handle);
        things.set(obj.id, handle);
      } else if (tb.has('glow')) {
        appendPart(b, tb.raw('glow'));
      }
    }

    // ---- light fixtures ----------------------------------------------------------------------------
    const haloPos = [], haloCorner = [], haloIdx = [];
    const ringPaths = [];
    fixtures.forEach((f, i) => {
      let pos = [f.at[0], f.at[1]];
      const fb = new MassBuilder();
      fb.baseAO = 1;
      let y = cut, haloR = 0.62;
      if (f.mount === 'lamp') {
        b.setFrame(pos[0], pos[1], 0, 0);
        b.cyl(0, 0, 0.012, 0.1, 0.024, 'z', { mat: MAT.furnDark, segments: 12 });
        b.cyl(0, 0, 0.47, 0.016, 0.9, 'z', { mat: MAT.furnDark, segments: 6, caps: false });
        fb.setFrame(pos[0], pos[1], 0, 0);
        fb.cyl(0, 0, 1.06, 0.15, 0.26, 'z', { segments: 14 });
        y = 1.06; haloR = 0.6;
      } else if (f.mount === 'strip') {
        const len = f.length || 1;
        fb.setFrame(pos[0], pos[1], 0, f.rotation || 0);
        fb.box(-len / 2, len / 2, -0.02, 0.02, 0.925, 0.955, { bottom: true });
        y = 0.95; haloR = 0.34;
      } else if (f.mount === 'exterior') {
        const near = nearestWall(plan, lv.id, pos);
        if (near && near.d < 1) {
          const n = [-near.wall.dir[1], near.wall.dir[0]];
          const side = Math.sign((pos[0] - near.qx) * n[0] + (pos[1] - near.qy) * n[1]) || 1;
          const off = near.wall.thickness / 2 + 0.065;
          pos = [near.qx + n[0] * side * off, near.qy + n[1] * side * off];
        }
        fb.setFrame(pos[0], pos[1], 0, 0);
        fb.cyl(0, 0, 0.98, 0.062, 0.2, 'z', { segments: 10 });
        y = 0.98; haloR = 0.5;
      } else {
        fb.setFrame(pos[0], pos[1], 0, 0);
        // a thin ring floating at the cut: a ceiling light drawn as a symbol, not a dome resting on the furniture
        const N = 24, r0 = 0.105, r1 = 0.165;
        for (const [z, up] of [[cut + 0.006, 1], [cut - 0.006, -1]]) {
          for (let k = 0; k < N; k++) {
            const a0 = (k / N) * Math.PI * 2, a1 = ((k + 1) / N) * Math.PI * 2;
            const quad = [
              [Math.cos(a0) * r0, Math.sin(a0) * r0, z], [Math.cos(a0) * r1, Math.sin(a0) * r1, z],
              [Math.cos(a1) * r1, Math.sin(a1) * r1, z], [Math.cos(a1) * r0, Math.sin(a1) * r0, z],
            ];
            fb.poly(up > 0 ? quad : quad.reverse(), [0, 0, up]);
          }
        }
        haloR = 0.5;
      }
      emissive.add(f.id, fb.raw('body'));
      const hb = haloPos.length / 3;
      for (const c of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { haloPos.push(pos[0], y, pos[1]); haloCorner.push(c[0], c[1], haloR); }
      haloIdx.push(hb, hb + 1, hb + 2, hb, hb + 2, hb + 3);
      const ring = [];
      for (let k = 0; k < 32; k++) { const a = (k / 32) * Math.PI * 2; ring.push([pos[0] + Math.cos(a) * 0.3, y + 0.01, pos[1] + Math.sin(a) * 0.3]); }
      ringPaths.push({ points: ring, closed: true, rgba: [1, 1, 1, 0] });
      const handle = {
        id: f.id, kind: 'light', level: L, fixture: f, index: i, pos,
        inten: new Anim(0), r: new Anim(1), g: new Anim(0.4), b: new Anim(0.1), ring: new Anim(0),
        anchor: new THREE.Vector3(pos[0], lv.elevation + y + 0.22, pos[1]),
        pick: { point: new THREE.Vector3(pos[0], lv.elevation + y, pos[1]), radius: 0.2 },
      };
      L.fixtures.push(handle);
      things.set(f.id, handle);
    });

    // appliance glows share the halo quads (one draw call for every soft glow on the storey)
    for (const a of applianceHalos) {
      const hb = haloPos.length / 3;
      a.handle.haloRange = [hb, hb + 4];
      for (const c of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { haloPos.push(a.pos[0], a.pos[1], a.pos[2]); haloCorner.push(c[0], c[1], a.radius); }
      haloIdx.push(hb, hb + 1, hb + 2, hb, hb + 2, hb + 3);
    }

    // ---- cameras -----------------------------------------------------------------------------------
    // A small body on the wall and its field of view drawn on the ground, cut off where walls block it.
    const wedge = { pos: [], col: [], w: [], s: [], idx: [] };
    const sightSegs = [];
    for (const r of wallRects(plan, lv.id, cut)) {
      if (!r.opaque) continue;
      const ax = r.ux * r.ha, ay = r.uy * r.ha, bx = -r.uy * r.hb, by = r.ux * r.hb;
      const q = [[r.cx - ax - bx, r.cy - ay - by], [r.cx + ax - bx, r.cy + ay - by], [r.cx + ax + bx, r.cy + ay + by], [r.cx - ax + bx, r.cy - ay + by]];
      for (let k = 0; k < 4; k++) sightSegs.push([q[k][0], q[k][1], q[(k + 1) % 4][0], q[(k + 1) % 4][1]]);
    }
    L.sightSegs = sightSegs;
    for (const f of plan.fixtures) {
      if (f.level !== lv.id || f.type !== 'camera') continue;
      let pos = [f.at[0], f.at[1]];
      const rot = Number.isFinite(f.rotation) ? f.rotation : 0;
      const look = [-Math.sin(rot), Math.cos(rot)];
      const ceiling = f.mount === 'ceiling';
      if (!ceiling) {
        const near = nearestWall(plan, lv.id, pos);
        if (near && near.d < 1) {
          const n = [-near.wall.dir[1], near.wall.dir[0]];
          // stand off the wall on the side the camera looks toward (or the authored side when it looks along the wall)
          const facing = look[0] * n[0] + look[1] * n[1];
          const side = Math.abs(facing) > 0.2 ? Math.sign(facing) : (Math.sign((pos[0] - near.qx) * n[0] + (pos[1] - near.qy) * n[1]) || 1);
          const off = near.wall.thickness / 2 + 0.02;
          pos = [near.qx + n[0] * side * off, near.qy + n[1] * side * off];
        }
      }
      const cb = new MassBuilder();
      cb.room = roomIndex.get(f.room) ?? 0;
      cb.setFrame(pos[0], pos[1], 0, rot);
      let bodyY;
      if (ceiling) {
        // a dome floating at the cut, like the ceiling lights
        cb.cyl(0, 0, cut - 0.03, 0.13, 0.07, 'z', { mat: MAT.device, segments: 14, ao: 1 });
        cb.part('glow');
        cb.cyl(0, 0.05, cut + 0.012, 0.05, 0.012, 'z', { segments: 10, ao: 1 });
        cb.part('body');
        bodyY = cut;
      } else {
        const zc = Math.min(1.02, cut - 0.14);
        cb.box(-0.04, 0.04, 0, 0.07, zc - 0.035, zc + 0.035, { mat: MAT.device, bottom: true, ao: 1 });                 // arm
        cb.box(-0.085, 0.085, 0.06, 0.33, zc - 0.075, zc + 0.075, { mat: MAT.device, bevel: 0.02, bottom: true, ao: 1 });   // body
        cb.box(-0.1, 0.1, 0.22, 0.37, zc + 0.075, zc + 0.095, { mat: MAT.device, bottom: true, ao: 1 });                 // hood
        cb.part('glow');
        cb.cyl(0, 0.335, zc, 0.05, 0.02, 'y', { segments: 10, ao: 1 });                                                  // lens
        cb.part('body');
        bodyY = zc;
      }
      appendPart(b, cb.raw('body'));
      emissive.add(f.id, cb.raw('glow'));

      // field of view on the ground
      const fov = Math.max(10, Math.min(360, Number.isFinite(f.fov) ? f.fov : 90)), range = f.range > 0 ? f.range : 6;
      const half = (fov * Math.PI) / 360;
      const eye = ceiling ? pos : [pos[0] + look[0] * 0.12, pos[1] + look[1] * 0.12];
      const N = Math.max(10, Math.ceil(fov / 4));
      const base = Math.atan2(look[1], look[0]);
      const pts = [];
      for (let k = 0; k <= N; k++) {
        const t = (k / N) * 2 - 1;
        const a = base + t * half;
        const ux = Math.cos(a), uy = Math.sin(a);
        const hit = castRay(eye[0], eye[1], ux, uy, sightSegs, range);
        pts.push({ x: eye[0] + ux * hit, y: eye[1] + uy * hit, r: hit / range, t });
      }
      const v0 = wedge.pos.length / 3;
      const wy = 0.02;
      for (let k = 0; k < N; k++) {
        const p = pts[k], q = pts[k + 1], vb = wedge.pos.length / 3;
        wedge.pos.push(eye[0], wy, eye[1], p.x, wy, p.y, q.x, wy, q.y);
        wedge.w.push(0, (p.t + q.t) / 2, range, half, p.r, p.t, range, half, q.r, q.t, range, half);
        for (let j = 0; j < 3; j++) { wedge.col.push(1, 1, 1, 0); wedge.s.push(0, 0); }
        wedge.idx.push(vb, vb + 1, vb + 2);
      }
      const handle = {
        id: f.id, kind: 'camera', level: L, fixture: f, pos, eye, look,     // eye: the lens in plan [x, y]; look: unit view direction
        seen: new Anim(0), lost: new Anim(0), active: new Anim(0), attn: new Anim(0),
        range: [v0, wedge.pos.length / 3], raw: cb.raw('body'),
        outline: pts.filter((_, k) => k % 3 === 0 || k === N).map((p) => [p.x, p.y]),      // for framing the view
        anchor: new THREE.Vector3(pos[0], lv.elevation + bodyY + 0.3, pos[1]),
        pick: { point: new THREE.Vector3(pos[0] + look[0] * 0.15, lv.elevation + bodyY, pos[1] + look[1] * 0.15), radius: 0.28 },
      };
      L.cameras.push(handle);
      things.set(f.id, handle);
    }
    if (wedge.idx.length) {
      const g = track(new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.Float32BufferAttribute(wedge.pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(wedge.col), 4));
      g.setAttribute('aW', new THREE.Float32BufferAttribute(wedge.w, 4));
      g.setAttribute('aS', new THREE.BufferAttribute(new Float32Array(wedge.s), 2));
      g.setIndex(wedge.idx);
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, track(createWedgeMaterial(G, S)));
      m.renderOrder = 4; m.name = 'camera-wedges';
      group.add(m);
      L.wedges = g;
    }

    const lampBake = bakeLamps(plan, lv.id, L.fixtures.map((h) => ({ ...h.fixture, pos: h.pos })), cut);
    S.uAtlas.value = track(dataTexture(lampBake.data, lampBake.size, lampBake.size, true));
    S.uGrid.value = lampBake.grid;
    for (const h of L.fixtures) h.lamp = lampBake.lamps[h.id];

    // ---- static meshes -----------------------------------------------------------------------------
    b.setFrame(0, 0, 0, 0);
    const staticGeo = track(b.toGeometry('body'));
    const mesh = new THREE.Mesh(staticGeo, clay);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.name = 'static';
    group.add(mesh);
    L.staticMesh = mesh;
    const prepass = new THREE.Mesh(staticGeo, track(createPrepassMaterial()));
    prepass.renderOrder = 5; prepass.visible = false;
    group.add(prepass);
    L.prepass = prepass;

    if (ext && ext.has('body')) {
      const g = track(ext.toGeometry('body'));
      g.attributes.position.setUsage(THREE.DynamicDrawUsage);
      const m = new THREE.Mesh(g, clay);
      m.castShadow = true; m.receiveShadow = true; m.visible = false; m.frustumCulled = false;
      m.name = 'wall-extension';
      group.add(m);
      L.extMesh = m;
      L.extTarget = Float32Array.from(g.attributes.position.array);
    }

    if (!emissive.empty) {
      const g = track(emissive.build());
      const m = new THREE.Mesh(g, track(createEmissiveMaterial(G, S)));
      m.name = 'emissive';
      group.add(m);
      L.emissive = emissive;
    }
    if (haloIdx.length) {
      const g = track(new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.Float32BufferAttribute(haloPos, 3));
      g.setAttribute('aCorner', new THREE.Float32BufferAttribute(haloCorner, 3));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array((haloPos.length / 3) * 4), 4));
      g.setIndex(haloIdx);
      g.computeBoundingSphere();
      g.boundingSphere.radius += 1;
      const m = new THREE.Mesh(g, track(createHaloMaterial(G, S)));
      m.renderOrder = 20; m.name = 'halos';
      group.add(m);
      L.halos = g;
    }
    if (ringPaths.length) {
      const rg = track(buildLineGeometry(ringPaths));
      const rm = new THREE.Mesh(rg, track(createLineMaterial(G, S, { width: 2.5, dash: [0.3 * Math.PI * 2 / 10, 0.3 * Math.PI * 2 / 10], color: G.uHatchCol.value })));
      rm.renderOrder = 21; rm.visible = false; rm.name = 'unknown-rings';
      group.add(rm);
      L.rings = rg; L.ringMesh = rm;
    }

    // ---- rooms -------------------------------------------------------------------------------------
    for (const room of rooms) {
      const handle = {
        id: room.id, kind: 'room', level: L, room, index: roomIndex.get(room.id),
        alert: new Anim(0), halo: new Anim(0),
        anchor: new THREE.Vector3(room.centroid[0], lv.elevation + (room.outdoor ? 0.5 : cut), room.centroid[1]),
      };
      const bw = room.bounds.maxX - room.bounds.minX, bh = room.bounds.maxY - room.bounds.minY;
      // the presence disc sits inside the room, about its centroid
      S.uRoomC.value[handle.index].set(room.centroid[0], room.centroid[1], Math.max(0.5, Math.min(1.9, Math.min(bw, bh) * 0.4)), 0);
      L.roomHandles.push(handle);
      things.set(room.id, handle);
    }

    // ---- openings ----------------------------------------------------------------------------------
    const glass = new DynBoxes('aGlass', 2);
    const blinds = new DynBoxes('aInfo', 4);
    const glassFace = (face) => (face === 'front' || face === 'back' ? [1, 0] : face === 'bottom' ? [1, 0] : [2.7, 0]);
    const blindFace = () => [MAT.blind, 0, 1, 0];

    for (const op of plan.openings) {
      if (op.level !== lv.id || op.type === 'gap') continue;
      const [cx, cy] = op.center;
      const [dx, dy] = op.dir;
      const [nx, ny] = op.normal;
      const half = op.width / 2;
      const ends = {
        a: new THREE.Vector3(cx - dx * half, lv.elevation + 0.6, cy - dy * half),
        b: new THREE.Vector3(cx + dx * half, lv.elevation + 0.6, cy + dy * half),
      };
      if (op.type === 'window') {
        // glass stands a little proud of the cut so it reads as glass, not as a billboard
        const gTop = Math.max(op.sill + 0.3, Math.min(op.head, cut + 0.38));
        const pane = glass.add(glassFace);
        const blind = blinds.add(blindFace);
        const handle = {
          id: op.id, kind: 'window', level: L, opening: op, pane, blind,
          open: new Anim(0), blindPos: new Anim(1), blindShown: new Anim(0), hatch: new Anim(0),
          anchor: new THREE.Vector3(cx, lv.elevation + gTop + 0.18, cy),
          pick: { a: ends.a.clone().setY(lv.elevation + (op.sill + gTop) / 2), b: ends.b.clone().setY(lv.elevation + (op.sill + gTop) / 2) },
          place() {
            // hinged at the `from` jamb, swinging outward (away from the room the normal points into)
            const th = this.open.v * WINDOW_ANGLE;
            const px = dx * Math.cos(th) - nx * Math.sin(th), py = dy * Math.cos(th) - ny * Math.sin(th);
            glass.place(pane, cx - dx * (half - 0.02), cy - dy * (half - 0.02), px, py, 0, op.width - 0.04, -0.015, 0.015, op.sill, gTop);
            const shown = this.blindShown.v;
            const drop = (1 - this.blindPos.v) * (gTop - op.sill) * shown;
            const hw = (half - 0.05) * (shown > 0.01 && drop > 0.004 ? 1 : 0);
            // the blind hangs on the room side of the glass
            const s = (-dy * nx + dx * ny) >= 0 ? 1 : -1;      // is the normal on the +across side?
            blinds.place(blind, cx, cy, dx, dy, -hw, hw, s > 0 ? 0.04 : -0.065, s > 0 ? 0.065 : -0.04, gTop - drop, gTop);
            glass.setExtra(pane, 1, this.hatch.v);
          },
          outline: () => glass.snapshot([pane]),
        };
        L.windows.push(handle);
        things.set(op.id, handle);
        continue;
      }

      // doors
      const base = {
        id: op.id, kind: 'door', style: op.style, level: L, opening: op,
        pos: new Anim(0), hatch: new Anim(0), plain: new Anim(0), ghost: new Anim(0),

        anchor: new THREE.Vector3(cx, lv.elevation + cut + 0.3, cy),
        pick: ends,
      };
      if (op.style === 'sliding') {
        const fixed = glass.add(glassFace), slider = glass.add(glassFace);
        const s = (-dy * nx + dx * ny) >= 0 ? 1 : -1;
        Object.assign(base, {
          place() {
            glass.place(fixed, cx, cy, dx, dy, -half + 0.02, 0.03, -s * 0.045, -s * 0.015, 0.02, Math.min(op.head, cut + 0.38));
            const shift = -this.pos.v * (half - 0.1);
            glass.place(slider, cx, cy, dx, dy, -0.03 + shift, half - 0.02 + shift, s * 0.015, s * 0.045, 0.02, Math.min(op.head, cut + 0.38));
            glass.setExtra(fixed, 1, this.hatch.v);
            glass.setExtra(slider, 1, this.hatch.v);
          },
          outline: () => glass.snapshot([fixed, slider]),
        });
      } else if (op.style === 'garage') {
        const gb = new MassBuilder();
        gb.baseAO = 1;
        gb.box(-half + 0.02, half - 0.02, -0.035, 0.035, 0, 1, { mat: MAT.leaf, bottom: true });
        const geo = track(gb.toGeometry('body'));
        const mat = track(createClayMaterial(G, S, { ...clayOpts, hatch: true, plain: true, section: true }));
        mat.transparent = true; mat.userData.alwaysTransparent = true;     // an unsensed door is a faint ghost panel
        const m = new THREE.Mesh(geo, mat);
        m.castShadow = true; m.receiveShadow = true;
        m.position.set(cx, 0, cy);
        m.rotation.y = Math.atan2(-dy, dx);
        group.add(m);
        Object.assign(base, {
          mesh: m, mat, raw: gb.raw('body'),
          place() {
            const top = cut + (Math.min(op.head, lv.height) - cut) * L.ext.v;
            const bottom = Math.min(1, Math.max(0, this.pos.v)) * top;
            const hgt = top - bottom;
            m.visible = hgt > 0.012;
            m.scale.y = Math.max(hgt, 0.001);
            m.position.y = bottom;
            mat.userData.u.uSection.value.set(lv.elevation + bottom, 0.4);
            mat.userData.u.uFade.value = 1 - 0.6 * this.ghost.v;
            mat.userData.u.uHatch.value = this.hatch.v;
            mat.userData.u.uPlain.value = this.plain.v;
          },
        });
      } else {
        const w = op.width - 0.05;
        const lb = new MassBuilder();
        lb.box(0, w, -LEAF_T / 2, LEAF_T / 2, 0, cut, { mat: MAT.leaf, bottom: false });
        const geo = track(lb.toGeometry('body'));
        const mat = track(createClayMaterial(G, S, { ...clayOpts, hatch: true, plain: true }));
        const m = new THREE.Mesh(geo, mat);
        m.castShadow = true; m.receiveShadow = true;
        const sgn = op.hingeEnd === 'to' ? -1 : 1;                 // which way the closed leaf runs from its hinge
        const hx = cx - sgn * dx * (half - 0.025), hy = cy - sgn * dy * (half - 0.025);
        m.position.set(hx, 0, hy);
        group.add(m);
        Object.assign(base, {
          mesh: m, mat, raw: lb.raw('body'),
          place() {
            const th = Math.min(1, Math.max(0, this.pos.v)) * OPEN_ANGLE;
            const lx = sgn * dx * Math.cos(th) + nx * Math.sin(th), ly = sgn * dy * Math.cos(th) + ny * Math.sin(th);
            m.rotation.y = Math.atan2(-ly, lx);
            m.scale.y = 1 + (Math.min(op.head, lv.height) / cut - 1) * L.ext.v;
            mat.userData.u.uHatch.value = this.hatch.v;
            mat.userData.u.uPlain.value = this.plain.v;
          },
        });
      }
      L.doors.push(base);
      things.set(op.id, base);
    }

    if (glass.boxes.length) {
      [...L.windows, ...L.doors].forEach((h) => { if (h.kind === 'window' || h.style === 'sliding') h.place(); });
      const g = track(glass.build());
      const m = new THREE.Mesh(g, track(createGlassMaterial(G, S)));
      m.renderOrder = 10; m.name = 'glass';
      group.add(m);
      L.glass = glass;
    }
    if (blinds.boxes.length) {
      const g = track(blinds.build());
      const m = new THREE.Mesh(g, track(createClayMaterial(G, S, { ...clayOpts, slats: true })));
      m.castShadow = false; m.receiveShadow = true; m.name = 'blinds';
      group.add(m);
      L.blinds = blinds;
    }
    for (const h of [...L.windows, ...L.doors]) h.place();
  });

  // ---- exterior ground -----------------------------------------------------------------------------
  const B = plan.bounds;
  const gcx = (B.minX + B.maxX) / 2, gcz = (B.minY + B.maxY) / 2;
  const reach = Math.hypot(B.maxX - B.minX, B.maxY - B.minY) / 2;
  // An ellipse that follows the plot, so a long narrow house does not sit on a short round mat.
  const gPad = Math.max(3.5, reach * 0.3);
  const gax = (B.maxX - B.minX) / 2 + gPad, gaz = (B.maxY - B.minY) / 2 + gPad;
  G.uGroundScale.value.set(1 / gax, 1 / gaz);
  G.uGroundFade.value.set(gcx, gcz, 0.72, 1.75);
  const gb = new MassBuilder();
  const ring = [];
  for (let i = 0; i < 48; i++) { const a = (i / 48) * Math.PI * 2; ring.push([gcx + Math.cos(a) * gax * 1.8, gcz + Math.sin(a) * gaz * 1.8, 0]); }
  gb.poly(ring, [0, 0, 1], { mat: MAT.ground, ao: 1 });
  const L0 = levels[0];
  const groundMat = track(createClayMaterial(G, L0.S, { lights: L0.lampSlots, rooms: L0.rooms.length, lambert: o.lambert, ground: true, tilePx: LAMP_TILE }));
  const ground = new THREE.Mesh(track(gb.toGeometry('body')), groundMat);
  ground.position.y = L0.elev - GROUND_DROP;
  ground.receiveShadow = true;
  ground.renderOrder = -10;
  ground.name = 'ground';
  root.add(ground);

  // ---- cars ----------------------------------------------------------------------------------------
  function buildCar(obj, L, ri) {
    const cb = new MassBuilder();
    cb.room = ri;
    buildObject(cb, obj, { cut });
    const g = new THREE.Group();
    g.position.set(obj.at[0], 0, obj.at[1]);
    g.rotation.y = -obj.rotation;
    const clayOpts = { lights: L.lampSlots, rooms: L.rooms.length, lambert: o.lambert, tilePx: LAMP_TILE, transparent: true };
    const mat = track(createClayMaterial(G, L.S, clayOpts));
    const body = new THREE.Mesh(track(cb.toGeometry('body')), mat);
    body.castShadow = true; body.receiveShadow = true;
    g.add(body);
    let glow = null;
    if (cb.has('glow')) {
      const rm = new RangeMesh();
      rm.add('glow', cb.raw('glow'));
      const em = track(createEmissiveMaterial(G, L.S));
      glow = { range: rm, mat: em, mesh: new THREE.Mesh(track(rm.build()), em) };
      g.add(glow.mesh);
    }
    // footprint outline, drawn alone when it is not known whether the car is there
    const hw = obj.size[0] / 2 - 0.05, hd = obj.size[1] / 2 - 0.05, c = 0.35;
    const pts = [[-hw + c, -hd], [hw - c, -hd], [hw, -hd + c], [hw, hd - c], [hw - c, hd], [-hw + c, hd], [-hw, hd - c], [-hw, -hd + c]]
      .map(([x, y]) => [x, 0.03, y]);
    const lineMat = track(createLineMaterial(G, L.S, { width: 1.5, dash: [0.22, 0.16], color: G.uHatchCol.value }));
    const outline = new THREE.Mesh(track(buildLineGeometry([{ points: pts, closed: true }])), lineMat);
    outline.renderOrder = 6;
    g.add(outline);
    L.group.add(g);
    const handle = {
      id: obj.id, kind: 'object', sub: 'car', level: L, obj, group: g, body, mat, glow, outlineMesh: outline, lineMat,
      show: new Anim(0), unknown: new Anim(0), charge: new Anim(0), raw: cb.raw('body'),
      anchor: new THREE.Vector3(obj.at[0], L.elev + obj.size[2] + 0.25, obj.at[1]),
      pick: { point: new THREE.Vector3(obj.at[0], L.elev + obj.size[2] * 0.5, obj.at[1]), radius: Math.max(obj.size[0], obj.size[1]) * 0.42 },
    };
    things.set(obj.id, handle);
    return handle;
  }

  // ---- scale figures --------------------------------------------------------------------------------
  const figureBuilder = buildFigure();
  const figureGeo = track(figureBuilder.toGeometry('body'));
  const figureRaw = figureBuilder.raw('body');

  /** A figure mesh on a storey (its material reads that storey's lamplight). The caller places and fades it. */
  function makeFigure(L) {
    const mat = track(createClayMaterial(G, L.S, { lights: L.lampSlots, rooms: L.rooms.length, lambert: o.lambert, tilePx: LAMP_TILE, transparent: true }));
    mat.userData.alwaysTransparent = true;
    const mesh = new THREE.Mesh(figureGeo, mat);
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.visible = false;
    mesh.userData.caster = true;
    mesh.name = 'figure';
    L.group.add(mesh);
    return { mesh, mat };
  }

  /**
   * Where figures stand in a room: up to six free spots, clear of walls, furniture, doorways, light fittings,
   * stairwells and water; the first is the most natural place, the rest gather near it without touching.
   */
  const spotCache = new Map();
  function standSpots(L, room) {
    const key = L.id + '/' + room.id;
    if (spotCache.has(key)) return spotCache.get(key);
    const f = L.field;
    const sample = (x, y) => {
      const i = Math.floor((x - f.originX) / f.cell), j = Math.floor((y - f.originY) / f.cell);
      if (i < 0 || j < 0 || i >= f.width || j >= f.height) return [FIELD_WALL_RANGE, FIELD_FURN_RANGE];
      const k = (j * f.width + i) * 4;
      return [(f.data[k] / 255) * FIELD_WALL_RANGE, (f.data[k + 1] / 255) * FIELD_FURN_RANGE];
    };
    const P = room.polygon;
    const avoid = [], lines = [];
    for (const h of L.fixtures) {
      const m = h.fixture.mount;
      avoid.push([h.pos[0], h.pos[1], 0.45]);
      if (m === 'lamp' || m === 'strip' || m === 'exterior') continue;
      // A ceiling light is a ring floating at the cut. Seen from the default views it must not appear to
      // hoop a figure, so keep off the strip of floor that the ring covers on screen.
      for (const v of views) {
        const t = Math.tan(v.pol), ux = -Math.sin(v.az), uy = -Math.cos(v.az);
        lines.push([[h.pos[0] + ux * (cut - FIGURE_HEIGHT - 0.1) * t, h.pos[1] + uy * (cut - FIGURE_HEIGHT - 0.1) * t],
          [h.pos[0] + ux * (cut + 0.05) * t, h.pos[1] + uy * (cut + 0.05) * t], 0.36]);
      }
    }
    for (const h of L.cameras) avoid.push([h.pos[0], h.pos[1], 0.5]);
    for (const op of plan.openings) if (op.level === L.id) avoid.push([op.center[0], op.center[1], Math.min(0.9, 0.35 + op.width * 0.4)]);
    const cands = [];
    const step = 0.2, bd = room.bounds;
    for (let y = bd.minY + step / 2; y < bd.maxY; y += step) {
      for (let x = bd.minX + step / 2; x < bd.maxX; x += step) {
        if (!pointInPolygon(x, y, P)) continue;
        if (L.blocked.some((ring) => pointInPolygon(x, y, ring))) continue;
        let edge = Infinity;
        for (let i = 0; i < P.length; i++) edge = Math.min(edge, segmentDistance(x, y, P[i], P[(i + 1) % P.length]));
        const [wall, furn] = sample(x, y);
        let clear = 1;                                        // 0..1: how well it keeps off the things to avoid
        for (const a of avoid) clear = Math.min(clear, Math.hypot(x - a[0], y - a[1]) / a[2]);
        for (const a of lines) clear = Math.min(clear, segmentDistance(x, y, a[0], a[1]) / a[2]);
        // how much of the figure a wall would hide from the default views (0 = stands in the open)
        let hidden = 0;
        for (const v of views) {
          const hit = castRay(x, y, Math.sin(v.az), Math.cos(v.az), L.sightSegs, 1.5);
          hidden += Math.max(0, 1 - hit / (cut * Math.tan(v.pol) * 0.75)) / views.length;
        }
        cands.push({ x, y, edge, wall, furn, clear, hidden, centre: Math.hypot(x - room.centroid[0], y - room.centroid[1]) });
      }
    }
    let pool = [];
    for (const s of [1, 0.7, 0.4, 0.15]) {
      pool = cands.filter((c) => c.edge >= 0.42 * s && c.wall >= 0.42 * s && c.furn >= 0.3 * s && c.clear >= s);
      if (pool.length >= 3 || (s < 0.5 && pool.length)) break;
    }
    const score = (c) => Math.min(c.edge, 0.9) * 0.6 + Math.min(c.wall, 0.6) * 0.5 + c.furn * 0.6 - c.centre * 0.16 - c.hidden * 0.7;
    const spots = [];
    while (spots.length < 6 && pool.length) {
      let best = null, bestScore = -Infinity;
      for (const c of pool) {
        let s = score(c);
        if (spots.length) {
          let near = Infinity;
          for (const q of spots) near = Math.min(near, Math.hypot(c.x - q[0], c.y - q[1]));
          if (near < 0.6) continue;
          s -= Math.abs(near - 0.8) * 1.2;                    // companionable: close, never touching
        }
        if (s > bestScore) { bestScore = s; best = c; }
      }
      if (!best) break;
      spots.push([best.x, best.y]);
    }
    if (!spots.length) spots.push([room.centroid[0], room.centroid[1]]);
    spotCache.set(key, spots);
    return spots;
  }

  const hullMats = track(createHullMaterials(G));
  const roomLineMat = track(createLineMaterial(G, null, { width: 2.5, color: G.uAccent.value, depthTest: false }));

  /** Build the selection outline for a thing. Returns { object, parent } or null. */
  function makeOutline(id) {
    const h = things.get(id);
    if (!h) return null;
    const L = h.level;
    if (!L) return null;                          // a figure that is not standing anywhere
    const hull = (raw) => {
      const geometry = buildHullGeometry(raw.pos, raw.idx);
      const g = new THREE.Group();
      g.geometry = geometry;                     // the caller disposes object.geometry
      const stamp = new THREE.Mesh(geometry, hullMats.mask);
      stamp.renderOrder = 29; stamp.frustumCulled = false;
      g.add(stamp);
      for (const m of hullMats.rims) { const rim = new THREE.Mesh(geometry, m); rim.renderOrder = 30; rim.frustumCulled = false; g.add(rim); }
      return g;
    };
    let object = null, parent = L.group;
    if (h.kind === 'room') {
      const y = h.room.outdoor ? 0.02 : cut + 0.012;   // along the wall tops, where it reads as the room's edge
      object = new THREE.Mesh(buildLineGeometry([{ points: h.room.polygon.map(([x, z]) => [x, y, z]), closed: true }]), roomLineMat);
    } else if (h.kind === 'person') {
      if (!h.mesh || !L) return null;
      object = hull(figureRaw); parent = h.mesh;
    } else if (h.kind === 'camera') {
      object = hull(h.raw);
    } else if (h.kind === 'light') {
      object = hull(L.emissive.raws.get(h.id));
    } else if (h.kind === 'window' || h.style === 'sliding') {
      const s = h.outline();
      object = hull({ pos: s.pos, idx: s.idx });
    } else if (h.kind === 'door') {
      object = hull(h.raw); parent = h.mesh;
    } else if (h.sub === 'car') {
      object = hull(h.raw); parent = h.group;
    } else if (h.kind === 'object') {
      object = hull(h.raw);
    }
    if (!object) return null;
    if (object.isMesh) object.renderOrder = 30;
    object.frustumCulled = false;
    parent.add(object);
    return { object, parent };
  }

  function dispose() {
    for (const d of disposables) d.dispose && d.dispose();
  }

  return { root, levels, things, ground, groundMat, makeOutline, makeFigure, standSpots, dispose, center: [gcx, gcz], reach };
}

function appendPart(builder, part) {
  const target = builder._part();
  const base = target.vertexCount;
  for (const v of part.pos) target.pos.push(v);
  for (const v of part.nor) target.nor.push(v);
  for (const v of part.info) target.info.push(v);
  for (const i of part.idx) target.idx.push(base + i);
}

export { setRangeColor, OPEN_ANGLE };
