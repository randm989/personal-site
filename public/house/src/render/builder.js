// Geometry builder for the clay model. Everything static on a storey is accumulated here and becomes one
// BufferGeometry, so a storey's architecture and furniture are a single draw call.
//
// Coordinates. The builder works in a LOCAL frame set with setFrame(): local x, local y (plan depth) and
// z (height). The frame follows the plan compiler's object convention: with rotation r, local x points
// along plan [cos r, sin r] and local y along plan [-sin r, cos r]; an object's FRONT faces local +y.
// Plan [x, y] maps to three.js (X = x, Z = y), height to Y. Because plan y grows down the page the local
// frame is left-handed, so every face is wound from an explicit outward hint, never from vertex order.
//
// Each vertex carries aInfo = (material slot, room index, baked occlusion 0..1, spare).

import * as THREE from 'three';

/** Palette slots. The clay shader looks the colour up from a uniform array, so themes cross-fade for free. */
export const MAT = {
  floor: 0, wall: 1, cap: 2, furn: 3, slab: 4, leaf: 5, furnDark: 6, furnLight: 7,
  carBody: 8, carGlass: 9, tyre: 10, rug: 11, leafPlain: 12, edge: 13, blind: 14, ground: 15,
  water: 16, deck: 17, drive: 18, figure: 19, device: 20, coping: 21,
};
export const MAT_COUNT = 22;

class Part {
  constructor() { this.pos = []; this.nor = []; this.info = []; this.idx = []; }
  get vertexCount() { return this.pos.length / 3; }
}

export class MassBuilder {
  constructor() {
    this.parts = new Map();
    this.partName = 'body';
    this.room = 0;
    this.baseAO = null;       // when set, overrides the height-based occlusion
    this.setFrame(0, 0, 0, 0);
  }

  /** Local frame: origin at plan [x, y], floor at height baseZ, rotated by r (plan convention). */
  setFrame(x, y, baseZ = 0, r = 0) {
    this.ox = x; this.oy = y; this.oz = baseZ;
    this.cos = Math.cos(r); this.sin = Math.sin(r);
    return this;
  }

  /** Route following primitives into a named part ('body' is the lit clay; 'glow' is emissive detail). */
  part(name) { this.partName = name; return this; }

  _part() {
    let p = this.parts.get(this.partName);
    if (!p) { p = new Part(); this.parts.set(this.partName, p); }
    return p;
  }

  /** local (x, y, z) -> world [X, Y, Z] */
  toWorld(x, y, z) {
    return [this.ox + x * this.cos - y * this.sin, this.oz + z, this.oy + x * this.sin + y * this.cos];
  }
  dirToWorld(x, y, z) {
    return [x * this.cos - y * this.sin, z, x * this.sin + y * this.cos];
  }

  _ao(localZ, opts) {
    if (opts && opts.ao != null) return opts.ao;
    if (this.baseAO != null) return this.baseAO;
    // Gentle darkening toward the floor: reads as contact occlusion on a clay model.
    return 0.8 + 0.2 * Math.min(1, Math.max(0, localZ / 0.45));
  }

