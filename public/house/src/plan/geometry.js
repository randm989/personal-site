// Pure 2D geometry helpers for the plan compiler. No DOM, no three.js.
// Points are [x, y] in plan coordinates: x grows right (east), y grows DOWN the page (south).

export const EPS = 1e-6;

/** Round away float noise (and avoid -0). */
export function round6(v) {
  const r = Math.round(v * 1e6) / 1e6;
  return r === 0 ? 0 : r;
}

/**
 * Signed shoelace area, sum(x_i * y_{i+1} - x_{i+1} * y_i) / 2.
 * Because y grows down the page, a POSITIVE value means the polygon runs clockwise as seen on the page,
 * and a NEGATIVE value means counter-clockwise as seen on the page.
 */
export function signedArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    s += p[0] * q[1] - q[0] * p[1];
  }
  return s / 2;
}

export function polygonBounds(poly) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of poly) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

export function unionBounds(list) {
  const out = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const b of list) {
    if (!b) continue;
    out.minX = Math.min(out.minX, b.minX);
    out.minY = Math.min(out.minY, b.minY);
    out.maxX = Math.max(out.maxX, b.maxX);
    out.maxY = Math.max(out.maxY, b.maxY);
  }
  if (out.minX === Infinity) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return out;
}

export function distToSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

export function distToBoundary(p, poly) {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    d = Math.min(d, distToSegment(p, poly[i], poly[(i + 1) % poly.length]));
  }
  return d;
}

function rayInside(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) &&
        p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Inside or on the boundary (within eps). */
export function pointInPolygon(p, poly, eps = EPS) {
  if (distToBoundary(p, poly) <= eps) return true;
  return rayInside(p, poly);
}

/** Inside and farther than eps from the boundary. */
export function strictlyInside(p, poly, eps = EPS) {
  if (distToBoundary(p, poly) <= eps) return false;
  return rayInside(p, poly);
}

export function areaCentroid(poly) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const f = p[0] * q[1] - q[0] * p[1];
    a += f;
    cx += (p[0] + q[0]) * f;
    cy += (p[1] + q[1]) * f;
  }
  if (Math.abs(a) < 1e-12) {
    const b = polygonBounds(poly);
    return [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

/** Pole of inaccessibility: the interior point farthest from the boundary (polylabel-style quadtree search). */
export function poleOfInaccessibility(poly, precision = 0.01) {
  const b = polygonBounds(poly);
  const w = b.maxX - b.minX, h = b.maxY - b.minY;
  const size = Math.min(w, h);
  if (!(size > 0)) return [b.minX, b.minY];
  const cell = (x, y, half) => {
    const d = (rayInside([x, y], poly) ? 1 : -1) * distToBoundary([x, y], poly);
    return { x, y, half, d, max: d + half * Math.SQRT2 };
  };
  let half = size / 2;
  const cells = [];
  for (let x = b.minX; x < b.maxX; x += size) {
    for (let y = b.minY; y < b.maxY; y += size) cells.push(cell(x + half, y + half, half));
  }
  const c = areaCentroid(poly);
  let best = cell(c[0], c[1], 0);
  const mid = cell(b.minX + w / 2, b.minY + h / 2, 0);
  if (mid.d > best.d) best = mid;
  let guard = 0;
  while (cells.length && guard++ < 20000) {
    let bi = 0;
    for (let i = 1; i < cells.length; i++) if (cells[i].max > cells[bi].max) bi = i;
    const cur = cells.splice(bi, 1)[0];
    if (cur.d > best.d) best = cur;
    if (cur.max - best.d <= precision) continue;
    half = cur.half / 2;
    cells.push(cell(cur.x - half, cur.y - half, half), cell(cur.x + half, cur.y - half, half),
               cell(cur.x - half, cur.y + half, half), cell(cur.x + half, cur.y + half, half));
  }
  return [best.x, best.y];
}

/**
 * A label point guaranteed inside the polygon: the area centroid when that is comfortably inside
 * (true for every convex room), otherwise the pole of inaccessibility (L- and U-shaped rooms).
 */
export function labelPoint(poly) {
  const c = areaCentroid(poly);
  if (strictlyInside(c, poly, 0.05)) return [round6(c[0]), round6(c[1])];
  const p = poleOfInaccessibility(poly);
  return [round6(p[0]), round6(p[1])];
}

function orient(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/** True when the open segments a-b and c-d cross at a single interior point. */
export function segmentsCross(a, b, c, d, eps = 1e-9) {
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  return ((o1 > eps && o2 < -eps) || (o1 < -eps && o2 > eps)) &&
         ((o3 > eps && o4 < -eps) || (o3 < -eps && o4 > eps));
}

export function selfIntersects(poly) {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (segmentsCross(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return true;
    }
  }
  return false;
}

/**
 * Do the interiors of two simple polygons intersect? Touching along an edge or at a corner is not overlap.
 * (Rooms that overlap only through exactly collinear edges are caught separately by the wall derivation.)
 */
export function polygonsOverlap(A, B) {
  const ba = polygonBounds(A), bb = polygonBounds(B);
  if (ba.maxX <= bb.minX + EPS || bb.maxX <= ba.minX + EPS || ba.maxY <= bb.minY + EPS || bb.maxY <= ba.minY + EPS) return false;
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < B.length; j++) {
      if (segmentsCross(A[i], A[(i + 1) % A.length], B[j], B[(j + 1) % B.length])) return true;
    }
  }
  const probes = (P) => {
    const pts = [labelPoint(P)];
    for (let i = 0; i < P.length; i++) {
      const p = P[i], q = P[(i + 1) % P.length];
      pts.push(p, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]);
    }
    return pts;
  };
  for (const p of probes(A)) if (strictlyInside(p, B, 1e-5)) return true;
  for (const p of probes(B)) if (strictlyInside(p, A, 1e-5)) return true;
  return false;
}

/** Corners of a rectangle centred at `at`, size [w, d], rotated by r: local x = [cos r, sin r], local y = [-sin r, cos r]. */
export function rectCorners(at, size, rotation = 0) {
  const c = Math.cos(rotation), s = Math.sin(rotation);
  const hw = size[0] / 2, hd = size[1] / 2;
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([lx, ly]) => [
    at[0] + lx * c - ly * s,
    at[1] + lx * s + ly * c,
  ]);
}
