// Low-detail clay masses for the plan's furniture and fixtures. One entry point: buildObject().
//
// Local frame (set by the caller): x across the width, y along the depth with the object's FRONT at +y
// (sofa back, headboard, cistern, top of the stairs at -y), z up from the floor. Nothing rises above
// ctx.cut except the car. No bottoms are emitted, and stacked parts are inset or offset by a few mm so no
// two visible faces are coplanar and overlapping.

import * as THREE from 'three';
import { MAT } from './builder.js';

const BV = 0.035;      // standard bevel
const EPS = 1e-5;

/**
 * @param {import('./builder.js').MassBuilder} b
 * @param {{id:string,type:string,size:[number,number,number],role?:string}} obj
 * @param {{cut:number}} ctx
 */
export function buildObject(b, obj, ctx) {
  const [w, d, h] = obj.size;
  const cut = ctx && ctx.cut != null ? ctx.cut : 1.2;
  const fn = FORMS[obj.type] || plain;
  b.part('body');
  const meta = fn(b, w, d, h, cut, obj, ctx || {});
  b.part('body');
  return meta || null;
}

/**
 * The part of a flight of stairs above the cut, for the wall-extension mesh that rises when the storey above
 * is shown: treads, risers and a shallow stringer, so the flight is seen arriving through the stairwell.
 */
export function buildStairsAbove(b, obj, cut) {
  const [w, d, h] = obj.size;
  const riser = 0.18;
  const total = Math.max(1, Math.round(h / riser));
  const tread = d / total;
  const x0 = -w / 2, x1 = w / 2;
  const o = { mat: MAT.furn, ao: 1 };
  for (let i = 0; i < total; i++) {
    const zTop = Math.min(h, (i + 1) * riser);
    if (zTop <= cut + EPS) continue;
    const zBot = Math.max(cut, i * riser);
    const y = d / 2 - i * tread, yb = i === total - 1 ? -d / 2 : y - tread;
    const zs = Math.max(cut, zTop - 0.3);
    b.poly([[x0, y, zBot], [x1, y, zBot], [x1, y, zTop], [x0, y, zTop]], [0, 1, 0], { mat: MAT.furn, ao: 0.86 });
    b.poly([[x0, y, zTop], [x1, y, zTop], [x1, yb, zTop], [x0, yb, zTop]], [0, 0, 1], o);
    b.poly([[x0, y, zs], [x0, yb, zs], [x0, yb, zTop], [x0, y, zTop]], [-1, 0, 0], o);
    b.poly([[x1, y, zs], [x1, yb, zs], [x1, yb, zTop], [x1, y, zTop]], [1, 0, 0], o);
  }
}

/** Footprint outline of a pool object in its local frame (used for the hole in the terrace and the basin). */
export function poolLayout(w, d) {
  const m = Math.min(0.2, w * 0.08, d * 0.12);                         // coping width
  const rs = Math.max(0.4, Math.min(0.85, d * 0.3, (d - 2 * m) / 2));
  const spa = w >= rs * 2 + m * 3 + 1.6;                               // room for a spa beside a real pool
  const px0 = spa ? -w / 2 + m + rs * 2 + m * 1.1 : -w / 2 + m;
  const pool = roundRect(px0, w / 2 - m, -d / 2 + m, d / 2 - m, Math.min(0.32, (d - 2 * m) * 0.2));
  let spaRing = null;
  if (spa) {
    spaRing = [];
    const cx = -w / 2 + m + rs;
    for (let i = 0; i < 20; i++) { const a = (i / 20) * Math.PI * 2; spaRing.push([cx + Math.cos(a) * rs, Math.sin(a) * rs]); }
  }
  return { outer: [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]], pool, spa: spaRing };
}

