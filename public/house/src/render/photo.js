// The "photographed" look for simulated camera feeds (CONTRACTS, Round 3). The simulator has no real cameras,
// so a feed is the same house drawn from the lens with everything the maquette deliberately leaves out:
// surface textures (generated here, nothing is downloaded), sun and house shadow or lamplight, a sky, and then
// a small sensor's faults (soft lens, vignette, grain). It must look unlike the clay, so that a projected
// patch reads as a picture.
//
// One ShaderMaterial draws every surface. It reuses the storey's baked lookups from lightmap.js: the distance
// field (contact shade, and "am I outdoors, is the house between me and the sun") and the lamp visibility
// atlas (which lamps reach this point), so the picture's light agrees with the model's.

import * as THREE from 'three';
import { MassBuilder } from './builder.js';
import { FIELD_OUT_RANGE, LAMP_TILE } from './lightmap.js';

/** Slots beyond the clay palette, used only by geometry that exists only in the photo scene. */
export const PHOTO = { fence: 30, sky: 31, skin: 40, hair: 41, shirt: 42, trousers: 43, shoes: 44, screen: 45 };
export const MAX_SIM_PEOPLE = 8;

/** Floor finish by room type: 0 timber, 1 carpet, 2 tile, 3 concrete. */
export function floorKind(type) {
  const t = String(type || '').toLowerCase();
  if (/garage|workshop|utility|store/.test(t)) return 3;
  if (/bath|laundry|powder|shower|wc|toilet/.test(t)) return 2;
  if (/kitchen|dining|entry|foyer|hall|stair/.test(t)) return 0;
  return 1;
}

const VERT = /* glsl */`
attribute vec4 aInfo;
varying vec4 vInfo;
varying vec3 vWPos;
varying vec3 vWNormal;
uniform float uWalk;
uniform float uSwing;
void main() {
  vec3 p = position;
  #ifdef HV_PERSON
    // a walking figure: legs and arms swing about the hip and the shoulder (aInfo.w: +-1 leg, +-2 arm)
    float side = aInfo.w;
    if (abs(side) > 0.5) {
      float leg = step(abs(side), 1.5);
      float pivot = mix(1.42, 0.92, leg);
      p.z += sign(side) * (leg * 2.0 - 1.0) * sin(uWalk) * uSwing * (pivot - p.y);
    }
  #endif
  vInfo = aInfo;
  vec4 w = modelMatrix * vec4(p, 1.0);
  vWPos = w.xyz;
  vWNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const FRAG = /* glsl */`
varying vec4 vInfo;
varying vec3 vWPos;
varying vec3 vWNormal;
uniform sampler2D uOcc;
uniform vec4 uOccXf;
uniform sampler2D uAtlas;
uniform float uGrid;
uniform vec4 uLA[HV_LIGHTS];
uniform vec4 uLB[HV_LIGHTS];
uniform vec4 uLC[HV_LIGHTS];
uniform vec4 uLP[HV_LIGHTS];
uniform float uRoomKind[HV_ROOMS];
uniform vec4 uPeople[${MAX_SIM_PEOPLE}];      // x, feet y, z, 1 when standing there
uniform float uElev;
uniform float uTop;                           // world height of the top of the house mass, for its shadow
uniform float uDay;                           // 0 night, 1 day
uniform vec3 uSunDir;
uniform float uTime;
uniform float uKind;                          // 0 building, 1 door leaf, 2 garage door, 3 car, 4 person, 5 backdrop
uniform vec3 uPaint;
uniform vec3 uPaint2;
uniform float uExpo;                          // this camera's exposure (an outdoor lens stops down for the sun)

float px = 0.01;                              // metres per pixel here

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
// 1 while a feature of this size (metres) is resolved, 0 before it would turn into shimmer
float keep(float size) { return clamp(size / (px * 2.0) - 0.25, 0.0, 1.0); }

