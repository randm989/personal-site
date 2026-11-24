// House View renderer. See docs/CONTRACTS.md §4 for the interface.
//
// The scene is a matte clay model cut at `cutHeight`. State is drawn as the physical change: lamplight is
// a baked-visibility glow in the clay shader (never a THREE light per bulb), doors swing, the garage door
// rises, blinds drop. Frames are rendered on demand only.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildHouse, GROUND_DROP, OUTDOOR_TOP, FIGURE_HEIGHT, MAX_LAMPS, setRangeColor } from './scene.js';
import { createGlobalUniforms } from './materials.js';
import { THEMES, mixThemes, kelvinToLinear, rgbToLinear } from './palette.js';
import { Anim, Tweens, EASE } from './tween.js';
import { createRig, defaultViews } from './camera.js';
import { pointInPolygon } from './lightmap.js';
import { createReality } from './reality.js';

const TIER_DPR = { high: 2, medium: 1.5, low: 1 };
const TV_ON = [0.62, 0.74, 0.95], WARM_ON = [1, 0.68, 0.28];

function guessTier() {
  try {
    const asked = new URLSearchParams(location.search).get('tier');
    if (asked && TIER_DPR[asked]) return asked;
  } catch { /* no location */ }
  const ua = navigator.userAgent || '';
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 4;
  if (/Silk|Tizen|Web0S|webOS|SmartTV|\bKF[A-Z]{2,}/i.test(ua) || cores <= 4 || mem <= 2) return 'low';
  if (/Android|iPhone|iPad|Mobile/i.test(ua) || cores <= 6) return 'medium';
  return 'high';
}

function showMessage(container, text) {
  const el = document.createElement('p');
  el.className = 'fatal hv-render-message';
  el.setAttribute('role', 'alert');
  el.textContent = text;
  // readable even if the page has no .fatal style
  el.style.cssText += ';position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);max-width:42ch;margin:0;padding:24px;'
    + 'border-radius:16px;background:#232D3A;color:#EEF2F6;font:500 15px/1.45 system-ui,sans-serif;z-index:2';
  container.appendChild(el);
  return el;
}

/**
 * @param {HTMLElement} container
 * @param {object} plan CompiledPlan
 * @param {{theme?:'day'|'night', tier?:'high'|'medium'|'low', cutHeight?:number}} options
 */