function roundRect(x0, x1, y0, y1, r) {
  const out = [];
  const corners = [[x1 - r, y1 - r, 0], [x0 + r, y1 - r, 1], [x0 + r, y0 + r, 2], [x1 - r, y0 + r, 3]];
  for (const [cx, cy, q] of corners) {
    for (let i = 0; i <= 4; i++) { const a = (q + i / 4) * Math.PI / 2; out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- helpers

/** Bevelled box that is sliced flat (no top chamfer) when it would rise above the cut. */
function tbox(b, x0, x1, y0, y1, z0, z1, cut, opts = {}) {
  if (z1 <= cut + EPS) { b.box(x0, x1, y0, y1, z0, z1, opts); return; }
  const bv = Math.max(0, Math.min(opts.bevel ?? 0, (x1 - x0) / 2 - 1e-3, (y1 - y0) / 2 - 1e-3));
  if (bv <= 0) { b.box(x0, x1, y0, y1, z0, cut, { ...opts, bevel: 0 }); return; }
  b.box(x0, x1, y0, y1, z0, cut + bv, { ...opts, bevel: bv, top: false });
  const c = bv * 0.7;
  b.poly([
    [x0 + c, y0, cut], [x1 - c, y0, cut], [x1, y0 + c, cut], [x1, y1 - c, cut],
    [x1 - c, y1, cut], [x0 + c, y1, cut], [x0, y1 - c, cut], [x0, y0 + c, cut],
  ], [0, 0, 1], { ...opts, mat: opts.topMat ?? opts.mat });
}

/**
 * A bevelled box whose top is recessed: a rim, sloping inner walls and a lower floor (bath, basin, tray).
 * o: { mat, inMat, rim, depth, bevel, slope }
 */
function basin(b, x0, x1, y0, y1, z0, z1, o = {}) {
  const mat = o.mat ?? MAT.furn, inMat = o.inMat ?? MAT.furnLight;
  const bv = Math.min(o.bevel ?? 0.025, (z1 - z0) - 1e-3);
  const rim = Math.max(o.rim ?? 0.06, bv * 1.5 + 0.005);
  const depth = o.depth ?? 0.2, slope = o.slope ?? 0.03;
  const c = bv * 0.7, c2 = c * 0.5;
  b.box(x0, x1, y0, y1, z0, z1, { mat, bevel: bv, top: false });
  const oct = (ax0, ax1, ay0, ay1, cc, z) => [
    [ax0 + cc, ay0, z], [ax1 - cc, ay0, z], [ax1, ay0 + cc, z], [ax1, ay1 - cc, z],
    [ax1 - cc, ay1, z], [ax0 + cc, ay1, z], [ax0, ay1 - cc, z], [ax0, ay0 + cc, z],
  ];
  const mid = oct(x0, x1, y0, y1, c, z1 - bv);
  const up = oct(x0 + bv, x1 - bv, y0 + bv, y1 - bv, c2, z1);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  for (let i = 0; i < 8; i++) {
    const j = (i + 1) % 8;
    const mx = (mid[i][0] + mid[j][0]) / 2 - cx, my = (mid[i][1] + mid[j][1]) / 2 - cy;
    b.poly([mid[i], mid[j], up[j], up[i]], [mx * 0.5, my * 0.5, 1], { mat });
  }
  // rim top: ring between the chamfered outline and the inner rectangle
  const I = [[x0 + rim, y0 + rim, z1], [x1 - rim, y0 + rim, z1], [x1 - rim, y1 - rim, z1], [x0 + rim, y1 - rim, z1]];
  const U = [0, 0, 1];
  b.poly([up[0], up[1], I[1], I[0]], U, { mat });
  b.poly([up[1], up[2], I[1]], U, { mat });
  b.poly([up[2], up[3], I[2], I[1]], U, { mat });
  b.poly([up[3], up[4], I[2]], U, { mat });
  b.poly([up[4], up[5], I[3], I[2]], U, { mat });
  b.poly([up[5], up[6], I[3]], U, { mat });
  b.poly([up[6], up[7], I[0], I[3]], U, { mat });
  b.poly([up[7], up[0], I[0]], U, { mat });
  // inner walls and floor
  const zf = z1 - depth;
  const F = [[x0 + rim + slope, y0 + rim + slope, zf], [x1 - rim - slope, y0 + rim + slope, zf],
    [x1 - rim - slope, y1 - rim - slope, zf], [x0 + rim + slope, y1 - rim - slope, zf]];
  const inward = [[0, 1, 0.4], [-1, 0, 0.4], [0, -1, 0.4], [1, 0, 0.4]];
  const aoW = o.aoWall ?? 0.86, aoF = o.aoFloor ?? 0.8;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    b.poly([I[i], I[j], F[j], F[i]], inward[i], { mat: inMat, ao: [0.97, 0.97, aoW, aoW] });
  }
  b.poly(F, U, { mat: inMat, ao: aoF });
}

/** Carcass with a row of door slabs across the front (+y); the gaps read as split lines, also on a cut top. */
function doored(b, w, d, h, cut, n, o = {}) {
  const dt = 0.035, gap = 0.014, mat = o.mat ?? MAT.furn, doorMat = o.doorMat ?? mat;
  tbox(b, -w / 2, w / 2, -d / 2, d / 2 - dt, 0, h, cut, { mat, bevel: BV });
  const x0 = -w / 2 + 0.012, span = w - 0.024, each = (span - gap * (n - 1)) / n;
  for (let i = 0; i < n; i++) {
    const a = x0 + i * (each + gap);
    tbox(b, a, a + each, d / 2 - dt - 0.01, d / 2, 0.06, h - 0.012, cut, { mat: doorMat, bevel: 0.012 });
  }
}

function plain(b, w, d, h, cut) {
  tbox(b, -w / 2, w / 2, -d / 2, d / 2, 0, h, cut, { mat: MAT.furn, bevel: BV });
}

// ------------------------------------------------------------------------------------------------ seats

function seating(b, w, d, h, cut, cushions) {
  const aw = Math.min(0.2, w * 0.2), bd = Math.min(0.24, d * 0.28);
  const H = Math.min(h, cut), armH = H * 0.76, seatH = H * 0.54, baseH = seatH - 0.12;
  // arms run the full depth, the back sits between them
  b.box(-w / 2, -w / 2 + aw, -d / 2, d / 2, 0, armH, { bevel: BV });
  b.box(w / 2 - aw, w / 2, -d / 2, d / 2, 0, armH, { bevel: BV });
  b.box(-w / 2 + aw - 0.004, w / 2 - aw + 0.004, -d / 2 + 0.01, -d / 2 + bd, 0, H, { bevel: BV });
  // base and seat cushions
  const sx0 = -w / 2 + aw - 0.004, sx1 = w / 2 - aw + 0.004, sy0 = -d / 2 + bd - 0.004, sy1 = d / 2 - 0.03;
  b.box(sx0, sx1, sy0, sy1 - 0.02, 0, baseH, { bevel: 0.015 });
  const g = 0.025, each = (sx1 - sx0 - 0.016 - g * (cushions - 1)) / cushions;
  for (let i = 0; i < cushions; i++) {
    const a = sx0 + 0.008 + i * (each + g);
    b.box(a, a + each, sy0 + 0.004, sy1, baseH - 0.01, seatH, { bevel: BV });
  }
}

function bed(b, w, d, h, cut) {
  const hb = 0.08, H = Math.min(h, cut);
  const baseH = H * 0.5, headH = Math.min(H + 0.38, cut);
  b.box(-w / 2, w / 2, -d / 2, -d / 2 + hb, 0, headH, { bevel: 0.03 });                       // headboard
  b.box(-w / 2 + 0.02, w / 2 - 0.02, -d / 2 + hb - 0.004, d / 2, 0, baseH, { bevel: 0.02 });   // base
  const my0 = -d / 2 + hb + 0.006;
  b.box(-w / 2 + 0.045, w / 2 - 0.045, my0, d / 2 - 0.03, baseH - 0.01, H, { mat: MAT.furnLight, bevel: BV });
  // duvet over the foot two thirds, a touch wider and higher than the mattress
  const dy0 = -d / 2 + d * 0.36;
  b.box(-w / 2 + 0.012, w / 2 - 0.012, dy0, d / 2 - 0.012, baseH + 0.04, H + 0.035, { bevel: BV });
  // pillows
  const n = w > 1.25 ? 2 : 1, pg = 0.08, px0 = -w / 2 + 0.12, span = w - 0.24;
  const pw = (span - pg * (n - 1)) / n, pd = Math.min(0.42, d * 0.2);
  for (let i = 0; i < n; i++) {
    const a = px0 + i * (pw + pg);
    b.box(a, a + pw, my0 + 0.05, my0 + 0.05 + pd, H - 0.01, H + 0.1, { mat: MAT.furnLight, bevel: 0.045 });
  }
}

// ----------------------------------------------------------------------------------------------- tables

function table(b, w, d, h, cut) {
  const H = Math.min(h, cut), tt = 0.055, leg = 0.075, ins = 0.07;
  b.box(-w / 2, w / 2, -d / 2, d / 2, H - tt, H, { bevel: 0.022, bottom: true });
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    const x = sx * (w / 2 - ins - leg / 2), y = sy * (d / 2 - ins - leg / 2);
    b.box(x - leg / 2, x + leg / 2, y - leg / 2, y + leg / 2, 0, H - tt, { top: false });
  }
}

function desk(b, w, d, h, cut) {
  const H = Math.min(h, cut), tt = 0.05, pt = 0.05;
  b.box(-w / 2, w / 2, -d / 2, d / 2, H - tt, H, { bevel: 0.022, bottom: true });
  for (const s of [-1, 1]) {
    const x = s * (w / 2 - 0.035 - pt / 2);
    b.box(x - pt / 2, x + pt / 2, -d / 2 + 0.03, d / 2 - 0.03, 0, H - tt, { top: false });
  }
  // modesty panel across the front (the sitter is on the -y side, facing the room)
  b.box(-w / 2 + 0.035 + pt, w / 2 - 0.035 - pt, d / 2 - 0.07, d / 2 - 0.04, H * 0.35, H - tt, { top: false, bottom: true });
}

// ---------------------------------------------------------------------------------------------- kitchen

function counter(b, w, d, h, cut) {
  const H = Math.min(h, cut), wt = 0.04;
  b.box(-w / 2 + 0.004, w / 2 - 0.004, -d / 2 + 0.004, d / 2 - 0.03, 0, H - wt, { bevel: 0.012, top: false });
  b.box(-w / 2, w / 2, -d / 2, d / 2, H - wt, H, { mat: MAT.furnLight, bevel: 0.015, bottom: true });
}

function island(b, w, d, h, cut) {
  const H = Math.min(h, cut), wt = 0.05, o = 0.04;
  b.box(-w / 2 + o, w / 2 - o, -d / 2 + o, d / 2 - o, 0, H - wt, { bevel: 0.012, top: false });
  b.box(-w / 2, w / 2, -d / 2, d / 2, H - wt, H, { mat: MAT.furnLight, bevel: 0.018, bottom: true });
}

function stove(b, w, d, h, cut) {
  const H = Math.min(h, cut), hob = H - 0.012;
  b.box(-w / 2, w / 2, -d / 2, d / 2, 0, hob - 0.012, { bevel: 0.02 });
  b.box(-w / 2 + 0.02, w / 2 - 0.02, -d / 2 + 0.02, d / 2 - 0.02, hob - 0.03, hob, { mat: MAT.furnDark, bevel: 0.01 });
  const r = Math.min(w, d) * 0.15;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    b.cyl(sx * w * 0.22, sy * d * 0.21, hob + 0.001, r, 0.022, 'z', { mat: MAT.furn, segments: 10, ao: 1 });
  }
  // oven door on the front
  b.box(-w / 2 + 0.06, w / 2 - 0.06, d / 2 - 0.02, d / 2 + 0.008, 0.12, hob - 0.14, { mat: MAT.furnDark, bevel: 0.006 });
}