// boards running along p.x, each w wide and about len long, with staggered ends
vec3 planks(vec2 p, vec3 base, float w, float len, float gapDark) {
  float row = floor(p.y / w);
  float xi = (p.x + hash21(vec2(row, 3.7)) * len) / len;
  vec2 id = vec2(floor(xi), row);
  float grain = fbm(vec2(p.x * 2.2, p.y * 30.0) + id * 7.3);
  vec3 c = base * (0.8 + 0.34 * hash21(id)) * mix(1.0, 0.8 + 0.4 * grain, keep(0.03));
  float ey = (0.5 - abs(fract(p.y / w) - 0.5)) * w;
  float ex = (0.5 - abs(fract(xi) - 0.5)) * len;
  float gw = max(0.005, px * 0.8);
  float gap = 1.0 - smoothstep(0.0, gw, min(ey, ex));
  return c * (1.0 - gapDark * gap * clamp(0.014 / gw, 0.0, 1.0));
}
// 1 on the joint lines of a square grid
float joints(vec2 p, float size, float width) {
  vec2 e = (0.5 - abs(fract(p / size) - 0.5)) * size;
  float gw = max(width, px * 0.8);
  return (1.0 - smoothstep(0.0, gw, min(e.x, e.y))) * clamp(width * 2.2 / gw, 0.0, 1.0);
}
vec3 concrete(vec2 p, vec3 base) {
  vec3 c = base * (0.74 + 0.44 * fbm(p * 0.8)) * (0.9 + 0.18 * fbm(p * 4.0 + 9.0));
  c *= mix(1.0, 0.9 + 0.2 * vnoise(p * 70.0), keep(0.014));
  return c * (1.0 - 0.24 * smoothstep(0.58, 0.8, fbm(p * 0.5 + 31.0)));      // old stains
}
vec3 skyColor(vec3 d) {
  float up = clamp(d.y, 0.0, 1.0);
  vec3 day = mix(vec3(0.78, 0.85, 0.93), vec3(0.24, 0.46, 0.84), pow(up, 0.5));
  float cloud = smoothstep(0.48, 0.78, fbm(d.xz / (abs(d.y) + 0.18) * 1.3 + 4.0));
  day = mix(day, vec3(0.97, 0.97, 0.96), cloud * 0.7 * smoothstep(0.0, 0.25, up));
  vec3 night = mix(vec3(0.045, 0.05, 0.075), vec3(0.006, 0.01, 0.025), pow(up, 0.5));
  return mix(night, day * 1.25, uDay);
}
// 1 in the sun, 0 where the house stands between this point and the sun
float sunShadow(vec3 p) {
  vec2 d = normalize(uSunDir.xz);
  float tanE = uSunDir.y / max(length(uSunDir.xz), 1e-3);
  float tMax = max(0.0, (uTop - p.y) / tanE);
  float s = 1.0;
  for (int i = 0; i < 14; i++) {
    float t = tMax * (float(i) + 0.5) / 14.0;
    float b = textureLod(uOcc, (p.xz + d * t - uOccXf.xy) * uOccXf.zw, 0.0).b * ${FIELD_OUT_RANGE.toFixed(2)};
    s = min(s, smoothstep(0.0, 0.08 + 0.16 * t, b));
  }
  return s;
}
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }

