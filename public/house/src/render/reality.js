// Reality view (CONTRACTS, "Round 3"). Every camera that has a live picture lays that picture onto the
// surfaces of the model it can see; everything else stays the maquette.
//
// How it is drawn. The clay shader itself does the projecting (materials.js, FRAG_PROJ), so the picture
// lands on exactly the pixels the model already draws: no second pass, no extra draw calls, nothing to
// z-fight. This module owns what that shader reads:
//   * the projectors: up to PROJECTORS lens poses (matrix, position, reach, strength);
//   * the depth atlas: what each lens sees first, drawn from a twin of the house whose walls stand at their
//     real height (the model is cut at 1.2 m; a real wall is not, and a camera cannot see over it);
//   * the feed atlas: each camera's latest frame, one tile per projector, display-ready.
// Frames come from two kinds of source: a simulated feed (the twin drawn from the lens with the photographed
// look of photo.js, a few times a second) or a real still polled about once a second.
//
// Honesty (rule 13): a slot projects only while its camera has a feed claim and a frame has arrived; a real
// picture that stops arriving is dropped after 10 s.

import * as THREE from 'three';
import { wallPieces } from '../plan/index.js';
import { MassBuilder, MAT } from './builder.js';
import { castRay } from './scene.js';
import { PROJECTORS, PROJ_COLS, PROJ_ROWS } from './materials.js';
import { Anim, EASE } from './tween.js';
import {
  PHOTO, MAX_SIM_PEOPLE, floorKind, createPhotoShared, createPhotoMaterial, createSensorMaterial, createCopyMaterial,
  buildPersonGeometry,
} from './photo.js';

const NEAR = 0.1, FAR = 40;
const FEED = { high: [480, 270, 4, 4], medium: [480, 270, 3, 2], low: [320, 180, 2, 0] };      // w, h, frames per second, MSAA
const DEPTH = { high: [512, 288], medium: [512, 288], low: [256, 144] };
const CARD_W = 320;                 // feedCanvas width, CSS px
const CARD_MS = 480;                // the card canvas refreshes at most this often
const ASKED_MS = 5000;              // a card that stopped asking stops costing anything after this long
const IMAGE_POLL_MS = 1000;
const IMAGE_STALE_MS = 10000;
const SHIRTS = [[0.62, 0.12, 0.1], [0.12, 0.3, 0.55], [0.8, 0.78, 0.72], [0.16, 0.38, 0.22], [0.75, 0.52, 0.12], [0.3, 0.3, 0.33], [0.5, 0.2, 0.42], [0.1, 0.12, 0.16]];
const TROUSERS = [[0.13, 0.16, 0.25], [0.2, 0.2, 0.21], [0.38, 0.33, 0.25], [0.1, 0.1, 0.11]];
const PAINTS = [[0.03, 0.09, 0.22], [0.78, 0.78, 0.77], [0.35, 0.04, 0.04], [0.1, 0.1, 0.11]];

/**
 * @param o { gl, plan, house, G, tier, cut, tweens, dur(ms, kind), sunDir, themeMix:Anim, levelShown(L), listPeople(), onDirty() }
 */