function fridge(b, w, d, h, cut) {
  doored(b, w, d, h, cut, 2);
}

// ------------------------------------------------------------------------------------------- appliances

function tv(b, w, d, h, cut) {
  const H = Math.min(h, cut);
  const standH = Math.min(0.42, H * 0.36);
  b.box(-w / 2, w / 2, -d / 2, d / 2, 0, standH, { bevel: 0.025 });                 // low console
  const pt = 0.05, py0 = -pt / 2 - 0.02, py1 = py0 + pt;                           // the panel, a little back
  b.box(-w / 2 + 0.05, w / 2 - 0.05, py0, py1, standH - 0.01, H, { mat: MAT.furnDark, bevel: 0.012 });
  b.part('glow');
  b.box(-w / 2 + 0.085, w / 2 - 0.085, py1 - 0.006, py1 + 0.01, standH + 0.06, H - 0.035,
    { mat: MAT.furnDark, bottom: true, ao: 1 });
  b.part('body');
}

function laundry(b, w, d, h, cut) {
  const H = Math.min(h, cut);
  b.box(-w / 2, w / 2, -d / 2, d / 2, 0, H, { bevel: BV });
  // control strip along the back of the top
  b.box(-w / 2 + 0.05, w / 2 - 0.05, -d / 2 + 0.045, -d / 2 + 0.14, H - 0.02, H + 0.008, { mat: MAT.furnDark });
  // door
  const zc = H * 0.5, r = Math.min(w, H) * 0.3, f = d / 2;
  b.cyl(0, f - 0.004, zc, r, 0.032, 'y', { mat: MAT.furnDark, segments: 16, ao: 0.95 });   // front at f + 0.012
  // glow ring around the door: front annulus and both walls, 18 mm proud of the cabinet front
  const n = 16, r1 = r + 0.012, r2 = r + 0.055, yf = f + 0.018;
  const pt = (rad, a, y) => [Math.cos(a) * rad, y, zc + Math.sin(a) * rad];
  b.part('glow');
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2, am = (a0 + a1) / 2;
    const o = { mat: MAT.furnDark, ao: 1 };
    b.poly([pt(r1, a0, yf), pt(r1, a1, yf), pt(r2, a1, yf), pt(r2, a0, yf)], [0, 1, 0], o);
    b.poly([pt(r2, a0, f - 0.004), pt(r2, a1, f - 0.004), pt(r2, a1, yf), pt(r2, a0, yf)], [Math.cos(am), 0, Math.sin(am)], o);
    b.poly([pt(r1, a0, f - 0.004), pt(r1, a1, f - 0.004), pt(r1, a1, yf), pt(r1, a0, yf)], [-Math.cos(am), 0, -Math.sin(am)], o);
  }
  b.part('body');
}

