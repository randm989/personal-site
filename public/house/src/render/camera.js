// Camera rig: a long-lens three-quarter view fitted to the house inside the "model box" (the canvas minus
// the UI insets), OrbitControls for the user, and tweened moves for focus / overview / storey changes.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Anim, EASE } from './tween.js';

const FOV = 22;

/**
 * The untouched overview angles for a plot, in a landscape and in a portrait box. The long side of the plot
 * is laid along the long side of the box: a deep plot (street front to back yard longer than it is wide) is
 * turned side-on in landscape and seen from the front in portrait; a wide plot the other way round. Always
 * from the front-right, so the front door faces the viewer.
 */
export function defaultViews(bounds) {
  const deep = (bounds.maxY - bounds.minY) > (bounds.maxX - bounds.minX) * 1.15;
  return {
    landscape: { az: deep ? 1.08 : 0.5, pol: 0.87 },
    portrait: { az: deep ? 0.42 : 1.12, pol: 0.62 },
  };
}

export function createRig(canvas, plan, tweens, { onChange, onUserStart, reduceMotion, groundPoints }) {
  const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 400);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.rotateSpeed = 0.55;
  controls.zoomSpeed = 0.7;
  controls.screenSpacePanning = false;
  controls.minPolarAngle = 0.12;
  controls.maxPolarAngle = 1.18;          // never level with the cut walls, never below the ground
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

  const B = plan.bounds;
  const boxMin = new THREE.Vector3(B.minX, 0, B.minY), boxMax = new THREE.Vector3(B.maxX, 1.2, B.maxY);
  const footprint = [];
  for (const r of plan.rooms || []) for (const [x, z] of r.polygon || []) footprint.push([x, z, !!r.outdoor]);
  if (!footprint.length) for (const x of [B.minX, B.maxX]) for (const z of [B.minY, B.maxY]) footprint.push([x, z, false]);
  // other things drawn flat on the ground beyond the rooms (camera view wedges) are framed too
  for (const p of groundPoints || []) footprint.push([p[0], p[1], true]);
  const a = { az: new Anim(0.5), pol: new Anim(0.85), dist: new Anim(60), tx: new Anim(0), ty: new Anim(0), tz: new Anim(0) };
  const all = Object.values(a);
  let W = 1, H = 1;
  let insets = { top: 0, right: 0, bottom: 0, left: 0 };
  let overview = { az: 0.5, pol: 0.85, dist: 60, target: new THREE.Vector3() };
  let zoom = 1;                 // the user's zoom relative to the fitted distance
  let topY = 1.2;
  let driving = false;          // true while a tween (not the user) owns the camera
  let focused = false, focusPoint = null;
  let ambient = { on: false, t0: 0 };

  controls.addEventListener('start', () => {
    // the user takes over: drop any camera tween where it is
    for (const x of all) tweens.active.delete(x);
    driving = false;
    userMoved = true;
    onUserStart && onUserStart();
  });
  controls.addEventListener('change', () => {
    const b = 0.5;
    controls.target.x = Math.max(B.minX - b, Math.min(B.maxX + b, controls.target.x));
    controls.target.z = Math.max(B.minY - b, Math.min(B.maxY + b, controls.target.z));
    controls.target.y = Math.max(-3, Math.min(topY + 1, controls.target.y));
    onChange();
  });
  controls.addEventListener('end', () => { syncFromCamera(); });
  let inited = false, userMoved = false;
  const current = () => { if (inited && !driving) syncFromCamera(); };

  function syncFromCamera() {
    const off = camera.position.clone().sub(controls.target);
    const s = new THREE.Spherical().setFromVector3(off);
    a.az.v = a.az.target = s.theta; a.pol.v = a.pol.target = s.phi; a.dist.v = a.dist.target = s.radius;
    a.tx.v = a.tx.target = controls.target.x; a.ty.v = a.ty.target = controls.target.y; a.tz.v = a.tz.target = controls.target.z;
    zoom = s.radius / overview.dist;
  }

  function write() {
    const sp = Math.sin(a.pol.v);
    camera.position.set(
      a.tx.v + a.dist.v * sp * Math.sin(a.az.v),
      a.ty.v + a.dist.v * Math.cos(a.pol.v),
      a.tz.v + a.dist.v * sp * Math.cos(a.az.v));
    controls.target.set(a.tx.v, a.ty.v, a.tz.v);
    camera.lookAt(controls.target);
  }

  /** Default angles: three-quarter from the front; steeper in portrait where height is plentiful. */
  function defaultAngles() {
    const bw = Math.max(1, W - insets.left - insets.right), bh = Math.max(1, H - insets.top - insets.bottom);
    const portrait = bh > bw * 1.15;
    const views = defaultViews(B);
    return portrait ? views.portrait : views.landscape;
  }

  /**
   * Keep a camera pose honest: every projected corner of the house stays inside the inset box with at
   * least `pad` pixels to spare. Backs the camera off first if the house is too big, then slides the target.
   */
  function clampPose(pose, pad = 16) {
    const bw = Math.max(40, W - insets.left - insets.right), bh = Math.max(40, H - insets.top - insets.bottom);
    const tanV = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    const tanH = tanV * (W / H);
    const limX = tanH * Math.max(8, bw - 2 * pad) / W, limY = tanV * Math.max(8, bh - 2 * pad) / H;
    const sp = Math.sin(pose.pol);
    const back = new THREE.Vector3(sp * Math.sin(pose.az), Math.cos(pose.pol), sp * Math.cos(pose.az));
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), back).normalize();
    const up = new THREE.Vector3().crossVectors(back, right);
    const target = pose.target.clone();
    let dist = pose.dist;
    const p = new THREE.Vector3();
    for (let iter = 0; iter < 8; iter++) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const [x, z, outdoor] of footprint) for (const y of outdoor ? [0] : [0, topY]) {
        p.set(x, y, z).sub(target);
        const d = Math.max(0.1, dist - p.dot(back));
        const tx = p.dot(right) / d, ty = p.dot(up) / d;
        minX = Math.min(minX, tx); maxX = Math.max(maxX, tx);
        minY = Math.min(minY, ty); maxY = Math.max(maxY, ty);
      }
      const grow = Math.max((maxX - minX) / (2 * limX), (maxY - minY) / (2 * limY));
      if (grow > 1.0005) { dist *= grow * 1.002; continue; }
      let moved = false;
      if (maxX > limX) { target.addScaledVector(right, (maxX - limX) * dist); moved = true; }
      else if (minX < -limX) { target.addScaledVector(right, (minX + limX) * dist); moved = true; }
      if (maxY > limY) { target.addScaledVector(up, (maxY - limY) * dist); moved = true; }
      else if (minY < -limY) { target.addScaledVector(up, (minY + limY) * dist); moved = true; }
      if (!moved) break;
    }
    return { az: pose.az, pol: pose.pol, dist, target };
  }

  /** Distance and view offset that frame the house box in the model box for the given angles. */
  function fit(az, pol) {
    const bw = Math.max(40, W - insets.left - insets.right), bh = Math.max(40, H - insets.top - insets.bottom);
    const margin = Math.min(bw < 520 ? 0.92 : 0.84, 1 - 40 / Math.min(bw, bh));
    const tanV = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    const tanH = tanV * (W / H);
    const fx = (bw / W) * margin, fy = (bh / H) * margin;
    const target = new THREE.Vector3((boxMin.x + boxMax.x) / 2, topY * 0.35, (boxMin.z + boxMax.z) / 2);
    // camera basis
    const sp = Math.sin(pol);
    const back = new THREE.Vector3(sp * Math.sin(az), Math.cos(pol), sp * Math.cos(az));   // target -> camera
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), back).normalize();
    const up = new THREE.Vector3().crossVectors(back, right);
    // the real outline of the house (room corners at the floor and at the top), not its bounding box
    const pts = [];
    const tmp = new THREE.Vector3();
    for (const [x, z, outdoor] of footprint) for (const y of outdoor ? [0] : [0, topY]) {
      const p = tmp.set(x, y, z).sub(target);
      pts.push([p.dot(right), p.dot(up), p.dot(back)]);
    }
    let dist = 10, cx = 0, cy = 0;
    for (let iter = 0; iter < 6; iter++) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const [x, y, z] of pts) {
        const d = dist - z;
        minX = Math.min(minX, x / d); maxX = Math.max(maxX, x / d);
        minY = Math.min(minY, y / d); maxY = Math.max(maxY, y / d);
      }
      cx = (minX + maxX) / 2; cy = (minY + maxY) / 2;
      const scale = Math.max((maxX - minX) / 2 / (tanH * fx), (maxY - minY) / 2 / (tanV * fy));
      dist *= scale;
    }
    // shift the target so the projected box is centred (cx, cy are tangents at the final distance)
    target.addScaledVector(right, cx * dist).addScaledVector(up, cy * dist);
    return { dist, target };
  }

  function applyViewOffset() {
    const sx = (insets.left - insets.right) / 2, sy = (insets.top - insets.bottom) / 2;
    if (Math.abs(sx) < 0.5 && Math.abs(sy) < 0.5) camera.clearViewOffset();
    else camera.setViewOffset(W, H, -sx, -sy, W, H);
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
  }

  function computeOverview() {
    const ang = defaultAngles();
    const f = fit(ang.az, ang.pol);
    overview = clampPose({ az: ang.az, pol: ang.pol, dist: f.dist, target: f.target });

    controls.minDistance = f.dist * 0.3;
    controls.maxDistance = f.dist * 1.7;
  }

  function moveTo(pose, ms, ease = EASE.travel) {
    if (reduceMotion()) ms = 0;
    // take the short way round in azimuth
    let az = pose.az;
    while (az - a.az.v > Math.PI) az -= Math.PI * 2;
    while (az - a.az.v < -Math.PI) az += Math.PI * 2;
    tweens.to(a.az, az, ms, ease); tweens.to(a.pol, pose.pol, ms, ease); tweens.to(a.dist, pose.dist, ms, ease);
    tweens.to(a.tx, pose.target.x, ms, ease); tweens.to(a.ty, pose.target.y, ms, ease); tweens.to(a.tz, pose.target.z, ms, ease);
    driving = true;
    inited = true;
    if (!(ms > 0)) { write(); controls.update(); driving = false; }
    onChange();
  }

  const rig = {
    camera, controls,
    get overview() { return overview; },
    resize(w, h) {
      W = Math.max(1, w); H = Math.max(1, h);
      applyViewOffset();
      rig.refit(0);
    },
    setInsets(i, ms = 0) {
      insets = { top: +i.top || 0, right: +i.right || 0, bottom: +i.bottom || 0, left: +i.left || 0 };
      applyViewOffset();
      rig.refit(ms);
    },
    setTop(y, ms) { topY = y; boxMax.y = y; rig.refit(ms); },
    /** Recompute the fit; keep the user's angles and zoom unless we are on the untouched overview. */
    refit(ms) {
      current();
      const hadDefault = !userMoved;
      const prev = overview;
      computeOverview();
      if (focused) { if (focusPoint) rig.focusOn(focusPoint, ms); return; }
      if (hadDefault) moveTo(overview, ms);
      else {
        const f = fit(a.az.target, a.pol.target);
        const shift = new THREE.Vector3(a.tx.target, a.ty.target, a.tz.target).sub(prev.target);
        moveTo({ az: a.az.target, pol: a.pol.target, dist: f.dist * zoom, target: f.target.add(shift) }, ms);
      }
    },
    goOverview(ms) { current(); focused = false; userMoved = false; zoom = 1; moveTo(overview, ms); },
    /** Move at most ~35% of the way toward a point. */
    focusOn(point, ms) {
      current();
      focused = true;
      focusPoint = point.clone();
      const t = overview.target.clone().lerp(point, 0.35);
      t.y = overview.target.y + (point.y - overview.target.y) * 0.2;
      // never so close or so far over that part of the house leaves the box
      moveTo(clampPose({ az: overview.az, pol: overview.pol, dist: overview.dist * 0.8, target: t }), ms);
    },
    /** Called every frame. Returns true while the camera is still moving. */
    update(dtSeconds) {
      if (driving) {
        write();
        controls.update(dtSeconds);
        if (!all.some((x) => tweens.active.has(x))) { driving = false; zoom = a.dist.v / overview.dist; }
        return true;
      }
      const moved = controls.update(dtSeconds);
      return moved;
    },
    setAmbient(on) { ambient = { on, t0: performance.now(), az0: a.az.target }; if (!on) return; },
    /** Slow azimuth sway for always-on screens: called about once a second. */
    drift(amplitude) {
      if (!ambient.on || driving || focused) return false;
      const t = (performance.now() - ambient.t0) / 600000;   // one cycle per 10 minutes
      const az = overview.az + amplitude * Math.sin(t * Math.PI * 2);
      a.az.v = a.az.target = az;
      a.pol.v = a.pol.target = overview.pol; a.dist.v = a.dist.target = overview.dist * zoom;
      write();
      controls.update();
      return true;
    },
    dispose() { controls.dispose(); },
  };
  return rig;
}