  /**
   * A flat polygon (3 or 4+ points, convex, local coords) facing roughly `hint` (local direction).
   * opts: { mat, ao (number or per-vertex array), room }
   */
  poly(points, hint, opts = {}) {
    const p = this._part();
    const w = points.map((q) => this.toWorld(q[0], q[1], q[2]));
    const h = this.dirToWorld(hint[0], hint[1], hint[2]);
    // Newell normal: robust for any planar polygon.
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < w.length; i++) {
      const a = w[i], b = w[(i + 1) % w.length];
      nx += (a[1] - b[1]) * (a[2] + b[2]);
      ny += (a[2] - b[2]) * (a[0] + b[0]);
      nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) return this;                    // degenerate
    nx /= len; ny /= len; nz /= len;
    const flip = nx * h[0] + ny * h[1] + nz * h[2] < 0;
    if (flip) { nx = -nx; ny = -ny; nz = -nz; }
    const base = p.vertexCount;
    const mat = opts.mat ?? MAT.furn;
    const room = opts.room ?? this.room;
    for (let i = 0; i < w.length; i++) {
      p.pos.push(w[i][0], w[i][1], w[i][2]);
      p.nor.push(nx, ny, nz);
      const ao = Array.isArray(opts.ao) ? opts.ao[i] : this._ao(points[i][2], opts);
      p.info.push(mat, room, ao, opts.flag ?? 0);
    }
    for (let i = 1; i < w.length - 1; i++) {
      if (flip) p.idx.push(base, base + i + 1, base + i);
      else p.idx.push(base, base + i, base + i + 1);
    }
    return this;
  }

  /**
   * Axis-aligned box in local coords.
   * opts: { mat, bevel (m, chamfers the top edges and the vertical edges), bottom (false), top (true),
   *         topMat, sides (true), ao }
   */
  box(x0, x1, y0, y1, z0, z1, opts = {}) {
    if (x1 < x0) [x0, x1] = [x1, x0];
    if (y1 < y0) [y0, y1] = [y1, y0];
    if (z1 < z0) [z0, z1] = [z1, z0];
    const b = Math.max(0, Math.min(opts.bevel ?? 0, (x1 - x0) / 2 - 1e-4, (y1 - y0) / 2 - 1e-4, (z1 - z0) - 1e-4));
    const top = opts.top !== false, sides = opts.sides !== false;
    const topOpts = opts.topMat != null ? { ...opts, mat: opts.topMat } : opts;
    if (b <= 0) {
      if (sides) {
        this.poly([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0], opts);
        this.poly([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], [0, 1, 0], opts);
        this.poly([[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]], [-1, 0, 0], opts);
        this.poly([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], [1, 0, 0], opts);
      }
      if (top) this.poly([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], topOpts);
      if (opts.bottom) this.poly([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], [0, 0, -1], opts);
      return this;
    }
    // Chamfered: an octagonal footprint, and a top ring inset by the bevel.
    const oct = (ax0, ax1, ay0, ay1, c, z) => [
      [ax0 + c, ay0, z], [ax1 - c, ay0, z], [ax1, ay0 + c, z], [ax1, ay1 - c, z],
      [ax1 - c, ay1, z], [ax0 + c, ay1, z], [ax0, ay1 - c, z], [ax0, ay0 + c, z],
    ];
    const c = b * 0.7;
    const lo = oct(x0, x1, y0, y1, c, z0);
    const mid = oct(x0, x1, y0, y1, c, z1 - b);
    const up = oct(x0 + b, x1 - b, y0 + b, y1 - b, Math.min(c * 0.5, (x1 - x0) / 2 - b, (y1 - y0) / 2 - b), z1);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    for (let i = 0; i < 8; i++) {
      const j = (i + 1) % 8;
      const mx = (lo[i][0] + lo[j][0]) / 2 - cx, my = (lo[i][1] + lo[j][1]) / 2 - cy;
      if (sides) this.poly([lo[i], lo[j], mid[j], mid[i]], [mx, my, 0], opts);
      if (top) this.poly([mid[i], mid[j], up[j], up[i]], [mx * 0.5, my * 0.5, 1], topOpts);
    }
    if (top) this.poly(up, [0, 0, 1], topOpts);
    if (opts.bottom) this.poly(lo, [0, 0, -1], opts);
    return this;
  }

  /**
   * Cylinder. axis: 'x' | 'y' | 'z' (local). (cx, cy, cz) is the centre.
   * opts: { mat, segments (12), caps (true), ao }
   */
  cyl(cx, cy, cz, radius, length, axis = 'z', opts = {}) {
    const n = opts.segments ?? 12;
    const h = length / 2;
    const at = (ang, s) => {
      const a = Math.cos(ang) * radius, b = Math.sin(ang) * radius;
      if (axis === 'x') return [cx + s, cy + a, cz + b];
      if (axis === 'y') return [cx + a, cy + s, cz + b];
      return [cx + a, cy + b, cz + s];
    };
    const dir = (ang) => {
      const a = Math.cos(ang), b = Math.sin(ang);
      if (axis === 'x') return [0, a, b];
      if (axis === 'y') return [a, 0, b];
      return [a, b, 0];
    };
    const axisDir = axis === 'x' ? [1, 0, 0] : axis === 'y' ? [0, 1, 0] : [0, 0, 1];
    const ringA = [], ringB = [];
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      this.poly([at(a0, -h), at(a1, -h), at(a1, h), at(a0, h)], dir((a0 + a1) / 2), opts);
      ringA.push(at(a0, -h)); ringB.push(at(a0, h));
    }
    if (opts.caps !== false) {
      this.poly(ringB, axisDir, opts.capMat != null ? { ...opts, mat: opts.capMat } : opts);
      this.poly(ringA, axisDir.map((v) => -v), opts.capMat != null ? { ...opts, mat: opts.capMat } : opts);
    }
    return this;
  }

  /**
   * Extrude a side profile along local x (for silhouettes such as a car body).
   * profile: [[y, z], ...] a simple CONVEX polygon in the local y/z plane.
   * opts: { mat, caps (true), ao }
   */
  extrudeX(profile, x0, x1, opts = {}) {
    const n = profile.length;
    let cy = 0, cz = 0;
    for (const [y, z] of profile) { cy += y / n; cz += z / n; }
    for (let i = 0; i < n; i++) {
      const p = profile[i], q = profile[(i + 1) % n];
      const my = (p[0] + q[0]) / 2 - cy, mz = (p[1] + q[1]) / 2 - cz;
      // outward = perpendicular to the edge, pointing away from the centroid
      let ey = q[1] - p[1], ez = -(q[0] - p[0]);
      if (ey * my + ez * mz < 0) { ey = -ey; ez = -ez; }
      this.poly([[x0, p[0], p[1]], [x1, p[0], p[1]], [x1, q[0], q[1]], [x0, q[0], q[1]]], [0, ey, ez], opts);
    }
    if (opts.caps !== false) {
      this.poly(profile.map(([y, z]) => [x0, y, z]), [-1, 0, 0], opts);
      this.poly(profile.map(([y, z]) => [x1, y, z]), [1, 0, 0], opts);
    }
    return this;
  }

  /**
   * Loft between two convex outlines with the same point count (e.g. a car cabin tapering upward).
   * lower/upper: [[x, y, z], ...]. Caps the upper outline.
   */
  loft(lower, upper, opts = {}) {
    const n = lower.length;
    let cx = 0, cy = 0;
    for (const p of lower) { cx += p[0] / n; cy += p[1] / n; }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const mx = (lower[i][0] + lower[j][0]) / 2 - cx, my = (lower[i][1] + lower[j][1]) / 2 - cy;
      this.poly([lower[i], lower[j], upper[j], upper[i]], [mx, my, opts.hintZ ?? 0.2], opts);
    }
    if (opts.top !== false) this.poly(upper, [0, 0, 1], opts.topMat != null ? { ...opts, mat: opts.topMat } : opts);
    return this;
  }

  has(part = 'body') { const p = this.parts.get(part); return !!p && p.idx.length > 0; }

  /** Raw arrays of a part (for outlines and picking). */
  raw(part = 'body') { return this.parts.get(part) || new Part(); }

  toGeometry(part = 'body') {
    const p = this.parts.get(part) || new Part();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(p.nor, 3));
    g.setAttribute('aInfo', new THREE.Float32BufferAttribute(p.info, 4));
    g.setIndex(p.vertexCount > 65535 ? new THREE.Uint32BufferAttribute(p.idx, 1) : new THREE.Uint16BufferAttribute(p.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}