// --------------------------------------------------------------------------------------------- bathroom

function toilet(b, w, d, h, cut) {
  const H = Math.min(h, cut), cd = Math.min(0.2, d * 0.3), bowlH = Math.min(0.42, H * 0.55);
  b.box(-w / 2, w / 2, -d / 2, -d / 2 + cd, 0, H, { bevel: 0.025 });                 // cistern
  const r = w / 2 - 0.015, yc = d / 2 - r - 0.005;
  b.box(-r, r, -d / 2 + cd - 0.004, yc, 0, bowlH, { bevel: 0, top: true });
  b.cyl(0, yc, bowlH / 2, r, bowlH, 'z', { segments: 12 });
  // seat and lid
  b.box(-r + 0.02, r - 0.02, -d / 2 + cd + 0.004, yc, bowlH - 0.01, bowlH + 0.025, { mat: MAT.furnLight });
  b.cyl(0, yc, bowlH + 0.0075, r - 0.02, 0.035, 'z', { mat: MAT.furnLight, segments: 12 });
}

function bath(b, w, d, h, cut) {
  const H = Math.min(h, cut);
  basin(b, -w / 2, w / 2, -d / 2, d / 2, 0, H, { rim: 0.075, depth: Math.min(0.3, H * 0.6), slope: 0.05, bevel: 0.03 });
}

function shower(b, w, d, h, cut) {
  const H = Math.min(h, cut);
  basin(b, -w / 2, w / 2, -d / 2, d / 2, 0, 0.1, { rim: 0.06, depth: 0.05, slope: 0.02, bevel: 0.02, aoWall: 0.9, aoFloor: 0.9 });
  // corner posts and a glass screen across the front, all sliced at the cut
  const p = 0.055;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    const x = sx * (w / 2 - p / 2 - 0.008), y = sy * (d / 2 - p / 2 - 0.008);
    b.box(x - p / 2, x + p / 2, y - p / 2, y + p / 2, 0.09, H, {});
  }
  const gy = d / 2 - 0.008 - p / 2;
  b.box(-w / 2 + p + 0.012, w / 2 - p - 0.012, gy - 0.016, gy + 0.016, 0.09, H - 0.004, { mat: MAT.furnLight });
}

