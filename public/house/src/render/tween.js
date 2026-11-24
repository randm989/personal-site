// Tiny tween engine: scalar values that can be retargeted mid-flight from wherever they are (brief §6).

/** CSS cubic-bezier(x1, y1, x2, y2) as a function of t in 0..1. */
export function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t;
  const sy = (t) => ((ay * t + by) * t + cy) * t;
  const dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i++) {
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= (sx(t) - x) / d;
    }
    t = Math.max(0, Math.min(1, t));
    return sy(t);
  };
}

export const EASE = {
  linear: (t) => t,
  out: bezier(0.16, 1, 0.3, 1),
  in: bezier(0.4, 0, 1, 1),
  travel: bezier(0.65, 0, 0.35, 1),
  hinge: bezier(0.32, 0.72, 0, 1),
  fade: bezier(0.25, 0.1, 0.25, 1),
};

/** One animated number. */
export class Anim {
  constructor(v = 0) { this.v = v; this.target = v; this._from = v; this._t = 1; this._ms = 0; this._ease = EASE.linear; this._delay = 0; }
}

export class Tweens {
  constructor() { this.active = new Set(); }

  /** Move `a` to `target` over `ms` (0 snaps). Retargets from the current value. */
  to(a, target, ms = 0, ease = EASE.fade, delay = 0) {
    if (a.target === target && (this.active.has(a) || a.v === target)) return;
    a.target = target;
    if (!(ms > 0)) { a.v = target; a._t = 1; this.active.delete(a); a.changed = true; return; }
    a._from = a.v; a._t = 0; a._ms = ms; a._ease = ease; a._delay = delay;
    this.active.add(a);
  }

  snap(a, target) { this.to(a, target, 0); }

  /** Advance by dt milliseconds. Returns true while anything is still moving. */
  step(dt) {
    for (const a of this.active) {
      let d = dt;
      if (a._delay > 0) { a._delay -= dt; if (a._delay > 0) continue; d = -a._delay; a._delay = 0; }
      a._t = Math.min(1, a._t + d / a._ms);
      a.v = a._from + (a.target - a._from) * a._ease(a._t);
      if (a._t >= 1) { a.v = a.target; this.active.delete(a); }
    }
    return this.active.size > 0;
  }

  get busy() { return this.active.size > 0; }
}