export function createReality(o) {
  const { gl, plan, house, G, tweens, cut } = o;
  const tier = FEED[o.tier] ? o.tier : 'high';
  const [FW, FH, FPS, MSAA] = FEED[tier];
  const [DW, DH] = DEPTH[tier];
  const levels = house.levels;
  const disposables = [];
  const track = (x) => { disposables.push(x); return x; };
  let disposed = false;
  let view = 'model';
  let offline = false;

  // ---- render targets -------------------------------------------------------------------------------
  const feedRT = track(new THREE.WebGLRenderTarget(FW * PROJ_COLS, FH * PROJ_ROWS, {
    depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
  }));
  feedRT.texture.colorSpace = THREE.NoColorSpace;          // already display-ready; the clay shader pastes it as is
  const depthTex = new THREE.DepthTexture(DW * PROJ_COLS, DH * PROJ_ROWS, THREE.UnsignedIntType);
  depthTex.minFilter = depthTex.magFilter = THREE.NearestFilter;
  const depthRT = track(new THREE.WebGLRenderTarget(DW * PROJ_COLS, DH * PROJ_ROWS, {
    depthBuffer: true, depthTexture: depthTex, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
  }));
  const sceneRT = track(new THREE.WebGLRenderTarget(FW, FH, {
    depthBuffer: true, samples: MSAA, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
  }));
  sceneRT.texture.colorSpace = THREE.NoColorSpace;
  G.uFeedTex.value = feedRT.texture;
  G.uFeedDepth.value = depthTex;
  G.uProjZ.value.set(NEAR, FAR, 1 / (DW * PROJ_COLS), 1 / (DH * PROJ_ROWS));

  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadGeo = track(new THREE.PlaneGeometry(2, 2));
  const sensorMat = track(createSensorMaterial());
  sensorMat.uniforms.uTexel.value.set(1 / FW, 1 / FH);
  const copyMat = track(createCopyMaterial());
  const quad = new THREE.Mesh(quadGeo, sensorMat);
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene();
  quadScene.add(quad);

  /** Run fn with the renderer pointed somewhere else, and put everything back. */
  const tmpColor = new THREE.Color();
  function offscreen(fn) {
    const target = gl.getRenderTarget();
    const autoClear = gl.autoClear;
    gl.getClearColor(tmpColor);
    const alpha = gl.getClearAlpha();
    gl.autoClear = true;
    try { fn(); } finally {
      gl.setRenderTarget(target);
      gl.autoClear = autoClear;
      gl.setClearColor(tmpColor, alpha);
    }
  }
  function tileRect(rt, i, w, h) {
    const x = (i % PROJ_COLS) * w, y = Math.floor(i / PROJ_COLS) * h;
    rt.viewport.set(x, y, w, h);
    rt.scissor.set(x, y, w, h);
    rt.scissorTest = true;
    return [x, y];
  }
  offscreen(() => {
    for (const rt of [feedRT, depthRT]) {
      rt.scissorTest = false;
      rt.viewport.set(0, 0, rt.width, rt.height);
      gl.setRenderTarget(rt);
      gl.setClearColor(0x000000, 1);
      gl.clear(true, true, false);
    }
  });

  // ---- the twin: the same house as a camera would see it ---------------------------------------------
  const shared = createPhotoShared(o.sunDir);
  const twin = new THREE.Scene();
  const depthMat = track(new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide }));
  const topMost = levels[levels.length - 1].elev + levels[levels.length - 1].height;
  const twins = [];                   // per storey: { L, group, doors: [], cars: [], screens }
  const B = plan.bounds;

  for (const L of levels) {
    const lv = plan.levels[L.index];
    L.photoKinds = { value: L.rooms.length ? L.rooms.map((r) => floorKind(r.type)) : [0] };
    L.photoTop = { value: Math.min(topMost, L.elev + L.height * (L.index < levels.length - 1 ? 1.75 : 1)) };
    const group = new THREE.Group();
    group.position.y = L.elev;
    twin.add(group);
    const mat = track(createPhotoMaterial(L, shared));
    group.add(new THREE.Mesh(L.staticMesh.geometry, mat));

    // the part of every wall the model cuts away, and the ceilings
    const ub = new MassBuilder();
    ub.baseAO = 1;
    for (const wall of plan.walls) {
      if (wall.level !== L.id) continue;
      const ht = wall.thickness / 2;
      ub.setFrame(wall.a[0], wall.a[1], 0, Math.atan2(wall.dir[1], wall.dir[0]));
      for (const piece of wallPieces(wall, Infinity)) {
        const lo = Math.max(piece.bottom, cut);
        const hi = Math.min(piece.top, wall.height);
        if (hi <= lo + 1e-6) continue;
        ub.box(piece.from, piece.to, -ht, ht, lo, hi, { mat: MAT.wall, bottom: lo > cut });
      }
    }
    ub.setFrame(0, 0, 0, 0);
    for (const post of plan.posts) {
      if (post.level !== L.id) continue;
      const h = post.size / 2;
      ub.box(post.at[0] - h, post.at[0] + h, post.at[1] - h, post.at[1] + h, cut, lv.height, { mat: MAT.wall });
    }
    for (const room of L.rooms) {
      if (room.outdoor) continue;
      const contour = room.polygon.map(([x, y]) => new THREE.Vector2(x, y));
      for (const t of THREE.ShapeUtils.triangulateShape(contour, [])) {
        ub.poly(t.map((i) => [room.polygon[i][0], room.polygon[i][1], lv.height - 0.002]), [0, 0, -1], { mat: MAT.edge, room: L.roomIndex.get(room.id) });
      }
    }
    if (ub.has('body')) group.add(new THREE.Mesh(track(ub.toGeometry('body')), mat));

    const T = { L, group, doors: [], cars: [], screens: null };
    for (const d of L.doors) {
      if (!d.mesh) continue;                                   // sliding doors are glass: a camera sees through them
      const garage = d.style === 'garage';
      const m = new THREE.Mesh(d.mesh.geometry, track(createPhotoMaterial(L, shared, { kind: garage ? 2 : 1 })));
      group.add(m);
      T.doors.push({ d, m, garage, top: Math.min(d.opening.head, lv.height) });
    }
    L.cars.forEach((c, i) => {
      const m = new THREE.Mesh(c.body.geometry, track(createPhotoMaterial(L, shared, { kind: 3, paint: PAINTS[i % PAINTS.length] })));
      m.position.copy(c.group.position);
      m.rotation.copy(c.group.rotation);
      group.add(m);
      T.cars.push({ c, m });
    });
    // screens and indicator lights: the parts of appliances that glow when they run
    const glowing = L.appliances.filter((a) => a.hasGlow && L.emissive && L.emissive.raws.get(a.id));
    if (glowing.length) {
      const pos = [], idx = [], info = [];
      const ranges = [];
      for (const a of glowing) {
        const raw = L.emissive.raws.get(a.id);
        const base = pos.length / 3;
        for (const v of raw.pos) pos.push(v);
        for (const i of raw.idx) idx.push(base + i);
        for (let k = 0; k < raw.pos.length / 3; k++) info.push(PHOTO.screen, a.type === 'tv' ? 0 : 1, 1, 0);
        ranges.push({ a, from: base, to: pos.length / 3, on: -1 });
      }
      const g = track(new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('aInfo', new THREE.Float32BufferAttribute(info, 4));
      g.setIndex(idx);
      g.computeVertexNormals();
      group.add(new THREE.Mesh(g, track(createPhotoMaterial(L, shared, { side: THREE.DoubleSide }))));
      T.screens = { g, ranges };
    }
    twins.push(T);
  }

  // outside: lawn to a boundary fence, under a sky
  const L0 = levels[0];
  const backdropMat = track(createPhotoMaterial(L0, shared, { kind: 5, side: THREE.DoubleSide }));
  const lawn = new THREE.Mesh(house.ground.geometry, track(createPhotoMaterial(L0, shared)));
  lawn.position.copy(house.ground.position);
  twin.add(lawn);
  const backdrop = new THREE.Group();
  {
    const fb = new MassBuilder();
    fb.baseAO = 1;
    const cx = (B.minX + B.maxX) / 2, cy = (B.minY + B.maxY) / 2;
    const pad = Math.max(3.5, house.reach * 0.3);
    const ax = (B.maxX - B.minX) / 2 + pad * 1.25, ay = (B.maxY - B.minY) / 2 + pad * 1.25;
    const N = 64;
    for (let i = 0; i < N; i++) {
      const a0 = (i / N) * Math.PI * 2, a1 = ((i + 1) / N) * Math.PI * 2;
      const p = [cx + Math.cos(a0) * ax, cy + Math.sin(a0) * ay], q = [cx + Math.cos(a1) * ax, cy + Math.sin(a1) * ay];
      fb.poly([[p[0], p[1], -0.1], [q[0], q[1], -0.1], [q[0], q[1], 1.85], [p[0], p[1], 1.85]], [cx - p[0], cy - p[1], 0], { mat: PHOTO.fence });
    }
    const fence = new THREE.Mesh(track(fb.toGeometry('body')), backdropMat);
    fence.position.y = L0.elev;
    const skyGeo = track(new THREE.SphereGeometry(FAR * 0.9, 24, 12));
    skyGeo.setAttribute('aInfo', new THREE.Float32BufferAttribute(new Float32Array(skyGeo.attributes.position.count * 4).map((_, i) => (i % 4 === 0 ? PHOTO.sky : 1)), 4));
    const sky = new THREE.Mesh(skyGeo, backdropMat);
    sky.position.set(cx, L0.elev, cy);
    sky.frustumCulled = false;
    backdrop.add(fence, sky);
    backdrop.userData.sky = sky;
  }
  twin.add(backdrop);

  // simulated people
  const personGeo = track(buildPersonGeometry());
  const peopleGroup = new THREE.Group();
  twin.add(peopleGroup);
  const personPool = [];              // { mesh, mats: Map(levelId -> material) }
  function personMesh(i, L, look) {
    let p = personPool[i];
    if (!p) {
      p = { mesh: new THREE.Mesh(personGeo, null), mats: new Map() };
      p.mesh.frustumCulled = false;
      peopleGroup.add(p.mesh);
      personPool[i] = p;
    }
    const key = L.id + '/' + look;
    let m = p.mats.get(key);
    if (!m) {
      m = track(createPhotoMaterial(L, shared, { kind: 4, person: true, paint: SHIRTS[look % SHIRTS.length], paint2: TROUSERS[look % TROUSERS.length] }));
      p.mats.set(key, m);
    }
    p.mesh.material = m;
    return p.mesh;
  }
  // In the depth maps a standing figure is a column drawn inside-out: the model's peg (inside it) still takes the
  // picture, and whatever is behind the person does not get their picture smeared across it.
  const columnGeo = track(new THREE.CylinderGeometry(0.3, 0.3, 1.85, 12, 1, false));
  columnGeo.translate(0, 0.925, 0);
  const columnMat = track(new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.BackSide }));
  const columns = new THREE.Group();
  columns.visible = false;
  twin.add(columns);
  const hashId =(s) => { let h = 7; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };

  // ---- cameras ----------------------------------------------------------------------------------------
  const cams = new Map();             // camera id -> { h, L, cam, feed, person, slot, asked, canvas, ... }
  for (const L of levels) {
    for (const h of L.cameras) {
      const f = h.fixture;
      const aspect = f.aspect > 0 ? f.aspect : 16 / 9;
      const hfov = THREE.MathUtils.degToRad(Math.max(20, Math.min(150, Number.isFinite(f.fov) ? f.fov : 90)));
      const vfov = 2 * Math.atan(Math.tan(hfov / 2) / aspect);
      const pitch = THREE.MathUtils.degToRad(Math.max(0, Math.min(88, Number.isFinite(f.pitch) ? f.pitch : 30)));
      const range = f.range > 0 ? f.range : 6;
      const cam = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(vfov), aspect, NEAR, FAR);
      const z = Number.isFinite(f.z) ? f.z : (Number.isFinite(f.height) ? f.height : 2.2);
      cam.position.set(h.eye[0], L.elev + Math.min(z, L.height - 0.04), h.eye[1]);
      cam.lookAt(cam.position.x + h.look[0] * Math.cos(pitch), cam.position.y - Math.sin(pitch), cam.position.z + h.look[1] * Math.cos(pitch));
      cam.updateMatrixWorld(true);
      cam.updateProjectionMatrix();
      cams.set(h.id, {
        id: h.id, h, L, cam, range, aspect,
        // depth changes by about this much across one depth texel, per metre of distance (before the slope)
        bias: 1.6 * (2 * Math.tan(hfov / 2)) / DW,
        matrix: new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse),
        feed: null, person: false, slot: -1, alpha: new Anim(0),
        kind: null, url: null, ready: false, lastRender: -1e9, lastOk: 0, lastPoll: -1e9, loading: false, img: null, tex: null, still: false,
        asked: -1e9, canvas: null, canvasAt: -1e9, walkSeed: (hashId(h.id) % 1000) / 1000,
      });
    }
  }
  const slots = new Array(PROJECTORS).fill(null);
  let warnedFull = false;
  let depthKey = '';
  let timer = 0;

  function writeSlot(i) {
    const c = slots[i];
    if (!c) { G.uProjR.value[i].set(0, 0, 0, 0); return; }
    G.uProjM.value[i].copy(c.matrix);
    G.uProjP.value[i].set(c.cam.position.x, c.cam.position.y, c.cam.position.z, c.L.elev);
    G.uProjR.value[i].set(c.range, c.range * 1.5, c.alpha.v, c.bias);
  }

  // ---- drawing the twin -----------------------------------------------------------------------------
  /** Bring the twin up to date with the model: doors, cars, screens, people. */
  function syncTwin(now) {
    shared.uDay.value = o.themeMix.v;
    shared.uTime.value = (now / 1000) % 3600;
    for (const T of twins) {
      for (const t of T.doors) {
        const src = t.d.mesh, pos = Math.min(1, Math.max(0, t.d.pos.v));
        t.m.position.copy(src.position);
        t.m.rotation.copy(src.rotation);
        if (t.garage) {
          const bottom = pos * t.top, hgt = t.top - bottom;
          t.m.visible = hgt > 0.012;
          t.m.scale.y = Math.max(hgt, 0.001);
          t.m.position.y = bottom;
        } else {
          t.m.scale.y = t.top / cut;
        }
      }
      for (const t of T.cars) t.m.visible = t.c.show.target > 0.5;
      if (T.screens) {
        const info = T.screens.g.attributes.aInfo;
        for (const r of T.screens.ranges) {
          const on = Math.round(Math.min(1, Math.max(0, r.a.run.v)) * 20) / 20;
          if (on === r.on) continue;
          r.on = on;
          for (let k = r.from; k < r.to; k++) info.setW(k, on);
          info.needsUpdate = true;
        }
      }
    }
    // people: where the model's figures stand, plus someone walking wherever a camera reports a person
    let n = 0;
    const standing = o.listPeople();
    const occupied = new Set();
    while (columns.children.length < Math.min(standing.length, MAX_SIM_PEOPLE)) columns.add(new THREE.Mesh(columnGeo, columnMat));
    columns.children.forEach((m, i) => {
      const p = standing[i];
      m.visible = !!p;
      if (p) { m.position.set(p.x, p.level.elev + p.y, p.z); m.userData.level = p.level; }
    });
    for (const p of standing) {
      if (n >= MAX_SIM_PEOPLE) break;
      const look = hashId(p.id);
      const m = personMesh(n, p.level, look % 8);
      m.position.set(p.x, p.level.elev + p.y, p.z);
      m.rotation.y = ((look >> 4) % 628) / 100;
      m.material.uniforms.uSwing.value = 0;
      m.visible = true;
      shared.uPeople.value[n].set(p.x, p.level.elev + p.y, p.z, 1);
      if (p.room) occupied.add(p.room);
      n++;
    }
    for (const c of cams.values()) {
      if (n >= MAX_SIM_PEOPLE) break;
      if (!c.person || !c.feed || occupied.has(c.h.fixture.room)) continue;
      // back and forth across the middle of the view, never through a wall
      const L = c.L, e = c.h.eye, lk = c.h.look;
      const ahead = castRay(e[0], e[1], lk[0], lk[1], L.sightSegs, c.range);
      const d = Math.max(0.9, Math.min(c.range * 0.55, ahead - 0.6));
      const cx = e[0] + lk[0] * d, cy = e[1] + lk[1] * d;
      const sx = -lk[1], sy = lk[0];
      const room = Math.min(castRay(cx, cy, sx, sy, L.sightSegs, 1.6), castRay(cx, cy, -sx, -sy, L.sightSegs, 1.6)) - 0.35;
      const span = Math.max(0, Math.min(1.1, room));
      const t = now / 1000 * 0.75 + c.walkSeed * 6.28;
      const along = Math.sin(t) * span, heading = Math.cos(t) >= 0 ? 1 : -1;
      const x = cx + sx * along, y = cy + sy * along;
      const outdoor = plan.rooms.find((r) => r.id === c.h.fixture.room)?.outdoor;
      const m = personMesh(n, L, 3 + (hashId(c.id) % 5));
      m.position.set(x, L.elev + (outdoor ? -0.03 : 0), y);
      m.rotation.y = Math.atan2(sx * heading, sy * heading);
      const moving = span > 0.2 ? Math.abs(Math.cos(t)) : 0;
      m.material.uniforms.uSwing.value = 0.42 * moving;
      m.material.uniforms.uWalk.value = t * 7.5;
      m.visible = true;
      shared.uPeople.value[n].set(x, m.position.y, y, 1);
      n++;
    }
    for (let i = n; i < MAX_SIM_PEOPLE; i++) {
      shared.uPeople.value[i].set(0, -999, 0, 0);
      if (personPool[i]) personPool[i].mesh.visible = false;
    }
  }
  function showLevel(L) { for (const T of twins) T.group.visible = T.L === L; }

  /** What this lens sees first, into its depth tile. People are left out: they move, the map does not. */
  function renderDepth(c) {
    showLevel(c.L);
    peopleGroup.visible = false; backdrop.visible = false;
    twin.overrideMaterial = depthMat;
    tileRect(depthRT, c.slot, DW, DH);
    gl.setRenderTarget(depthRT);
    gl.clear(true, true, false);
    gl.render(twin, c.cam);
    twin.overrideMaterial = null;
    // then the columns, far sides only, over the same tile
    const hidden = [];
    for (const ch of twin.children) if (ch !== columns && ch.visible) { ch.visible = false; hidden.push(ch); }
    const shown = columns.children.map((m) => m.visible);
    columns.children.forEach((m) => { m.visible = m.visible && m.userData.level === c.L; });
    columns.visible = true;
    gl.autoClear = false;
    gl.render(twin, c.cam);
    gl.autoClear = true;
    columns.visible = false;
    columns.children.forEach((m, i) => { m.visible = shown[i]; });
    for (const ch of hidden) ch.visible = true;
    peopleGroup.visible = true; backdrop.visible = true;
  }

  function refreshDepth(now, force) {
    let key = '';
    for (const T of twins) {
      for (const t of T.doors) key += t.d.pos.v.toFixed(2) + ',';
      for (const t of T.cars) key += t.c.show.target > 0.5 ? 'c' : '-';
    }
    for (const p of o.listPeople()) key += `p${p.level.id}:${p.x.toFixed(2)},${p.z.toFixed(2)}`;
    if (!force && key === depthKey) return;
    depthKey = key;
    if (!slots.some(Boolean)) return;
    syncTwin(now);
    offscreen(() => { for (const c of slots) if (c) renderDepth(c); });
  }

  /** One simulated frame: the twin from the lens, then through the sensor into the camera's tile. */
  function renderSim(c, now) {
    const day = o.themeMix.v;
    shared.uExpo.value = c.h.fixture.indoor ? 1 : 1.7 - 0.92 * day;      // outdoors: stopped down for the sun, gain up in the dark
    showLevel(c.L);
    backdrop.userData.sky.position.copy(c.cam.position);       // the sky is always the same distance away
    gl.setRenderTarget(sceneRT);
    gl.setClearColor(0x000000, 1);
    gl.clear(true, true, false);
    gl.render(twin, c.cam);
    quad.material = sensorMat;
    sensorMat.uniforms.tSrc.value = sceneRT.texture;
    sensorMat.uniforms.uSeed.value = (now % 9973) / 9973 + c.slot;
    sensorMat.uniforms.uNight.value = 1 - day;
    tileRect(feedRT, c.slot, FW, FH);
    gl.setRenderTarget(feedRT);
    gl.render(quadScene, quadCam);
    c.lastRender = now;
    c.ready = true;
  }

  function blitImage(c) {
    quad.material = copyMat;
    copyMat.uniforms.tSrc.value = c.tex;
    tileRect(feedRT, c.slot, FW, FH);
    offscreen(() => { gl.setRenderTarget(feedRT); gl.render(quadScene, quadCam); });
  }

  // ---- real pictures ----------------------------------------------------------------------------------
  function pollImage(c, now) {
    if (c.loading || (c.still && c.img)) return;
    c.loading = true;
    c.lastPoll = now;
    const url = c.url;
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.decoding = 'async';
    im.onload = () => {
      c.loading = false;
      if (disposed || c.url !== url || c.kind !== 'image' || c.slot < 0 || !im.naturalWidth) return;
      if (c.tex && (c.tex.image.naturalWidth !== im.naturalWidth || c.tex.image.naturalHeight !== im.naturalHeight)) { c.tex.dispose(); c.tex = null; }
      if (!c.tex) {
        c.tex = new THREE.Texture(im);
        c.tex.colorSpace = THREE.NoColorSpace;
        c.tex.minFilter = c.tex.magFilter = THREE.LinearFilter;
        c.tex.generateMipmaps = false;
      }
      c.tex.image = im;
      c.tex.needsUpdate = true;
      c.img = im;
      c.lastOk = performance.now();
      try { blitImage(c); c.ready = true; } catch (err) { console.warn(`House View: the picture from ${c.id} could not be used (${err && err.message ? err.message : err}).`); c.ready = false; }
      c.canvasAt = -1e9;
      reconcile();
      o.onDirty();
    };
    im.onerror = () => { c.loading = false; };
    im.src = url;
  }

  // ---- slots ------------------------------------------------------------------------------------------
  function release(c) {
    if (c.slot < 0) return;
    slots[c.slot] = null;
    writeSlot(c.slot);
    c.slot = -1; c.ready = false; c.kind = null; c.url = null; c.img = null; c.loading = false;
    if (c.tex) { c.tex.dispose(); c.tex = null; }
    tweens.to(c.alpha, 0, 0);
  }

  function start(c, now) {
    const url = c.feed.url;
    c.url = url;
    c.kind = url.startsWith('sim:') ? 'sim' : 'image';
    c.still = url.startsWith('data:');
    c.ready = false; c.img = null; c.lastOk = now; c.lastRender = -1e9; c.lastPoll = -1e9; c.canvasAt = -1e9;
    syncTwin(now);
    offscreen(() => { renderDepth(c); if (c.kind === 'sim') renderSim(c, now); });
    if (c.kind === 'image') pollImage(c, now);
  }

  /** Decide which cameras hold a slot and which of them project. Cheap; called on every change. */
  function reconcile() {
    if (disposed) return;
    const now = performance.now();
    let any = false, changed = false;
    for (const c of cams.values()) {
      const project = view === 'reality' && !offline && !!c.feed && o.levelShown(c.L);
      const wanted = !!c.feed && (project || now - c.asked < ASKED_MS);
      if (wanted && c.slot < 0) {
        const i = slots.indexOf(null);
        if (i < 0) {
          if (!warnedFull) { warnedFull = true; console.warn(`House View: more than ${PROJECTORS} camera pictures at once; the rest stay the model.`); }
        } else {
          slots[i] = c; c.slot = i;
          start(c, now);
          changed = true;
        }
      } else if (c.slot >= 0 && wanted && c.url !== c.feed.url) {
        start(c, now);
        changed = true;
      }
      if (c.slot >= 0) {
        if (c.kind === 'image' && !c.still && now - c.lastOk > IMAGE_STALE_MS) c.ready = false;      // rule 13: no picture, no projection
        const target = project && c.ready ? 1 : 0;
        if (c.alpha.target !== target) { tweens.to(c.alpha, target, o.dur(400, 'fade'), EASE.fade); changed = true; }
        if (!wanted && c.alpha.v <= 0.004 && c.alpha.target === 0) { release(c); changed = true; }
      }
      if (c.slot >= 0) any = true;
    }
    if (any && !timer) timer = setInterval(tick, 125);
    if (!any && timer) { clearInterval(timer); timer = 0; }
    if (changed) o.onDirty();
  }

  /** Written every frame the model draws: strengths, and the depth maps when a door or a car has moved. */
  function apply() {
    if (disposed) return;
    let live = false;
    for (let i = 0; i < PROJECTORS; i++) {
      const c = slots[i];
      writeSlot(i);
      if (c && c.alpha.v > 0.004) live = true;
    }
    G.uRV.value = live ? 1 : 0;
    if (live) refreshDepth(performance.now(), false);
  }

  // ---- the clock: simulated frames, picture polls, card canvases --------------------------------------
  function drawCard(c, now) {
    if (!c.canvas) return;
    const ctx = c.canvas.getContext('2d');
    if (c.kind === 'image') {
      if (c.img) { try { ctx.drawImage(c.img, 0, 0, c.canvas.width, c.canvas.height); } catch { /* a picture that cannot be drawn stays as it was */ } }
    } else if (c.ready && c.slot >= 0) {
      const x = (c.slot % PROJ_COLS) * FW, y = Math.floor(c.slot / PROJ_COLS) * FH;
      const buf = new Uint8Array(FW * FH * 4);
      gl.readRenderTargetPixels(feedRT, x, y, FW, FH, buf);
      if (!scratch) { scratch = document.createElement('canvas'); scratch.width = FW; scratch.height = FH; }
      const sctx = scratch.getContext('2d');
      const img = sctx.createImageData(FW, FH);
      for (let row = 0; row < FH; row++) img.data.set(buf.subarray((FH - 1 - row) * FW * 4, (FH - row) * FW * 4), row * FW * 4);
      for (let k = 3; k < img.data.length; k += 4) img.data[k] = 255;
      sctx.putImageData(img, 0, 0);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(scratch, 0, 0, c.canvas.width, c.canvas.height);
    }
    c.canvasAt = now;
  }
  let scratch = null;

  function tick(force) {
    if (disposed) return;
    const now = performance.now();
    const due = [];
    for (const c of slots) {
      if (!c) continue;
      const asked = now - c.asked < ASKED_MS;
      if (c.kind === 'image') {
        if (now - c.lastPoll >= IMAGE_POLL_MS) pollImage(c, now);
      } else if (c.kind === 'sim') {
        const projecting = c.alpha.target > 0;
        if (!projecting && !asked && force !== true) continue;
        const every = projecting ? 1000 / FPS : 500;
        if (force === true || now - c.lastRender >= every - 20) due.push(c);
      }
    }
    let dirty = false;
    if (due.length) {
      due.sort((a, b) => a.lastRender - b.lastRender);
      const batch = force === true ? due : due.slice(0, 2);
      syncTwin(now);
      offscreen(() => { for (const c of batch) renderSim(c, now); });
      dirty = batch.some((c) => c.alpha.v > 0.004);
    }
    for (const c of slots) if (c && c.canvas && now - c.asked < ASKED_MS && now - c.canvasAt >= CARD_MS) drawCard(c, now);
    reconcile();
    if (dirty) o.onDirty();
  }

  // ---- public -----------------------------------------------------------------------------------------
  return {
    get view() { return view; },
    /** Cameras projecting right now. */
    get projectors() { let n = 0; for (const c of slots) if (c && c.alpha.target > 0) n++; return n; },
    /** 0..1: how strongly this camera's picture lies on the model at this moment. */
    strength(id) { const c = cams.get(id); return c && c.slot >= 0 ? c.alpha.v : 0; },
    setView(next) { view = next; reconcile(); },
    /** @param feeds Map(camera id -> { url, person:boolean }) for cameras with a feed claim; the rest have none. */
    setFeeds(feeds, isOffline) {
      offline = !!isOffline;
      for (const c of cams.values()) {
        const f = feeds.get(c.id) || null;
        c.feed = f && typeof f.url === 'string' && f.url ? { url: f.url } : null;
        c.person = !!(f && f.person);
      }
      reconcile();
    },
    reconcile, apply,
    /** After the graphics context comes back: every tile is empty until it is drawn again. */
    restore() {
      depthKey = '';
      for (const c of slots) if (c) { c.lastRender = -1e9; if (c.kind === 'image') { c.img = null; c.ready = false; c.lastPoll = -1e9; if (c.tex) { c.tex.dispose(); c.tex = null; } } }
      if (slots.some(Boolean)) { refreshDepth(performance.now(), true); tick(true); }
    },
    tick: () => tick(true),
    feedCanvas(id) {
      const c = cams.get(id);
      if (disposed || !c || !c.feed) return null;
      const now = performance.now();
      c.asked = now;
      if (c.slot < 0) reconcile();
      if (c.slot < 0) return null;
      if (c.kind === 'image' && !c.img) return null;            // nothing has arrived yet: no picture to show
      if (c.kind === 'image' && !c.ready) return null;
      if (!c.canvas) {
        c.canvas = document.createElement('canvas');
        c.canvas.width = CARD_W;
        c.canvas.height = Math.round(CARD_W / c.aspect);
      }
      if (now - c.canvasAt >= CARD_MS) {
        if (c.kind === 'sim' && now - c.lastRender > 600) { syncTwin(now); offscreen(() => renderSim(c, now)); }
        drawCard(c, now);
      }
      return c.canvas;
    },
    /** For tests and the dev page. */
    feeds() {
      return [...cams.values()].map((c) => ({ id: c.id, level: c.L.id, feed: !!c.feed, kind: c.kind, slot: c.slot, ready: c.ready, projecting: c.slot >= 0 && c.alpha.target > 0 }));
    },
    three: { twin, feedRT, depthRT, cams },
    dispose() {
      disposed = true;
      if (timer) clearInterval(timer);
      timer = 0;
      for (const c of cams.values()) { if (c.tex) c.tex.dispose(); c.tex = null; c.img = null; c.canvas = null; }
      depthTex.dispose();
      G.uFeedTex.value = null; G.uFeedDepth.value = null; G.uRV.value = 0;
      for (const d of disposables) d.dispose && d.dispose();
    },
  };
}