function vanity(b, w, d, h, cut) {
  const H = Math.min(h, cut);
  b.box(-w / 2, w / 2, -d / 2, d / 2, 0, H - 0.03, { bevel: 0.02 });
  const n = w >= 1.5 ? 2 : 1, bw = Math.min(0.56, w / n - 0.14), by0 = -d / 2 + 0.07, by1 = d / 2 - 0.05;
  for (let i = 0; i < n; i++) {
    const cx = n === 1 ? 0 : (i === 0 ? -w / 4 : w / 4);
    basin(b, cx - bw / 2, cx + bw / 2, by0, by1, H - 0.05, H, { mat: MAT.furnLight, inMat: MAT.furnLight, rim: 0.04, depth: 0.09, slope: 0.035, bevel: 0.018, aoWall: 0.78, aoFloor: 0.7 });
  }
}

// ---------------------------------------------------------------------------------------------- storage

function wardrobe(b, w, d, h, cut) {
  doored(b, w, d, h, cut, Math.max(2, Math.round(w / 0.6)));
}

function shelf(b, w, d, h, cut) {
  if (h <= cut - 0.3) {
    // low unit / bench: body, a proud top and one division line on the front
    b.box(-w / 2 + 0.015, w / 2 - 0.015, -d / 2 + 0.015, d / 2 - 0.015, 0, h - 0.04, { bevel: 0.012, top: false });
    b.box(-w / 2, w / 2, -d / 2, d / 2, h - 0.04, h, { bevel: 0.018, bottom: true });
    return;
  }
  // open shelving sliced at the cut: back, ends, dividers, and the next shelf board visible below the slice
  const H = Math.min(h, cut), t = 0.035, n = Math.max(2, Math.round(w / 0.75));
  b.box(-w / 2, w / 2, -d / 2, -d / 2 + t, 0, H, {});
  for (let i = 0; i <= n; i++) {
    const x = -w / 2 + t / 2 + (i / n) * (w - t);
    b.box(x - t / 2, x + t / 2, -d / 2 + t, d / 2, 0, H, {});
  }
  b.box(-w / 2 + t, w / 2 - t, -d / 2 + t, d / 2 - 0.012, 0, H - 0.22, { sides: true, ao: 0.82 });
}

function stairs(b, w, d, h, cut) {
  const riser = 0.18;
  const total = Math.max(1, Math.round(h / riser));
  const tread = d / total;
  const x0 = -w / 2, x1 = w / 2;
  let y = d / 2, z = 0, i = 0;
  while (z < cut - EPS && i < total) {
    const z1 = Math.min(z + riser, cut);
    // the sliced step gets a deeper flat so the cut reads as a landing-sized face
    const yb = (z1 >= cut - EPS) ? Math.max(-d / 2, y - tread * 2) : y - tread;
    b.poly([[x0, y, z], [x1, y, z], [x1, y, z1], [x0, y, z1]], [0, 1, 0], {});                 // riser
    b.poly([[x0, y, z1], [x1, y, z1], [x1, yb, z1], [x0, yb, z1]], [0, 0, 1], {});             // tread
    b.poly([[x0, y, 0], [x0, yb, 0], [x0, yb, z1], [x0, y, z1]], [-1, 0, 0], {});
    b.poly([[x1, y, 0], [x1, yb, 0], [x1, yb, z1], [x1, y, z1]], [1, 0, 0], {});
    y = yb; z = z1; i++;
  }
  b.poly([[x0, y, 0], [x1, y, 0], [x1, y, z], [x0, y, z]], [0, -1, 0], {});                    // back
}

function rug(b, w, d, h) {
  b.box(-w / 2, w / 2, -d / 2, d / 2, 0, 0.015, { mat: MAT.rug, bevel: 0, ao: 1 });
}

// -------------------------------------------------------------------------------------------------- car
//
// Authored at 1.9 x 4.6 x 1.45 m and scaled to obj.size. Nose at +y. The lower body is a convex side
// profile; the centre is one extrusion, and each flank is the same profile cut into convex pieces around
// polygonal wheel arches, with the overhangs drawn in toward the nose and tail (chamfered plan corners).

const CAR_PROFILE = [
  [2.18, 0.20], [2.30, 0.44], [2.24, 0.70], [1.88, 0.80], [1.15, 0.92], [-1.75, 0.97], [-2.18, 0.92], [-2.30, 0.72], [-2.22, 0.20],
];