export function createRenderer(container, plan, options = {}) {
  if (!container || !plan || !Array.isArray(plan.levels) || !plan.levels.length) {
    throw new Error('createRenderer needs a container element and a compiled plan with at least one level.');
  }
  const cut = options.cutHeight > 0 ? options.cutHeight : 1.2;
  const tier = TIER_DPR[options.tier] ? options.tier : guessTier();
  let theme = options.theme === 'day' ? 'day' : 'night';

  // ---- WebGL ---------------------------------------------------------------------------------------
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;outline:none;transition:filter 600ms cubic-bezier(0.25,0.1,0.25,1)';
  let gl;
  try {
    gl = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, stencil: true, powerPreference: 'high-performance' });
  } catch (err) {
    showMessage(container, 'The 3D view could not start: this browser or device has no WebGL 2.');
    throw new Error(`House View renderer: WebGL is unavailable (${err && err.message ? err.message : err}).`);
  }
  container.appendChild(canvas);
  gl.setClearColor(0x000000, 0);
  gl.outputColorSpace = THREE.SRGBColorSpace;
  gl.toneMapping = THREE.NeutralToneMapping;
  gl.toneMappingExposure = 1;
  gl.shadowMap.enabled = true;
  gl.shadowMap.type = THREE.PCFShadowMap;
  gl.shadowMap.autoUpdate = false;
  gl.info.autoReset = false;

  let lostMessage = null;
  const onLost = (e) => {
    e.preventDefault();
    if (!lostMessage) lostMessage = showMessage(container, 'The 3D view lost its graphics context. It will come back by itself; if it does not, reload the page.');
  };
  const onRestored = () => { if (lostMessage) { lostMessage.remove(); lostMessage = null; } shadowDirty = true; reality.restore(); stateDirty = true; invalidate(); };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  // ---- scene ---------------------------------------------------------------------------------------
  const scene = new THREE.Scene();
  const G = createGlobalUniforms();
  const lambert = tier === 'low';
  const house = buildHouse(plan, { cut, G, lambert, views: Object.values(defaultViews(plan.bounds)) });
  scene.add(house.root);
  const levels = house.levels;
  const things = house.things;

  let envTexture = null;
  if (!lambert) {
    const pmrem = new THREE.PMREMGenerator(gl);
    const room = new RoomEnvironment();
    envTexture = pmrem.fromScene(room, 0.04).texture;
    scene.environment = envTexture;
    pmrem.dispose();
    room.traverse?.((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
  }

  // Key light: elevation 50 degrees, from the front-left of the model, so the faces toward the default
  // camera are lit and shadows fall away into the rooms.
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  const elev = THREE.MathUtils.degToRad(50), azim = THREE.MathUtils.degToRad(-42);
  const sunDir = new THREE.Vector3(Math.cos(elev) * Math.sin(azim), Math.sin(elev), Math.cos(elev) * Math.cos(azim));
  const B = plan.bounds;
  const centre = new THREE.Vector3((B.minX + B.maxX) / 2, 0, (B.minY + B.maxY) / 2);
  const topMost = levels[levels.length - 1].elev + cut;
  sun.position.copy(centre).addScaledVector(sunDir, 40);
  sun.target.position.copy(centre);
  sun.castShadow = true;
  const mapSize = tier === 'low' ? 1024 : 2048;
  sun.shadow.mapSize.set(mapSize, mapSize);
  {
    // Fit the shadow frustum to the house box plus the reach of its own shadow on the ground.
    const cam = sun.shadow.camera;
    const m = new THREE.Matrix4().lookAt(sun.position, centre, new THREE.Vector3(0, 1, 0)).invert();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const pad = 1.2;
    for (const x of [B.minX - pad, B.maxX + pad]) for (const y of [-GROUND_DROP, topMost + 1.6]) for (const z of [B.minY - pad, B.maxY + pad]) {
      for (const shadow of [0, 1]) {
        const p = new THREE.Vector3(x, y, z);
        if (shadow) p.addScaledVector(sunDir, -(y + GROUND_DROP) / sunDir.y);   // where this corner's shadow lands
        p.sub(sun.position).applyMatrix4(m);
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
        minZ = Math.min(minZ, -p.z); maxZ = Math.max(maxZ, -p.z);
      }
    }
    cam.left = minX; cam.right = maxX; cam.bottom = minY; cam.top = maxY;
    cam.near = Math.max(0.5, minZ - 1); cam.far = maxZ + 1;
    cam.updateProjectionMatrix();
  }
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.025;
  sun.shadow.radius = tier === 'low' ? 2.5 : 4;
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x888888, 0.4);
  scene.add(hemi);

  // ---- animation state ------------------------------------------------------------------------------
  const tweens = new Tweens();
  const themeMix = new Anim(theme === 'day' ? 1 : 0);
  const mixed = mixThemes(THEMES.night, THEMES.day, themeMix.v);
  const reduce = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  const reduceMotion = () => !!reduce.matches;
  /** kind: 'light' | 'move' | 'fade' | 'camera' */
  const dur = (ms, kind) => {
    if (!reduceMotion()) return ms;
    if (kind === 'light') return Math.min(ms, 300);
    if (kind === 'fade') return Math.min(ms, 200);
    return 0;
  };

  let first = true;
  let settled = false;
  let disposed = false;
  let shadowDirty = true;
  let stateDirty = true;
  let focusLevel = levels[0].id;           // level id or 'all'
  let lastDerived = null;
  let offline = false;
  let focusedId = null;
  let view = 'model';                      // 'model' | 'reality' (camera pictures laid onto the model)
  const listeners = { select: new Set(), frame: new Set(), level: new Set() };
  const emit = (name, arg) => { for (const fn of [...listeners[name]]) { try { fn(arg); } catch (err) { console.error(err); } } };

  // ---- camera -----------------------------------------------------------------------------------------
  const rig = createRig(canvas, plan, tweens, {
    onChange: () => invalidate(),
    onUserStart: () => { },
    reduceMotion,
    groundPoints: levels[0].cameras.flatMap((c) => c.outline),
  });
  const camera = rig.camera;

  // ---- frame loop -------------------------------------------------------------------------------------
  const timer = new THREE.Timer();
  let raf = 0, idle = true, pulseTimer = 0;
  let width = 1, height = 1;
  const drawn = { calls: 0, triangles: 0 };

  // Animation frames drive the view. A browser that withholds them (a covered or background window) would
  // leave a transition stuck half way and showing a state that is not true, so a slow timer finishes the job.
  let fallback = 0;
  function invalidate() {
    if (disposed || raf) return;
    raf = requestAnimationFrame(frame);
    if (!fallback) fallback = setTimeout(() => {
      fallback = 0;
      if (disposed || !raf) return;
      cancelAnimationFrame(raf);
      frame(performance.now(), true);
    }, 400);
  }

  function frame(ts, late) {
    raf = 0;
    if (fallback) { clearTimeout(fallback); fallback = 0; }
    if (disposed) return;
    timer.update(ts);
    let dt = timer.getDelta();
    if (idle || !(dt > 0)) dt = 1 / 60;        // waking from idle: do not jump the tweens
    dt = late ? 0.4 : Math.min(dt, 0.1);
    idle = false;
    const wasBusy = tweens.busy;
    const tweening = tweens.step(dt * 1000);
    const moving = rig.update(dt);
    if (wasBusy || stateDirty) applyState();
    if (shadowDirty) { gl.shadowMap.needsUpdate = true; shadowDirty = false; }
    gl.info.reset();
    gl.render(scene, camera);
    drawn.calls = gl.info.render.calls; drawn.triangles = gl.info.render.triangles;     // the model frame only, not the simulated feeds
    emit('frame');
    if (tweening || moving || stateDirty) invalidate();
    else {
      idle = true;
      // the one looping animation: a charging car breathes, at a low frame rate
      if (anyCharging() && !pulseTimer) pulseTimer = setTimeout(() => { pulseTimer = 0; stateDirty = true; invalidate(); }, reduceMotion() ? 1000 : 66);
    }
  }

  function anyCharging() {
    for (const L of levels) {
      if (L.opacity.target < 0.5) continue;
      for (const c of L.cars) if (c.charge.target > 0 && c.show.target > 0) return true;
    }
    return false;
  }

  // ---- applying animated values to the scene ----------------------------------------------------------
  let lastThemeMix = -1;
  let casterHash = '';
  const tmpColor = new THREE.Color();

  function applyTheme() {
    mixThemes(THEMES.night, THEMES.day, themeMix.v, mixed);
    for (let i = 0; i < mixed.slots.length; i++) G.uPal.value[i].copy(mixed.slots[i]);
    G.uLamp.value.set(mixed.lampFloor, mixed.lampWall, mixed.lampFurn, mixed.lampWhiten);
    G.uLampGain.value = mixed.lampGain;
    G.uAlert.value.set(mixed.alert.r, mixed.alert.g, mixed.alert.b, mixed.alertMix);
    G.uHaloCol.value.set(mixed.halo.r, mixed.halo.g, mixed.halo.b, mixed.haloMix);
    G.uHatchCol.value.copy(mixed.hatch);
    G.uContact.value.set(mixed.contact.r, mixed.contact.g, mixed.contact.b, mixed.contactOpacity);
    G.uSubdueCol.value.copy(mixed.subdue);
    G.uSubdueMix.value = mixed.subdueMix;
    G.uGlass.value.set(mixed.glass.r, mixed.glass.g, mixed.glass.b, mixed.glassOpacity);
    G.uAccent.value.copy(mixed.accent);
    G.uFixtureOff.value.copy(mixed.fixtureOff);
    G.uHaloGain.value = mixed.haloGain;
    sun.color.copy(mixed.key);
    sun.intensity = mixed.keyIntensity;
    sun.shadow.intensity = mixed.shadowIntensity;
    hemi.color.copy(mixed.hemiSky);
    hemi.groundColor.copy(mixed.hemiGround);
    hemi.intensity = mixed.hemiIntensity * (lambert ? 1.5 : 1);
    scene.environmentIntensity = mixed.envIntensity;
  }

  function applyState() {
    stateDirty = false;
    if (themeMix.v !== lastThemeMix) { applyTheme(); lastThemeMix = themeMix.v; }
    reality.apply();
    let hash = '';
    const now = performance.now();

    for (const L of levels) {
      const S = L.S;
      const op = L.opacity.v;
      S.uOpacity.value = op;
      S.uSubdue.value = L.subdue.v;
      S.uLampScale.value = L.lampScale.v;
      const visible = op > 0.004;
      L.group.visible = visible;
      const fading = visible && op < 0.999;
      if (L.fading !== fading) {
        L.fading = fading;
        L.prepass.visible = fading;
        L.group.traverse((o) => {
          if (o.isMesh && o.material && o.material.userData && o.material.userData.u && !o.material.userData.alwaysTransparent) {
            o.material.transparent = fading;
            o.material.needsUpdate = true;
          }
        });
      }
      const casts = L.opacity.target > 0.5 ? op > 0.35 : op > 0.65;
      if (L.casts !== casts) {
        L.casts = casts;
        L.group.traverse((o) => { if (o.isMesh && o.userData.caster !== undefined) o.castShadow = casts && o.userData.caster; });
      }
      hash += casts ? 'c' : '-';
      if (!visible) continue;

      // wall extension (the storey below a shown storey stands at full height)
      if (L.extMesh) {
        const e = L.ext.v;
        if (L.extApplied !== e) {
          L.extApplied = e;
          L.extMesh.visible = e > 0.001;
          if (L.extMesh.visible) {
            const pos = L.extMesh.geometry.attributes.position;
            const arr = pos.array, tgt = L.extTarget;
            for (let i = 1; i < arr.length; i += 3) arr[i] = L.cut + (tgt[i] - L.cut) * e;
            pos.needsUpdate = true;
          }
        }
        hash += e.toFixed(3);
      }

      for (const d of L.doors) { d.place(); hash += d.pos.v.toFixed(3); }
      for (const w of L.windows) w.place();

      // rooms
      for (const r of L.roomHandles) S.uRoomA.value[r.index].set(r.alert.v, r.halo.v, 0, 0);

      // lights
      const off = G.uFixtureOff.value;
      let slot = 0, anyRing = false;
      for (const f of L.fixtures) {
        const I = f.inten.v;
        const lamp = f.lamp;
        if (I > 0.003 && slot < L.lampSlots) {
          S.uLA.value[slot].set(lamp.pos[0], lamp.pos[1], lamp.axis[0], lamp.axis[1]);
          S.uLB.value[slot].set(lamp.reach, lamp.h, lamp.tile, lamp.gain);
          S.uLC.value[slot].set(f.r.v, f.g.v, f.b.v, I);
          const P = S.uLP.value[slot];
          P.set(0, 0, 0, 0);
          lamp.portals.forEach((id, k) => { const d = things.get(id); P.setComponent(k, d ? Math.min(1, Math.max(0, d.pos.v)) : 1); });
          slot++;
        }
        // fixture: neutral when off, a warm near-white when on
        const k = Math.min(1, I * 5) * (0.5 + 0.5 * I);
        const wr = f.r.v * 0.42 + 0.58, wg = f.g.v * 0.42 + 0.58, wb = f.b.v * 0.42 + 0.58;
        const shown = 1 - f.ring.v;
        L.emissive.setColor(f.id, off.r + (wr - off.r) * k, off.g + (wg - off.g) * k, off.b + (wb - off.b) * k, shown);
        const hi = f.index * 4;
        setRangeColor(L.halos, [hi, hi + 4], f.r.v * 0.8 + 0.2, f.g.v * 0.8 + 0.2, f.b.v * 0.8 + 0.2, I > 0.003 ? 0.35 + 0.65 * I : 0);
        const rr = L.rings.userData.ranges[f.index];
        setRangeColor(L.rings, rr, 1, 1, 1, f.ring.v);
        if (f.ring.v > 0.01) anyRing = true;
      }
      for (; slot < L.lampSlots; slot++) S.uLC.value[slot].set(0, 0, 0, 0);
      if (L.ringMesh) L.ringMesh.visible = anyRing;

      // appliances: a soft glow on the screen / door ring / status strip when running
      const dark = G.uPal.value[6];
      const lamp = mixed.applianceOn;
      for (const a of L.appliances) {
        const small = a.type === 'console' || a.type === 'printer3d';
        const on = a.type === 'tv' ? TV_ON : small ? [lamp.r, lamp.g, lamp.b] : WARM_ON;
        const k = a.run.v * (small ? 1 : 0.9);
        if (a.hasGlow && L.emissive) {
          L.emissive.setColor(a.id, dark.r + (on[0] - dark.r) * k, dark.g + (on[1] - dark.g) * k, dark.b + (on[2] - dark.b) * k, 1);
        }
        if (a.haloRange && L.halos) setRangeColor(L.halos, a.haloRange, on[0], on[1], on[2], a.run.v > 0.003 ? 0.6 * a.run.v : 0);
        if (a.fillMesh) {
          // the print grows with progress: lamplit while printing, a pale block when finished, dull when stopped
          const fv = a.fill.v;
          a.fillMesh.visible = fv > 0.004;
          if (a.fillMesh.visible) {
            a.fillMesh.scale.y = Math.max(0.001, fv * a.fillSpan);
            tmpColor.copy(off).lerp(lamp, a.run.v).lerp(mixed.applianceDone, a.done.v);
            a.fillRange.setColor('fill', tmpColor.r, tmpColor.g, tmpColor.b, 1);
          }
        }
      }

      // cameras: the view wedge and the lens
      for (const c of L.cameras) {
        const seen = c.seen.v, lost = c.lost.v, act = c.active.v, attn = c.attn.v;
        const pic = reality.strength(c.id);          // its picture lies on the ground: keep the outline, thin the tint
        const key = `${seen.toFixed(3)},${lost.toFixed(3)},${act.toFixed(3)},${attn.toFixed(3)},${themeMix.v.toFixed(3)},${pic.toFixed(3)}`;
        if (key === c.applied) continue;
        c.applied = key;
        tmpColor.copy(mixed.wedge).lerp(mixed.wedgeActive, act).lerp(mixed.attention, attn).lerp(G.uHatchCol.value, lost);
        const lively = Math.max(act, attn * 0.75);
        const fill = (seen * (mixed.wedgeFill + (mixed.wedgeFillActive - mixed.wedgeFill) * lively) + lost * 0.2) * (1 - 0.8 * pic);
        const rim = Math.min(1, seen * (mixed.wedgeRim + 0.45 * lively) + lost * 0.7);
        if (L.wedges) {
          const col = L.wedges.attributes.color, as = L.wedges.attributes.aS;
          for (let i = c.range[0]; i < c.range[1]; i++) { col.setXYZW(i, tmpColor.r, tmpColor.g, tmpColor.b, fill); as.setXY(i, lost, rim); }
          col.needsUpdate = true; as.needsUpdate = true;
        }
        if (L.emissive) {
          tmpColor.copy(dark).lerp(mixed.wedgeActive, act * 0.85).lerp(mixed.attention, attn);
          L.emissive.setColor(c.id, tmpColor.r, tmpColor.g, tmpColor.b, 1);
        }
      }

      // cars
      for (const c of L.cars) {
        const show = c.show.v;
        c.body.visible = show > 0.004;
        c.mat.userData.u.uFade.value = show;
        c.body.userData.caster = show > 0.5;
        c.body.castShadow = L.casts && c.body.userData.caster;
        hash += c.body.castShadow ? 'k' : '.';
        c.outlineMesh.visible = c.unknown.v > 0.004;
        c.lineMat.uniforms.uFade.value = c.unknown.v * 0.85;
        if (c.glow) {
          c.glow.mesh.visible = c.body.visible;
          c.glow.mat.uniforms.uFade.value = show;
          const pulse = reduceMotion() ? 0.8 : 0.5 + 0.5 * Math.sin((now / 2600) * Math.PI * 2);
          const k = c.charge.v * (0.3 + 0.7 * pulse);
          tmpColor.copy(G.uPal.value[6]).lerp(new THREE.Color(1, 0.72, 0.3), k);
          c.glow.range.setColor('glow', tmpColor.r, tmpColor.g, tmpColor.b, 1);
        }
      }
    }
    // scale figures: a phone that changed rooms fades out where it was and in where it is, never walks
    for (const p of people.values()) {
      if (p.next !== undefined && p.show.v <= 0.004) {
        placePerson(p, p.next);
        p.next = undefined;
        if (p.roomId) tweens.to(p.show, 1, dur(450, 'fade'), EASE.out);
        stateDirty = true;
      }
      for (const [levelId, fig] of p.meshes) {
        const here = !!p.level && p.level.id === levelId && p.show.v > 0.004;
        fig.mesh.visible = here;
        if (!here) continue;
        fig.mat.userData.u.uFade.value = p.show.v;
        fig.mesh.userData.caster = p.show.v > 0.5;
        fig.mesh.castShadow = p.level.casts && fig.mesh.userData.caster;
        if (fig.mesh.castShadow) hash += `p${fig.mesh.position.x.toFixed(2)},${fig.mesh.position.z.toFixed(2)}`;
      }
    }
    if (hash !== casterHash) { casterHash = hash; shadowDirty = true; }
  }

  // ---- people -----------------------------------------------------------------------------------------
  const people = new Map();        // person id -> handle (also in `things` as 'person:<id>')
  const roomSlots = new Map();     // room id -> person ids by standing spot

  function placePerson(p, roomId) {
    if (p.roomId) {
      const s = roomSlots.get(p.roomId);
      const i = s ? s.indexOf(p.pid) : -1;
      if (i >= 0) s[i] = null;
    }
    const outlined = outlines.has(p.id);
    if (outlined) { const o = outlines.get(p.id); o.parent.remove(o.object); o.object.geometry.dispose(); outlines.delete(p.id); }
    p.roomId = null; p.level = null; p.mesh = null; p.pick = null;
    const rh = roomId ? things.get(roomId) : null;
    if (rh && rh.kind === 'room') {
      let s = roomSlots.get(roomId);
      if (!s) roomSlots.set(roomId, s = []);
      let i = s.indexOf(null);
      if (i < 0) i = s.length;
      s[i] = p.pid;
      const spots = house.standSpots(rh.level, rh.room);
      let [x, z] = spots[i % spots.length];
      if (i >= spots.length) { x += Math.cos(i * 2.4) * 0.34; z += Math.sin(i * 2.4) * 0.34; }   // a crowd: gather round
      const L = rh.level;
      let fig = p.meshes.get(L.id);
      if (!fig) p.meshes.set(L.id, fig = house.makeFigure(L));
      const y = rh.room.outdoor ? OUTDOOR_TOP : 0;
      fig.mesh.position.set(x, y, z);
      p.roomId = roomId; p.level = L; p.mesh = fig.mesh;
      p.anchor.set(x, L.elev + y + FIGURE_HEIGHT + 0.24, z);
      p.pick = { a: new THREE.Vector3(x, L.elev + y + 0.25, z), b: new THREE.Vector3(x, L.elev + y + FIGURE_HEIGHT - 0.12, z) };
    }
    if (outlined) refreshOutlines();
  }

  function movePerson(p, want, snap) {
    if (snap || p.show.v <= 0.004) {
      p.next = undefined;
      if (p.roomId !== want) placePerson(p, want);
      tweens.to(p.show, p.roomId ? 1 : 0, snap ? 0 : dur(450, 'fade'), EASE.out);
    } else if (want === p.roomId) {
      p.next = undefined;
      tweens.to(p.show, 1, dur(300, 'fade'), EASE.out);
    } else {
      p.next = want;
      tweens.to(p.show, 0, dur(260, 'fade'), EASE.in);
    }
  }

  function updatePeople(derived, snap) {
    const list = Array.isArray(derived.people) ? derived.people : [];
    const present = new Set();
    for (const ps of list) {
      if (!ps || ps.id == null) continue;
      const pid = String(ps.id);
      present.add(pid);
      let p = people.get(pid);
      if (!p) {
        p = {
          id: 'person:' + pid, pid, kind: 'person', level: null, roomId: null, mesh: null, meshes: new Map(),
          show: new Anim(0), anchor: new THREE.Vector3(), pick: null, next: undefined,
        };
        people.set(pid, p);
        things.set(p.id, p);
      }
      // A figure is a claim about where a phone is: only a fresh room reading of someone at home draws one.
      const claim = !offline && ps.home !== false && typeof ps.room === 'string' && (ps.freshness == null || ps.freshness === 'fresh');
      const room = claim ? things.get(ps.room) : null;
      movePerson(p, room && room.kind === 'room' ? ps.room : null, snap);
    }
    for (const [pid, p] of people) if (!present.has(pid)) movePerson(p, null, snap);
  }

  // mark shadow casters once
  for (const L of levels) {
    L.group.traverse((o) => { if (o.isMesh) o.userData.caster = o.castShadow; });
    for (const c of L.cars) c.mat.userData.alwaysTransparent = true;
  }

  // ---- reality view: camera pictures laid onto the model (reality.js) ---------------------------------
  const reality = createReality({
    gl, plan, house, G, tier, cut, tweens, dur, sunDir, themeMix, levelShown,
    listPeople() {
      const out = [];
      for (const p of people.values()) {
        if (p.level && p.mesh && p.show.target > 0 && p.next === undefined) out.push({ id: p.pid, x: p.mesh.position.x, y: p.mesh.position.y, z: p.mesh.position.z, level: p.level, room: p.roomId });
      }
      return out;
    },
    onDirty() { stateDirty = true; invalidate(); },
  });

  function setView(next) {
    if (disposed) return;
    if (next !== 'model' && next !== 'reality') throw new Error(`setView: expected "model" or "reality", got "${next}".`);
    view = next;
    reality.setView(view);
    stateDirty = true;
    invalidate();
  }

  // ---- public: update(derived) ------------------------------------------------------------------------
  function update(derived) {
    if (disposed || !derived || !derived.things) return;
    // Until the first settled snapshot (live or offline) nothing animates: the model must not act out the
    // difference between "still connecting" and the real house.
    const snap = first || !settled;
    if (derived.connection !== 'connecting') settled = true;
    const T = (a, v, ms, ease) => tweens.to(a, v, snap ? 0 : ms, ease);
    offline = derived.connection === 'offline';
    canvas.style.filter = offline ? 'saturate(0.35) brightness(0.84) contrast(0.9)' : '';
    const feeds = new Map();          // cameras with a live picture right now (a claim: fresh, not in privacy)

    for (const [id, h] of things) {
      if (h.kind === 'person') continue;
      const ts = derived.things[id] || { freshness: 'unsensed' };
      const fr = ts.freshness || 'unsensed';
      const fresh = fr === 'fresh';
      const lost = fr === 'unknown' || fr === 'stale';

      if (h.kind === 'light') {
        const on = fresh && ts.on === true && !offline;
        const level = on ? (typeof ts.level === 'number' ? Math.max(0.12, Math.min(1, ts.level)) : 1) : 0;
        if (on) {
          const c = Array.isArray(ts.rgb) ? rgbToLinear(ts.rgb) : kelvinToLinear(ts.colorTempK);
          const wasOff = h.inten.target <= 0.003 && h.inten.v <= 0.003;
          const ms = wasOff ? 0 : dur(400, 'light');
          T(h.r, c[0], ms, EASE.fade); T(h.g, c[1], ms, EASE.fade); T(h.b, c[2], ms, EASE.fade);
        }
        const rising = level > h.inten.target;
        const wasOn = h.inten.target > 0.003;
        T(h.inten, level, wasOn && level > 0 ? dur(400, 'light') : rising ? dur(350, 'light') : dur(600, 'light'),
          wasOn && level > 0 ? EASE.fade : rising ? EASE.out : EASE.fade);
        T(h.ring, lost ? 1 : 0, dur(600, 'fade'), EASE.fade);
      } else if (h.kind === 'door') {
        let pos, hatch = 0, plain = 0;
        const hinged = h.style === 'hinged';
        const claim = fresh && (typeof ts.position === 'number' || typeof ts.open === 'boolean');
        if (claim) {
          pos = typeof ts.position === 'number' ? Math.max(0, Math.min(1, ts.position)) : (ts.open ? 1 : 0);
        } else if (lost) {
          pos = hinged ? 20 / 80 : h.style === 'garage' ? 0.25 : 0.15; hatch = 1;
        } else if (fr === 'offline') {
          pos = hinged ? 20 / 80 : h.style === 'garage' ? 0.25 : 0.15; plain = 1;
        } else {
          pos = hinged ? 35 / 80 : 0; plain = 1;          // unsensed: plain architecture, part open
        }
        const opening = pos > h.pos.target;
        let ms = hinged || h.style === 'sliding' ? (opening ? 600 : 450) : 1200;
        if (h.style === 'garage' && claim && typeof ts.position === 'number' && ts.moving) ms = 500;   // following reports
        T(h.pos, pos, dur(ms, 'move'), EASE.hinge);
        T(h.hatch, hatch, dur(600, 'fade'), EASE.fade);
        T(h.plain, plain, dur(600, 'fade'), EASE.fade);
        T(h.ghost, h.style === 'garage' && fr === 'unsensed' ? 1 : 0, dur(600, 'fade'), EASE.fade);
      } else if (h.kind === 'window') {
        const open = fresh && ts.open === true ? 1 : lost ? 0.35 : 0;
        T(h.open, open, dur(open > h.open.target ? 600 : 450, 'move'), EASE.hinge);
        const hasBlind = fresh && typeof ts.blind === 'number';
        if (hasBlind) T(h.blindPos, Math.max(0, Math.min(1, ts.blind)), h.blindShown.target > 0 ? dur(1200, 'move') : 0, EASE.hinge);
        T(h.blindShown, hasBlind ? 1 : 0, dur(400, 'fade'), EASE.fade);
        T(h.hatch, lost ? 1 : 0, dur(600, 'fade'), EASE.fade);
      } else if (h.kind === 'room') {
        T(h.alert, fresh && (ts.alert === 'leak' || ts.alert === 'smoke') ? 1 : 0, dur(600, 'fade'), EASE.fade);
        // presence and motion share one calm cue; `active` is derive's own fresh-claims-only summary of both
        const active = !offline && (ts.active === true || (fresh && (ts.occupied === true || ts.motion === true)));
        T(h.halo, active ? 1 : 0, dur(active ? 500 : 1100, 'fade'), EASE.fade);
      } else if (h.kind === 'camera') {
        const live = fresh && !offline;
        const active = live ? (ts.person === true ? 1 : ts.motion === true ? 0.6 : 0) : 0;
        T(h.seen, live ? 1 : 0, dur(600, 'fade'), EASE.fade);
        T(h.lost, lost || fr === 'offline' ? 1 : 0, dur(600, 'fade'), EASE.fade);
        T(h.active, active, dur(active >= h.active.target ? 450 : 1100, 'light'), active >= h.active.target ? EASE.out : EASE.fade);
        T(h.attn, live && ts.status === 'attention' ? 1 : 0, dur(450, 'light'), EASE.fade);
        if (live && ts.privacy !== true && ts.feed && typeof ts.feed.url === 'string' && ts.feed.url) feeds.set(id, { url: ts.feed.url, person: ts.person === true });
      } else if (h.sub === 'car') {
        const present = fresh ? ts.present : null;
        T(h.show, present === true ? 1 : 0, dur(500, 'fade'), EASE.fade);
        // a dashed bay outline means "we do not know"; a bay nobody senses is just floor
        T(h.unknown, (lost || fr === 'offline' || (fresh && present !== true && present !== false)) ? 1 : 0, dur(600, 'fade'), EASE.fade);

        T(h.charge, present === true && ts.charging === true ? 1 : 0, dur(600, 'light'), EASE.fade);
      } else if (h.kind === 'object') {
        // `phase` (round 2) is the authority when present; older Derived objects only say `running`
        const phase = !fresh ? null : typeof ts.phase === 'string' ? ts.phase : ts.running === true ? 'running' : null;
        const running = phase === 'running';
        T(h.run, running ? 1 : 0, dur(running ? 350 : 600, 'light'), running ? EASE.out : EASE.fade);
        if (h.fill) {
          const progress = typeof ts.progress === 'number' && Number.isFinite(ts.progress) ? Math.max(0, Math.min(1, ts.progress)) : null;
          let fill = 0;
          if (phase === 'done') fill = 1;
          else if (phase === 'running' || phase === 'paused' || phase === 'error') fill = Math.max(0.08, progress ?? 0.3);
          const wasShown = h.fill.target > 0;
          T(h.fill, fill, wasShown && fill > 0 ? dur(600, 'move') : dur(400, 'fade'), EASE.fade);
          T(h.done, phase === 'done' ? 1 : 0, dur(600, 'fade'), EASE.fade);
        }
      }
    }
    updatePeople(derived, snap);
    if (snap) applyState();              // a simulated camera's first frame must see the lamps as they now are
    reality.setFeeds(feeds, offline);
    lastDerived = derived;
    first = false;
    stateDirty = true;
    invalidate();
  }

  // ---- public: storeys ---------------------------------------------------------------------------------
  function levelIndex(id) { return levels.findIndex((L) => L.id === id); }

  function setLevel(id, { instant = false } = {}) {
    if (disposed) return;
    if (id !== 'all' && levelIndex(id) < 0) throw new Error(`setLevel: unknown level "${id}". Known: ${levels.map((L) => L.id).join(', ')}, all.`);
    const prevTop = focusLevel === 'all' ? levels.length - 1 : levelIndex(focusLevel);
    focusLevel = id;
    const all = id === 'all';
    const k = all ? levels.length - 1 : levelIndex(id);
    const up = k > prevTop;
    const snap = instant || first || !settled;
    const ms = (v, kind) => (snap ? 0 : dur(v, kind));
    levels.forEach((L, i) => {
      const below = i < k, shown = i <= k;
      const hasAbove = i < levels.length - 1;
      tweens.to(L.opacity, shown ? 1 : 0, ms(shown ? 400 : 300, 'fade'), EASE.fade, shown && !snap && L.opacity.v < 0.5 ? dur(500, 'fade') : 0);
      tweens.to(L.subdue, below && !all ? 1 : 0, ms(900, 'fade'), EASE.fade);
      tweens.to(L.lampScale, below && !all ? 0.5 : 1, ms(900, 'fade'), EASE.fade);
      const e = (below || (all && hasAbove && i < k)) ? 1 : 0;
      tweens.to(L.ext, e, ms(e ? 560 : 600, 'move'), EASE.hinge, !e && !snap && !up ? dur(240, 'fade') : 0);
    });
    rig.setTop(levels[k].elev + cut, snap ? 0 : dur(900, 'camera'));
    stateDirty = true;
    reality.reconcile();
    refreshOutlines();
    invalidate();
  }

  // ---- public: theme -----------------------------------------------------------------------------------
  function setTheme(next) {
    if (disposed) return;
    if (next !== 'day' && next !== 'night') throw new Error(`setTheme: expected "day" or "night", got "${next}".`);
    theme = next;
    tweens.to(themeMix, next === 'day' ? 1 : 0, first ? 0 : 1200, EASE.fade);
    stateDirty = true;
    invalidate();
  }

  // ---- outlines (highlight + focus) ----------------------------------------------------------------------
  const outlines = new Map();      // id -> { object, parent }
  let highlightIds = [];
  let highlightTimer = 0;

  function refreshOutlines() {
    const want = new Set(highlightIds);
    if (focusedId) want.add(focusedId);
    for (const [id, o] of outlines) {
      if (!want.has(id)) { o.parent.remove(o.object); o.object.geometry.dispose(); outlines.delete(id); }
    }
    for (const id of want) {
      if (outlines.has(id) || !things.has(id)) continue;
      const o = house.makeOutline(id);
      if (o) outlines.set(id, o);
    }
    invalidate();
  }

  function highlight(ids, ms) {
    if (disposed) return;
    clearTimeout(highlightTimer);
    highlightIds = (Array.isArray(ids) ? ids : ids ? [ids] : []).filter((id) => things.has(id));
    refreshOutlines();
    if (highlightIds.length && ms > 0) highlightTimer = setTimeout(() => { highlightIds = []; refreshOutlines(); }, ms);
  }

  function focus(id) {
    if (disposed) return;
    if (id == null || id === 'house') {
      focusedId = null;
      rig.goOverview(dur(800, 'camera'));
    } else {
      const h = things.get(id);
      if (!h) { console.warn(`House View renderer: focus("${id}") ignored, the plan has no such thing.`); return; }
      if (!h.level) { console.warn(`House View renderer: focus("${id}") ignored, that figure is not in the model right now.`); return; }
      focusedId = id;
      const p = h.anchor.clone();
      p.y = h.level.elev + 0.4;
      rig.focusOn(p, dur(700, 'camera'));
    }
    refreshOutlines();
  }

  // ---- public: insets, ambient ---------------------------------------------------------------------------
  function setInsets(insets) {
    if (disposed) return;
    rig.setInsets(insets || {}, first ? 0 : dur(500, 'camera'));
    invalidate();
  }

  let ambientOn = false, driftTimer = 0, cycleTimer = 0;
  function setAmbient(on) {
    if (disposed) return;
    ambientOn = !!on;
    clearInterval(driftTimer); clearInterval(cycleTimer);
    driftTimer = cycleTimer = 0;
    rig.setAmbient(ambientOn);
    if (!ambientOn || reduceMotion()) return;
    const amplitude = THREE.MathUtils.degToRad(width >= 1600 ? 5 : 3);
    driftTimer = setInterval(() => { if (rig.drift(amplitude)) invalidate(); }, 1000);
    cycleTimer = setInterval(() => {
      if (levels.length < 2) return;
      if (lastDerived && Array.isArray(lastDerived.attention) && lastDerived.attention.length) return;
      const k = focusLevel === 'all' ? -1 : levelIndex(focusLevel);
      const next = levels[(k + 1) % levels.length].id;
      setLevel(next);
      emit('level', next);
    }, 45000);
  }

  // ---- public: project --------------------------------------------------------------------------------------
  const v3 = new THREE.Vector3();
  function levelShown(L) {
    if (focusLevel === 'all') return true;
    return L.id === focusLevel;
  }
  function project(id) {
    let anchor, L = null;
    if (id === 'house') anchor = v3.set(centre.x, topMost + 0.4, centre.z);
    else {
      const h = things.get(id);
      if (!h || !h.level || (h.kind === 'person' && h.show.target <= 0)) return { x: 0, y: 0, visible: false };
      anchor = v3.copy(h.anchor); L = h.level;
    }
    camera.updateMatrixWorld();
    anchor.project(camera);
    const x = (anchor.x * 0.5 + 0.5) * width, y = (-anchor.y * 0.5 + 0.5) * height;
    const onScreen = anchor.z > -1 && anchor.z < 1 && x >= 0 && x <= width && y >= 0 && y <= height;
    return { x, y, visible: onScreen && (!L || levelShown(L)) };
  }

  // ---- picking ------------------------------------------------------------------------------------------------
  const ray = new THREE.Raycaster();
  const pA = new THREE.Vector3(), pB = new THREE.Vector3();
  function toScreen(p, out) {
    out.copy(p).project(camera);
    out.x = (out.x * 0.5 + 0.5) * width; out.y = (-out.y * 0.5 + 0.5) * height;
    return out;
  }
  function segDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
    return Math.hypot(px - ax - dx * t, py - ay - dy * t);
  }
  function pick(x, y) {
    camera.updateMatrixWorld();
    const metre = (() => {      // pixels per metre near the middle of the house
      toScreen(pA.copy(rig.controls.target), pA);
      toScreen(pB.copy(rig.controls.target).add(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0)), pB);
      return Math.hypot(pA.x - pB.x, pA.y - pB.y);
    })();
    let best = null, bestScore = 1;
    for (const [id, h] of things) {
      if (h.kind === 'room' || !h.level || !levelShown(h.level)) continue;
      if (h.sub === 'car' && h.show.target <= 0 && h.unknown.target <= 0) continue;
      if (h.kind === 'person' && (h.show.target <= 0 || h.next !== undefined || !h.pick)) continue;
      // The generous radius is for things that carry a state worth tapping. A fixture that is off (and not
      // unknown) is plain architecture: it takes a direct hit only, so a tap on open floor selects the room.
      const quiet = h.kind === 'light' && h.inten.target <= 0.003 && h.ring.target <= 0;
      // generous, but never more than about half a metre of the model, so it cannot swallow the floor
      const generous = Math.max(14, Math.min(28, 0.5 * metre));
      let d = Infinity, radius = quiet ? Math.max(7, h.pick.radius * 0.85 * metre) : generous;
      if (!quiet) {
        toScreen(h.anchor, pA);
        if (pA.z < 1) d = Math.hypot(pA.x - x, pA.y - y);
      }
      if (h.pick && h.pick.a) {
        toScreen(h.pick.a, pA); toScreen(h.pick.b, pB);
        d = Math.min(d, segDist(x, y, pA.x, pA.y, pB.x, pB.y));
      } else if (h.pick && h.pick.point) {
        toScreen(h.pick.point, pA);
        d = Math.min(d, Math.hypot(pA.x - x, pA.y - y));
        if (!quiet) radius = Math.max(generous, h.pick.radius * metre);


      }
      // small things win ties over big ones
      const score = d / radius + (radius > 40 ? 0.15 : 0);
      if (d <= radius && score < bestScore) { best = id; bestScore = score; }
    }
    if (best) return best;
    // a room floor: the focused storey first, then the storeys below it
    ray.setFromCamera(new THREE.Vector2((x / width) * 2 - 1, -(y / height) * 2 + 1), camera);
    const k = focusLevel === 'all' ? levels.length - 1 : levelIndex(focusLevel);
    for (let i = k; i >= 0; i--) {
      const L = levels[i];
      const t = (L.elev - ray.ray.origin.y) / ray.ray.direction.y;
      if (!(t > 0)) continue;
      const px = ray.ray.origin.x + ray.ray.direction.x * t, pz = ray.ray.origin.z + ray.ray.direction.z * t;
      for (const room of L.rooms) if (pointInPolygon(px, pz, room.polygon)) return room.id;
    }
    return null;
  }

  let down = null;
  const onDown = (e) => { if (e.isPrimary === false) { down = null; return; } down = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId }; };
  const onUp = (e) => {
    if (!down || e.pointerId !== down.id) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const held = performance.now() - down.t;
    down = null;
    if (moved > 8 || held > 700) return;         // an orbit drag or a long press, not a tap
    const rect = canvas.getBoundingClientRect();
    emit('select', pick(e.clientX - rect.left, e.clientY - rect.top));
  };
  const onCancel = () => { down = null; };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onCancel);

  // ---- size ---------------------------------------------------------------------------------------------------
  function resize() {
    if (disposed) return;
    const w = Math.max(1, Math.round(container.clientWidth)), h = Math.max(1, Math.round(container.clientHeight));
    const dpr = Math.min(window.devicePixelRatio || 1, TIER_DPR[tier]);
    width = w; height = h;
    gl.setPixelRatio(dpr);
    gl.setSize(w, h, false);
    gl.getDrawingBufferSize(G.uResolution.value);
    G.uPx.value = dpr;
    rig.resize(w, h);
    stateDirty = true;
    invalidate();
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  if (ro) ro.observe(container); else window.addEventListener('resize', resize);
  const onMotionPref = () => { if (ambientOn) setAmbient(true); };
  reduce.addEventListener?.('change', onMotionPref);

  // ---- start --------------------------------------------------------------------------------------------------
  applyTheme();
  setLevel(focusLevel, { instant: true });
  resize();
  applyState();

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf);
    clearTimeout(pulseTimer); clearTimeout(highlightTimer); clearTimeout(fallback); clearInterval(driftTimer); clearInterval(cycleTimer);
    if (ro) ro.disconnect(); else window.removeEventListener('resize', resize);
    reduce.removeEventListener?.('change', onMotionPref);
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onCancel);
    canvas.removeEventListener('webglcontextlost', onLost);
    canvas.removeEventListener('webglcontextrestored', onRestored);
    for (const o of outlines.values()) { o.parent.remove(o.object); o.object.geometry.dispose(); }
    outlines.clear();
    rig.dispose();
    reality.dispose();
    house.dispose();
    if (envTexture) envTexture.dispose();
    sun.shadow.dispose?.();
    gl.dispose();
    try { gl.forceContextLoss(); } catch { /* already gone */ }
    if (lostMessage) lostMessage.remove();
    canvas.remove();
    for (const set of Object.values(listeners)) set.clear();
  }

  return {
    update, setState: update, setLevel: (id) => setLevel(id), setTheme, setView,
    /** The camera's latest raw frame on a small 2D canvas, or null when it has no feed (for the UI card). */
    feedCanvas: (cameraId) => reality.feedCanvas(cameraId),
    setInsets, focus, highlight, setAmbient, project, dispose,
    on(name, fn) {
      if (!listeners[name]) throw new Error(`renderer.on: unknown event "${name}" (select, frame, level).`);
      listeners[name].add(fn);
      return () => listeners[name].delete(fn);
    },
    /** Not part of the contract: numbers for the dev page and tests. */
    debug: {
      get info() { return { calls: drawn.calls, triangles: drawn.triangles, tier, lampSlotsPerLevel: MAX_LAMPS, view, projectors: reality.projectors }; },
      /** Per camera: { id, level, feed, kind: 'sim'|'image'|null, ready, projecting }. */
      feeds: () => reality.feeds(),
      get busy() { return tweens.busy || !!raf; },
      renderNow() { stateDirty = true; if (raf) cancelAnimationFrame(raf); raf = 0; frame(performance.now()); },
      /** Run the animations forward by ms without waiting for frames (hidden tabs, tests, screenshots). */
      advance(ms = 5000) {
        // two passes: a figure changing rooms fades out, is moved by applyState, then fades in
        for (let pass = 0; pass < 2; pass++) {
          for (let t = 0; t < ms; t += 50) { tweens.step(50); rig.update(0.05); }
          applyState();
        }
        reality.tick();                              // a fresh frame from every simulated camera
        stateDirty = true; shadowDirty = true; idle = true;
        if (raf) cancelAnimationFrame(raf); raf = 0; frame(performance.now());
      },
      three: { gl, scene, camera, sun, hemi, rig, house, G, reality },
      pick,
    },
  };
}