void main() {
  int slot = int(vInfo.x + 0.5);
  vec3 N = normalize(vWNormal);
  if (!gl_FrontFacing) N = -N;
  vec3 toEye = cameraPosition - vWPos;
  float dist = length(toEye);
  vec3 V = toEye / dist;
  vec3 fw = fwidth(vWPos);
  px = length(fw) + 1e-5;

  if (slot == ${PHOTO.sky}) {
    gl_FragColor = vec4(pow(aces(skyColor(-V) * mix(0.7, 0.8, uDay) * uExpo), vec3(1.0 / 2.2)), 1.0);
    return;
  }

  float h = vWPos.y - uElev;
  float up = N.y;
  float vertical = step(abs(up), 0.4);
  vec2 fp = vWPos.xz;
  vec2 wp = vec2(dot(vWPos.xz, vec2(-N.z, N.x)), vWPos.y);
  vec2 tp = vertical > 0.5 ? wp : fp;

  vec2 probe = vWPos.xz + N.xz * 0.16 * vertical;
  vec4 occ = texture2D(uOcc, (probe - uOccXf.xy) * uOccXf.zw);
  float outside = uKind > 4.5 ? 1.0 : smoothstep(0.0, 0.02, occ.b);

  vec3 alb = vec3(0.5);
  vec3 emit = vec3(0.0);
  float gloss = 0.0;

  if (slot == 0) {
    float kind = uRoomKind[int(vInfo.y + 0.5)];
    if (kind < 0.5) { alb = planks(fp, vec3(0.5, 0.33, 0.19), 0.13, 1.4, 0.5); gloss = 0.22; }
    else if (kind < 1.5) {
      alb = vec3(0.55, 0.51, 0.46) * (0.9 + 0.16 * fbm(fp * 1.1)) * mix(1.0, 0.84 + 0.32 * vnoise(fp * 85.0), keep(0.012));
    } else if (kind < 2.5) {
      vec2 id = floor(fp / 0.45);
      alb = vec3(0.74, 0.73, 0.7) * (0.92 + 0.12 * hash21(id)) * (0.95 + 0.08 * fbm(fp * 3.0));
      alb = mix(alb, vec3(0.4, 0.39, 0.37), joints(fp, 0.45, 0.006));
      gloss = 0.3;
    } else {
      alb = concrete(fp, vec3(0.5, 0.49, 0.47));
      alb *= 1.0 - 0.3 * joints(fp, 3.05, 0.012);
    }
  } else if (slot == 1 || slot == 2) {
    if (outside > 0.5) {
      // lap siding over a concrete footing
      float f = fract(h / 0.2);
      alb = vec3(0.7, 0.66, 0.59) * (0.84 + 0.16 * f) * (1.0 - 0.4 * (1.0 - smoothstep(0.0, 0.1, f)) * keep(0.03));
      alb *= 0.93 + 0.12 * fbm(wp * vec2(3.0, 14.0));
      if (h < 0.22) alb = concrete(wp, vec3(0.5, 0.49, 0.47));
    } else {
      alb = vec3(0.84, 0.82, 0.77) * (0.95 + 0.07 * fbm(wp * 1.7));
      if (h < 0.1) alb = vec3(0.9, 0.89, 0.86);                                   // skirting board
      alb *= 1.0 - 0.3 * (1.0 - smoothstep(0.0, 0.012, abs(h - 0.1))) * keep(0.012);
    }
  } else if (slot == 3) {
    float pick = hash21(vec2(vInfo.y, 5.1));
    vec3 cloth = pick < 0.34 ? vec3(0.27, 0.33, 0.42) : pick < 0.67 ? vec3(0.47, 0.39, 0.3) : vec3(0.34, 0.38, 0.31);
    alb = cloth * (0.9 + 0.16 * fbm(tp * 2.5)) * mix(1.0, 0.86 + 0.28 * vnoise(tp * 120.0), keep(0.01));
  } else if (slot == 6) { alb = vec3(0.045, 0.047, 0.052); gloss = 0.5; }
  else if (slot == 7) { alb = vec3(0.8, 0.78, 0.73) * (0.94 + 0.08 * fbm(tp * 2.0)); gloss = 0.12; }
  else if (slot == 4) { alb = concrete(fp, vec3(0.37, 0.355, 0.33)); alb *= 1.0 - 0.34 * joints(fp, 0.6, 0.008); }
  else if (slot == 5 || slot == 12) {
    alb = vec3(0.88, 0.86, 0.82) * (0.96 + 0.05 * fbm(wp * 3.0));
    if (uKind > 1.5 && uKind < 2.5) alb *= 1.0 - 0.3 * (1.0 - smoothstep(0.0, 0.03, abs(fract(vWPos.y / 0.53) - 0.5) * 0.53 - 0.24));
  }
  else if (slot == 8) { alb = uPaint; gloss = 0.9; }
  else if (slot == 9) { alb = vec3(0.02, 0.025, 0.03); gloss = 1.0; }
  else if (slot == 10) { alb = vec3(0.03); }
  else if (slot == 11) {
    float d = abs(fract((fp.x + fp.y) * 1.6) - 0.5) + abs(fract((fp.x - fp.y) * 1.6) - 0.5);
    float aa = max(0.03, px * 5.0);
    alb = mix(vec3(0.4, 0.12, 0.1), vec3(0.72, 0.63, 0.48), smoothstep(0.44 - aa, 0.44 + aa, d));
    alb = mix(alb, vec3(0.11, 0.15, 0.27), 1.0 - smoothstep(0.16 - aa, 0.16 + aa, d));
    alb *= mix(1.0, 0.86 + 0.28 * vnoise(fp * 110.0), keep(0.01));
  }
  else if (slot == 13) { alb = vec3(0.86, 0.85, 0.83); }
  else if (slot == 14) { alb = vec3(0.85) * (0.85 + 0.15 * step(0.3, fract(vWPos.y / 0.075))); }
  else if (slot == 15) {
    vec3 g = mix(vec3(0.06, 0.095, 0.035), vec3(0.14, 0.18, 0.075), fbm(fp * 0.55));
    g = mix(g, vec3(0.22, 0.2, 0.1), 0.5 * smoothstep(0.52, 0.8, fbm(fp * 0.21 + 3.0)));        // dry patches
    g *= 0.84 + 0.32 * fbm(fp * 2.6 + 7.0);
    g *= mix(1.0, 0.78 + 0.44 * vnoise(fp * vec2(60.0, 75.0)), keep(0.015));
    alb = g * (0.95 + 0.05 * sin(fp.x * 3.5));                                                  // mower stripes
  }
  else if (slot == 16) {
    vec2 q = fp * 2.6;
    float w1 = sin(q.x * 1.9 + sin(q.y * 2.3 + uTime * 0.9) * 1.4 + uTime * 0.6);
    float w2 = sin(q.y * 2.1 + sin(q.x * 1.7 - uTime * 0.7) * 1.3 - uTime * 0.5);
    float ridge = pow(1.0 - abs(w1), 4.0) + pow(1.0 - abs(w2), 4.0);
    alb = vec3(0.09, 0.3, 0.4) + vec3(0.2, 0.28, 0.27) * ridge * 0.4 * mix(0.3, 1.0, uDay);
    N = normalize(N + vec3(w1, 0.0, w2) * 0.05);
    gloss = 0.8;
  }
  else if (slot == 17) { alb = planks(vInfo.w > 0.5 ? fp.yx : fp, vec3(0.42, 0.27, 0.17), 0.14, 2.4, 0.6); }
  else if (slot == 18) { alb = concrete(fp, vec3(0.33, 0.32, 0.3)); alb *= 1.0 - 0.36 * joints(fp, 1.525, 0.012); }
  else if (slot == 20) { alb = vec3(0.85, 0.85, 0.84); gloss = 0.2; }
  else if (slot == 21) { alb = vec3(0.72, 0.69, 0.64) * (0.9 + 0.14 * fbm(fp * 6.0)); }
  else if (slot == ${PHOTO.fence}) { alb = planks(vec2(wp.y, wp.x), vec3(0.4, 0.3, 0.21), 0.14, 6.0, 0.6); }
  else if (slot == ${PHOTO.skin}) { alb = vec3(0.72, 0.52, 0.4); }
  else if (slot == ${PHOTO.hair}) { alb = vec3(0.09, 0.065, 0.045); }
  else if (slot == ${PHOTO.shirt}) { alb = uPaint * (0.9 + 0.2 * fbm(vWPos.xy * 9.0)); }
  else if (slot == ${PHOTO.trousers}) { alb = uPaint2 * (0.9 + 0.2 * fbm(vWPos.xy * 9.0)); }
  else if (slot == ${PHOTO.shoes}) { alb = vec3(0.05); }
  else if (slot == ${PHOTO.screen}) {
    alb = vec3(0.02);
    gloss = 0.5;
    vec3 show = vInfo.y < 0.5
      ? vec3(0.3 + 0.25 * sin(uTime * 1.3 + tp.x * 3.0), 0.42 + 0.22 * sin(uTime * 0.9 + tp.y * 4.0), 0.62 + 0.25 * sin(uTime * 1.7 + tp.x)) * 1.6
      : vec3(1.0, 0.62, 0.25);
    emit = show * vInfo.w;
  }

  // ---- light ----------------------------------------------------------------------------------------
  float floorish = step(0.6, up) * step(h, 0.06);
  float nearWall = 1.0 - occ.r, nearFurn = 1.0 - occ.g;
  float ao = vInfo.z * (1.0 - floorish * (1.0 - outside * 0.6) * (0.42 * nearWall * nearWall + 0.34 * nearFurn * nearFurn));
  if (floorish > 0.5 || slot == 15) {
    // people stand on a soft contact shadow
    for (int i = 0; i < ${MAX_SIM_PEOPLE}; i++) {
      vec4 P = uPeople[i];
      if (P.w < 0.5 || abs(P.y - vWPos.y) > 0.2) continue;
      vec2 dp = vWPos.xz - P.xz;
      ao *= 1.0 - 0.5 * exp(-dot(dp, dp) / 0.06);
    }
  }

  vec3 sunCol = vec3(1.0, 0.93, 0.82) * 2.4;
  float ndl = max(dot(N, uSunDir), 0.0);
  float sh = 1.0;
  if (outside > 0.01 && uDay > 0.01) sh = sunShadow(vec3(probe.x, vWPos.y, probe.y));
  vec3 skyAmb = vec3(0.56, 0.66, 0.86) * 1.15 * (0.55 + 0.45 * up);
  vec3 moon = vec3(0.11, 0.13, 0.19) * 0.9 * (0.6 + 0.4 * up);
  vec3 outdoor = uDay * (sunCol * ndl * sh + skyAmb * (0.82 + 0.18 * sh)) + (1.0 - uDay) * moon;
  vec3 indoor = uDay * vec3(0.9, 0.9, 0.93) * 0.6 * (0.74 + 0.26 * up) + (1.0 - uDay) * vec3(0.03, 0.035, 0.05);
  vec3 light = mix(indoor, outdoor, outside) * ao;

  #ifdef HV_LAMPS
  {
    vec2 lp = vWPos.xz + N.xz * 0.09 * vertical;
    float halfTexel = 1.5 / ${LAMP_TILE.toFixed(1)};
    for (int i = 0; i < HV_LIGHTS; i++) {
      vec4 C = uLC[i];
      if (C.a < 0.003) continue;
      vec4 A = uLA[i];
      vec4 B = uLB[i];
      vec2 dv = lp - A.xy;
      vec2 rel = dv / B.x;
      if (max(abs(rel.x), abs(rel.y)) >= 1.0) continue;
      vec2 cell = vec2(mod(B.z, uGrid), floor(B.z / uGrid + 0.001));
      vec4 t = textureLod(uAtlas, (cell + clamp(rel * 0.5 + 0.5, halfTexel, 1.0 - halfTexel)) / uGrid, 0.0);
      float vis = min(1.0, t.r + dot(t.gba, uLP[i].xyz));
      float lh = B.y > 1.0 ? 2.4 : (B.y > 0.7 ? 1.3 : 0.95);                 // ceiling or wall light, lamp, strip
      vec3 L = vec3(A.x, uElev + lh, A.y) - vWPos;
      float d2 = dot(L, L);
      float nl = max(dot(N, L * inversesqrt(d2 + 1e-4)), 0.0);
      float att = (1.0 / (1.0 + d2 / 2.2)) * (1.0 - smoothstep(0.72, 1.0, length(rel)));
      light += mix(C.rgb, vec3(1.0, 0.86, 0.68), 0.6) * C.a * B.w * vis * att * (0.22 + 0.78 * nl) * 2.3 * (0.6 + 0.4 * ao);
    }
  }
  #endif

  vec3 col = alb * light + emit;

  // a little of the sky (or the room) in anything smooth, and the sun's glint outdoors
  if (gloss > 0.0) {
    vec3 Rf = reflect(-V, N);
    float fres = 0.04 + 0.96 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
    vec3 env = mix(indoor * 0.9, skyColor(Rf), outside);
    col += env * fres * gloss;
    col += sunCol * pow(max(dot(Rf, uSunDir), 0.0), 90.0) * gloss * sh * outside * uDay;
  }
  // haze toward the horizon
  col = mix(col, skyColor(vec3(-V.x, 0.02, -V.z)) * 0.9, outside * (1.0 - exp(-dist * 0.012)));

  col = aces(col * mix(1.9, 0.56, uDay) * uExpo);          // a camera lifts its gain at night
  gl_FragColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}`;

/**
 * Shared by every photo material: the time of day, the clock, and where simulated people stand.
 * @param {THREE.Vector3} sunDir unit vector toward the sun (the model's key light)
 */
export function createPhotoShared(sunDir) {
  return {
    uDay: { value: 0 },
    uSunDir: { value: sunDir.clone().normalize() },
    uTime: { value: 0 },
    uExpo: { value: 1 },
    uPeople: { value: Array.from({ length: MAX_SIM_PEOPLE }, () => new THREE.Vector4()) },
  };
}

/**
 * @param L a storey handle from scene.js (its baked lookups and lamp uniforms are shared, not copied)
 * @param shared from createPhotoShared
 * @param o { kind, paint, paint2, person, side, top }
 */
export function createPhotoMaterial(L, shared, o = {}) {
  const S = L.S;
  const defines = { HV_LIGHTS: Math.max(1, L.lampSlots | 0), HV_ROOMS: Math.max(1, L.rooms.length) };
  if ((L.lampSlots | 0) > 0) defines.HV_LAMPS = '';
  if (o.person) defines.HV_PERSON = '';
  return new THREE.ShaderMaterial({
    defines,
    uniforms: {
      uOcc: S.uOcc, uOccXf: S.uOccXf, uAtlas: S.uAtlas, uGrid: S.uGrid, uLA: S.uLA, uLB: S.uLB, uLC: S.uLC, uLP: S.uLP, uElev: S.uElev,
      uRoomKind: L.photoKinds, uTop: L.photoTop,
      ...shared,
      uKind: { value: o.kind || 0 },
      uPaint: { value: new THREE.Color().setRGB(...(o.paint || [0.5, 0.5, 0.5])) },
      uPaint2: { value: new THREE.Color().setRGB(...(o.paint2 || [0.2, 0.22, 0.3])) },
      uWalk: { value: 0 }, uSwing: { value: 0 },
    },
    vertexShader: VERT, fragmentShader: FRAG,
    side: o.side ?? THREE.FrontSide,
  });
}

const QUAD_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/** The sensor: turns the clean render into a small camera's frame (soft, fringed, vignetted, grainy). */
export function createSensorMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2(1 / 480, 1 / 270) }, uSeed: { value: 0 }, uNight: { value: 0 } },
    vertexShader: QUAD_VERT,
    fragmentShader: /* glsl */`
      uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uSeed; uniform float uNight;
      varying vec2 vUv;
      float hash21(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }
      void main() {
        vec2 c = vUv - 0.5;
        float r2 = dot(c, c * vec2(1.0, 0.72));
        float blur = 0.55 + 2.2 * r2;                                  // softer toward the corners
        vec3 col = texture2D(tSrc, vUv).rgb * 0.4;
        col += texture2D(tSrc, vUv + vec2(uTexel.x, 0.0) * blur).rgb * 0.15;
        col += texture2D(tSrc, vUv - vec2(uTexel.x, 0.0) * blur).rgb * 0.15;
        col += texture2D(tSrc, vUv + vec2(0.0, uTexel.y) * blur).rgb * 0.15;
        col += texture2D(tSrc, vUv - vec2(0.0, uTexel.y) * blur).rgb * 0.15;
        col.r = mix(col.r, texture2D(tSrc, vUv + c * 0.007).r, 0.6);     // colour fringing
        col.b = mix(col.b, texture2D(tSrc, vUv - c * 0.007).b, 0.6);
        float l = dot(col, vec3(0.299, 0.587, 0.114));
        col = mix(vec3(l), col, mix(1.02, 0.62, uNight));              // punchy by day, washed out by night
        col = (col - 0.5) * 1.06 + 0.5;
        col = col * 0.965 + 0.02;                                      // blacks never reach black
        col *= 1.0 - 0.52 * smoothstep(0.07, 0.42, r2);                // vignette
        vec2 p = floor(vUv / uTexel);
        float n = hash21(p + uSeed * 61.7) - 0.5;
        vec3 nc = vec3(hash21(p + uSeed * 13.1 + 7.0), hash21(p + uSeed * 29.3 + 19.0), hash21(p + uSeed * 47.9 + 31.0)) - 0.5;
        float amp = mix(0.03, 0.06, uNight) * (1.1 - 0.5 * l);
        col += n * amp + nc * amp * 0.35;
        gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
      }`,
    depthTest: false, depthWrite: false,
  });
}

/** Copies a picture (a real camera still) into its tile unchanged. */
export function createCopyMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { tSrc: { value: null } },
    vertexShader: QUAD_VERT,
    fragmentShader: /* glsl */`
      uniform sampler2D tSrc;
      varying vec2 vUv;
      void main() { gl_FragColor = vec4(texture2D(tSrc, vUv).rgb, 1.0); }`,
    depthTest: false, depthWrite: false,
  });
}

/** A person as a camera would see one: clothes, skin, hair. About 1.74 m, facing local +Z. */
export function buildPersonGeometry() {
  const b = new MassBuilder();
  b.baseAO = 1;
  const P = PHOTO;
  for (const s of [-1, 1]) {
    b.cyl(s * 0.09, 0, 0.5, 0.078, 0.86, 'z', { mat: P.trousers, flag: s, segments: 8 });
    b.box(s * 0.09 - 0.06, s * 0.09 + 0.06, -0.08, 0.17, 0, 0.08, { mat: P.shoes, flag: s, bottom: true });
    b.cyl(s * 0.262, 0, 1.13, 0.052, 0.6, 'z', { mat: P.shirt, flag: s * 2, segments: 8 });
    b.cyl(s * 0.262, 0, 0.79, 0.046, 0.1, 'z', { mat: P.skin, flag: s * 2, segments: 8 });
  }
  b.box(-0.205, 0.205, -0.118, 0.118, 0.88, 1.47, { mat: P.shirt, bevel: 0.05, bottom: true });
  b.cyl(0, 0, 1.5, 0.055, 0.1, 'z', { mat: P.skin, segments: 8 });
  const N = 10, hr = 0.108, hz = 1.64;
  const ring = (r, z) => Array.from({ length: N }, (_, i) => { const a = (i / N) * Math.PI * 2; return [Math.cos(a) * r, Math.sin(a) * r, z]; });
  const lat = [-1.2, -0.6, -0.1, 0.4, 0.85, 1.3];
  for (let i = 0; i < lat.length - 1; i++) {
    const mid = (lat[i] + lat[i + 1]) / 2;
    b.loft(ring(hr * Math.cos(lat[i]), hz + hr * Math.sin(lat[i])), ring(hr * Math.cos(lat[i + 1]), hz + hr * Math.sin(lat[i + 1])),
      { mat: lat[i] >= 0.35 ? P.hair : P.skin, top: i === lat.length - 2, hintZ: hr * Math.cos(mid) * Math.tan(mid) });
  }
  return b.toGeometry('body');
}