/** Clip a convex [y, z] polygon to ny*y + nz*z <= c. */
function clip(poly, ny, nz, c) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const dp = ny * p[0] + nz * p[1] - c, dq = ny * q[0] + nz * q[1] - c;
    if (dp <= 0) out.push(p);
    if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) {
      const t = dp / (dp - dq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

function car(b, w, d, h) {
  const sx = w / 1.9, sy = d / 4.6, sz = h / 1.45;
  const P = (x, y, z) => [x * sx, y * sy, z * sz];
  const body = MAT.carBody, glass = MAT.carGlass, tyre = MAT.tyre;

  const XO = 0.95, XI = 0.64;              // flank outer face, centre extrusion half width
  const CF = 1.45, CR = -1.45;             // axle positions
  const ZC = 0.33, RW = 0.33, RA = 0.39;   // wheel centre height, wheel radius, arch radius
  const ZT = ZC + RA;                      // arch top
  const YF = CF + RA, YR = CR - RA;        // where the overhangs begin
  const TF = 0.22, TR = 0.15;              // plan taper of nose / tail corners
  const ZB = 0.20;
  const xOut = (y) => (y > YF ? XO - TF * (y - YF) / (2.30 - YF) : y < YR ? XO - TR * (YR - y) / (YR + 2.30) : XO);
  const near = (a, v) => Math.abs(a - v) < 1e-6;

  /** Prism of a convex [y,z] polygon from x = s*xa to x = s*xb(y). skip(p, q) drops an edge face. */
  const prism = (poly, s, xa, xb, o) => {
    if (poly.length < 3) return;
    const n = poly.length;
    let cy = 0, cz = 0;
    for (const p of poly) { cy += p[0] / n; cz += p[1] / n; }
    const xbf = typeof xb === 'function' ? xb : () => xb;
    for (let i = 0; i < n; i++) {
      const p = poly[i], q = poly[(i + 1) % n];
      if (Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6) continue;
      if (o.skip && o.skip(p, q)) continue;
      let ey = q[1] - p[1], ez = -(q[0] - p[0]);
      if (ey * ((p[0] + q[0]) / 2 - cy) + ez * ((p[1] + q[1]) / 2 - cz) < 0) { ey = -ey; ez = -ez; }
      b.poly([P(s * xa, p[0], p[1]), P(s * xbf(p[0]), p[0], p[1]), P(s * xbf(q[0]), q[0], q[1]), P(s * xa, q[0], q[1])],
        [0, ey, ez], { mat: o.mat });
    }
    if (o.capOuter !== false) b.poly(poly.map((p) => P(s * xbf(p[0]), p[0], p[1])), [s, 0, 0], { mat: o.capMat ?? o.mat });
    if (o.capInner) b.poly(poly.map((p) => P(s * xa, p[0], p[1])), [-s, 0, 0], { mat: o.capMat ?? o.mat });
  };

  const bottom = (p, q) => near(p[1], ZB) && near(q[1], ZB);

  // centre: full profile; its side caps are the dark wheel-well backs
  prism(CAR_PROFILE, 1, -XI, XI, { mat: body, skip: bottom, capMat: tyre, capInner: true });

  // flanks
  for (const s of [-1, 1]) {
    const o = (skip) => ({ mat: body, skip });
    prism(clip(CAR_PROFILE, -1, 0, -YF), s, XI, xOut, o(bottom));                                    // nose corner
    prism(clip(CAR_PROFILE, 1, 0, YR), s, XI, xOut, o(bottom));                                      // tail corner
    const band = clip(clip(clip(CAR_PROFILE, 0, -1, -ZT), 1, 0, YF), -1, 0, -YR);                    // above the arches
    prism(band, s, XI, XO, o((p, q) => (near(p[1], ZT) && near(q[1], ZT)) || (near(p[0], YF) && near(q[0], YF)) || (near(p[0], YR) && near(q[0], YR))));
    const sill = clip(clip(clip(CAR_PROFILE, 0, 1, ZT), 1, 0, CF - RA), -1, 0, -(CR + RA));          // between the arches
    prism(sill, s, XI, XO, o((p, q) => bottom(p, q) || (near(p[1], ZT) && near(q[1], ZT))));
    for (const c of [CF, CR]) for (const g of [-1, 1]) {                                             // arch corner fillets
      const ya = c + g * RA, yc = c + g * RA * 0.42, za = ZC + RA * 0.42;
      prism([[ya, za], [ya, ZT], [yc, ZT]], s, XI, XO,
        o((p, q) => (near(p[0], ya) && near(q[0], ya)) || (near(p[1], ZT) && near(q[1], ZT))));
    }
  }

  // wheels, a little inside the flank, with a body-colour hub disc
  const rs = Math.min(sy, sz);
  for (const s of [-1, 1]) for (const c of [CF, CR]) {
    b.cyl(s * (XO - 0.145) * sx, c * sy, ZC * sz, RW * rs, 0.25 * sx, 'x', { mat: tyre, segments: 14 });
    b.cyl(s * (XO - 0.03) * sx, c * sy, ZC * sz, RW * 0.6 * rs, 0.03 * sx, 'x', { mat: body, segments: 10, ao: 0.9 });
  }

  // greenhouse: glass all round, body-colour roof
  const topZ = (y) => {
    const t = [[2.24, 0.70], [1.88, 0.80], [1.15, 0.92], [-1.75, 0.97], [-2.18, 0.92]];
    for (let i = 0; i < t.length - 1; i++) {
      if (y <= t[i][0] && y >= t[i + 1][0]) return t[i][1] + (t[i + 1][1] - t[i][1]) * (t[i][0] - y) / (t[i][0] - t[i + 1][0]);
    }
    return 0.92;
  };
  const belt = (x, y) => P(x, y, topZ(y) - 0.012);
  const Y0 = 1.14, YT = -2.0;                                   // windscreen base, rear glass base
  const R = [[0.42, 1.385, 0.67], [-0.34, 1.45, 0.69], [-1.14, 1.37, 0.66]];   // roof stations: y, z, half width
  const BW = [0.86, 0.865, 0.855];                             // belt half widths under the roof stations
  const W0 = 0.81, WT = 0.77;
  const g = { mat: glass };
  b.poly([belt(-W0, Y0), belt(W0, Y0), P(R[0][2], R[0][0], R[0][1]), P(-R[0][2], R[0][0], R[0][1])], [0, 1, 1], g);      // windscreen
  b.poly([belt(-WT, YT), belt(WT, YT), P(R[2][2], R[2][0], R[2][1]), P(-R[2][2], R[2][0], R[2][1])], [0, -1, 1], g);     // rear glass
  for (let i = 0; i < 2; i++) {                                                                                         // roof
    b.poly([P(-R[i][2], R[i][0], R[i][1]), P(R[i][2], R[i][0], R[i][1]), P(R[i + 1][2], R[i + 1][0], R[i + 1][1]), P(-R[i + 1][2], R[i + 1][0], R[i + 1][1])],
      [0, 0, 1], { mat: body, ao: 1 });
  }
  for (const s of [-1, 1]) {
    const hint = [s, 0, 0.3];
    const rp = (i) => P(s * R[i][2], R[i][0], R[i][1]);
    const bp = (i) => belt(s * BW[i], R[i][0]);
    b.poly([belt(s * W0, Y0), bp(0), rp(0)], hint, g);
    b.poly([bp(0), bp(1), rp(1), rp(0)], hint, g);
    b.poly([bp(1), bp(2), rp(2), rp(1)], hint, g);
    b.poly([bp(2), belt(s * WT, YT), rp(2)], hint, g);
  }

  // glow: slim headlights, a tail light bar and a charge-port mark (all 8 mm proud of the body)
  const strip = (p0, p1, za, zb, xa, xb) => {
    const at = (z) => [p0[0] + (p1[0] - p0[0]) * (z - p0[1]) / (p1[1] - p0[1]), z];
    let ny = p1[1] - p0[1], nz = -(p1[0] - p0[0]);
    const l = Math.hypot(ny, nz); ny /= l; nz /= l;
    if (ny * p0[0] < 0) { ny = -ny; nz = -nz; }                // outward = away from the car centre
    const a = at(za), c = at(zb), T = 0.008, IN = 0.01;
    const poly = [[a[0] - ny * IN, a[1] - nz * IN], [a[0] + ny * T, a[1] + nz * T], [c[0] + ny * T, c[1] + nz * T], [c[0] - ny * IN, c[1] - nz * IN]];
    prism(poly, 1, xa, xb, { mat: MAT.furnDark, capInner: true });
  };
  b.part('glow');
  strip([2.30, 0.44], [2.24, 0.70], 0.585, 0.645, 0.24, 0.63);
  strip([2.30, 0.44], [2.24, 0.70], 0.585, 0.645, -0.63, -0.24);
  strip([-2.30, 0.72], [-2.18, 0.92], 0.80, 0.85, -0.63, 0.63);
  {
    const a = P(-XO - 0.008, -1.66, 0.835), c = P(-XO + 0.01, -1.50, 0.905);
    b.box(a[0], c[0], a[1], c[1], a[2], c[2], { mat: MAT.furnDark, bottom: true });
  }
  b.part('body');
}

// ---------------------------------------------------------------------------------------------- scenery

/** Chimney breast against the wall (back at -y): masonry sliced at the cut with its flue, a firebox, a hearth. */
function fireplace(b, w, d, h, cut) {
  const H = Math.min(h, cut), sliced = h >= cut - EPS;
  b.box(-w / 2, w / 2, -d / 2, d / 2, 0, H, { mat: MAT.wall, topMat: sliced ? MAT.cap : MAT.wall });
  if (sliced) {
    const fw = Math.min(0.42, w * 0.3), fd = Math.min(0.2, d * 0.42);
    b.poly([[-fw / 2, -fd / 2, H + 0.003], [fw / 2, -fd / 2, H + 0.003], [fw / 2, fd / 2, H + 0.003], [-fw / 2, fd / 2, H + 0.003]],
      [0, 0, 1], { mat: MAT.furnDark, ao: 1 });
  } else {
    b.box(-w / 2 - 0.04, w / 2 + 0.04, -d / 2, d / 2 + 0.08, H, H + 0.05, { mat: MAT.furnLight, bevel: 0.012, bottom: true });
  }
  const ow = Math.min(w * 0.56, 0.95), oh = Math.min(0.66, H * 0.62);
  b.box(-ow / 2, ow / 2, d / 2, d / 2 + 0.008, 0.06, oh, { mat: MAT.furnDark, ao: 0.9 });         // firebox
  b.box(-w / 2 - 0.06, w / 2 + 0.06, d / 2 - 0.004, d / 2 + 0.38, 0, 0.055, { mat: MAT.furnLight, bevel: 0.015 });   // hearth
}

/** A games console on a low plinth at media-shelf height; a status strip along its front edge can glow. */
function consoleBox(b, w, d, h, cut) {
  const zs = h < 0.3 ? Math.max(0.2, Math.min(0.42, cut - h - 0.05)) : 0;
  if (zs > 0) b.box(-w / 2 - 0.035, w / 2 + 0.035, -d / 2 - 0.02, d / 2 + 0.035, 0, zs, { bevel: 0.02 });
  const z1 = Math.min(cut, zs + h);
  b.box(-w / 2, w / 2, -d / 2, d / 2, zs + 0.002, z1, { mat: MAT.furnLight, bevel: Math.min(0.018, h * 0.2) });
  b.part('glow');
  const sd = Math.min(0.075, d * 0.3);
  b.box(-w / 2 + 0.03, w / 2 - 0.03, d / 2 - sd - 0.012, d / 2 - 0.012, z1 - 0.004, z1 + 0.009, { mat: MAT.furnDark, bottom: true, ao: 1 });
  b.part('body');
  return { halo: [0, d / 2 - sd, z1 + 0.03, 0.3] };
}

/** A desktop 3D printer: an open frame on a stand. The print itself is a separate block that grows (scene.js). */
function printer3d(b, w, d, h, cut) {
  const zs = h <= 0.7 ? Math.max(0, Math.min(0.6, cut - h - 0.04)) : 0;
  if (zs > 0.05) b.box(-w / 2 - 0.06, w / 2 + 0.06, -d / 2 - 0.05, d / 2 + 0.06, 0, zs, { bevel: 0.022 });
  const z1 = Math.min(cut, zs + h);
  const p = Math.max(0.03, Math.min(w, d) * 0.085);
  b.box(-w / 2, w / 2, -d / 2, d / 2, zs + 0.002, zs + 0.05, { mat: MAT.furnDark, bevel: 0.01 });           // base
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {                                                    // posts
    const x = sx * (w / 2 - p / 2), y = sy * (d / 2 - p / 2);
    b.box(x - p / 2, x + p / 2, y - p / 2, y + p / 2, zs + 0.048, z1 - p, { mat: MAT.device, top: false });
  }
  for (const s of [-1, 1]) {                                                                               // top frame
    b.box(-w / 2, w / 2, s * (d / 2 - p / 2) - p / 2, s * (d / 2 - p / 2) + p / 2, z1 - p, z1, { mat: MAT.device, bottom: true });
    b.box(s * (w / 2 - p / 2) - p / 2, s * (w / 2 - p / 2) + p / 2, -d / 2 + p, d / 2 - p, z1 - p, z1, { mat: MAT.device, bottom: true });
  }
  const i = p + 0.02;
  b.box(-w / 2 + i, w / 2 - i, -d / 2 + i, d / 2 - i, zs + 0.05, zs + 0.062, { mat: MAT.furnLight, ao: 0.9 });   // bed
  const j = i + 0.025;
  return {
    fill: { x0: -w / 2 + j, x1: w / 2 - j, y0: -d / 2 + j, y1: d / 2 - j, z0: zs + 0.063, z1: z1 - 0.012 },
    halo: [0, 0, (zs + z1) / 2 + 0.1, 0.5],
  };
}

/** Pool and spa: flat water set down into a coping. ctx.inset says the terrace has a hole for it. */
function pool(b, w, d, h, cut, obj, ctx) {
  // Inset: the coping is a low kerb standing on the terrace and the water lies just below the paving. (It
  // cannot go deeper: the studio ground is a few centimetres under the slab and would show through.)
  const inset = !!ctx.inset;
  const slab = inset ? (ctx.top ?? 0) : 0;
  const top = inset ? slab + 0.03 : 0.07;
  const lay = poolLayout(w, d);
  const holes = lay.spa ? [lay.pool, lay.spa] : [lay.pool];
  const all = [...lay.outer, ...holes.flat()];
  const V = (ring) => ring.map((q) => new THREE.Vector2(q[0], q[1]));
  for (const t of THREE.ShapeUtils.triangulateShape(V(lay.outer), holes.map(V))) {
    b.poly(t.map((i) => [all[i][0], all[i][1], top]), [0, 0, 1], { mat: MAT.coping, ao: 1 });
  }
  for (let i = 0; i < 4; i++) {
    const p = lay.outer[i], q = lay.outer[(i + 1) % 4];
    b.poly([[p[0], p[1], slab], [q[0], q[1], slab], [q[0], q[1], top], [p[0], p[1], top]], [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, 0], { mat: MAT.coping, ao: 0.9 });
  }
  holes.forEach((ring, k) => {
    const zw = top - (k === 0 ? 0.062 : 0.03);                                      // the spa sits a little higher
    let cx = 0, cy = 0;
    for (const q of ring) { cx += q[0] / ring.length; cy += q[1] / ring.length; }
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length];
      b.poly([[p[0], p[1], zw], [q[0], q[1], zw], [q[0], q[1], top], [p[0], p[1], top]],
        [cx - (p[0] + q[0]) / 2, cy - (p[1] + q[1]) / 2, 0], { mat: MAT.coping, ao: [0.72, 0.72, 0.95, 0.95] });
    }
    b.poly(ring.map((q) => [q[0], q[1], zw]), [0, 0, 1], { mat: MAT.water, ao: 1 });
  });
}

const FORMS = {
  fireplace, console: consoleBox, printer3d, pool,
  sofa: (b, w, d, h, cut) => seating(b, w, d, h, cut, w > 1.5 ? 2 : 1),
  armchair: (b, w, d, h, cut) => seating(b, w, d, h, cut, 1),
  bed, table, desk, counter, island, fridge, stove, tv,
  washer: laundry, dryer: laundry,
  toilet, bath, shower, vanity, wardrobe, stairs, car, shelf, rug,
};
