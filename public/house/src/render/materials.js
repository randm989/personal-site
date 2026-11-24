// Materials. One "clay" material (a patched MeshStandardMaterial, or MeshLambertMaterial on the low tier)
// draws all architecture and furniture: the colour comes from a palette uniform indexed by a vertex
// attribute, occlusion from a baked distance field, and lamplight from per-fixture visibility maps
// (see lightmap.js). The rest are small unlit shader materials: fixtures, glow halos, glass, lines.

import * as THREE from 'three';
import { MAT_COUNT } from './builder.js';
import { FIELD_WALL_RANGE } from './lightmap.js';

/** Uniforms shared by every material in the scene. */
export function createGlobalUniforms() {
  return {
    uPal: { value: Array.from({ length: MAT_COUNT }, () => new THREE.Color()) },
    uLamp: { value: new THREE.Vector4(0.8, 0.5, 0.5, 0) },        // max mix on floor, wall, furniture; whiten
    uLampGain: { value: 1 },
    uAlert: { value: new THREE.Vector4(1, 0, 0, 0.3) },
    uHaloCol: { value: new THREE.Vector4(1, 1, 1, 0.2) },
    uHatchCol: { value: new THREE.Color() },
    uContact: { value: new THREE.Vector4(0, 0, 0, 0.5) },
    uSubdueCol: { value: new THREE.Color() },
    uSubdueMix: { value: 0.5 },
    uPx: { value: 1 },                                           // device pixels per CSS pixel
    uGroundFade: { value: new THREE.Vector4(0, 0, 10, 20) },      // centre x, z; fade start, fade end (in ellipse radii)
    uGroundScale: { value: new THREE.Vector2(1, 1) },             // 1 / ellipse semi-axes (x, z), so a long plot gets a long ground
    uResolution: { value: new THREE.Vector2(1, 1) },              // drawing buffer size
    uGlass: { value: new THREE.Vector4(0.6, 0.8, 1, 0.22) },
    uAccent: { value: new THREE.Color() },
    uFixtureOff: { value: new THREE.Color() },
    uHaloGain: { value: 0.5 },
    // Reality view (round 3): up to PROJECTORS cameras lay their picture onto the clay. See reality.js.
    uRV: { value: 0 },                                           // 0 = nothing projects (skips the loop)
    uProjM: { value: Array.from({ length: PROJECTORS }, () => new THREE.Matrix4()) },   // world -> the lens's clip space
    uProjP: { value: Array.from({ length: PROJECTORS }, () => new THREE.Vector4()) },   // lens x, y, z; elevation of its storey
    uProjR: { value: Array.from({ length: PROJECTORS }, () => new THREE.Vector4()) },   // fade start (m), fade end (m), strength 0..1, depth bias per metre
    uProjZ: { value: new THREE.Vector4(0.1, 40, 1 / 1536, 1 / 576) },                   // lens near, far; depth atlas texel
    uFeedTex: { value: null },                                   // the pictures, one tile per projector (display-ready sRGB)
    uFeedDepth: { value: null },                                 // what each lens can see, same tiles
  };
}

/** Uniforms shared by everything on one storey. `lights` and `rooms` are array lengths (at least 1). */
export function createLevelUniforms(lights, rooms) {
  const vecs = (n) => Array.from({ length: Math.max(1, n) }, () => new THREE.Vector4());
  return {
    uOcc: { value: null },
    uOccXf: { value: new THREE.Vector4(0, 0, 1, 1) },             // origin x, z; 1/width, 1/height (metres)
    uAtlas: { value: null },
    uGrid: { value: 1 },
    uLA: { value: vecs(lights) },                                  // x, z, half-axis x, z
    uLB: { value: vecs(lights) },                                  // reach, falloff height, tile, gain
    uLC: { value: vecs(lights) },                                  // linear rgb, intensity
    uLP: { value: vecs(lights) },                                  // openness of the lamp's three portal doors
    uRoomA: { value: vecs(rooms) },                                // alert, presence halo, -, -
    uRoomC: { value: vecs(rooms) },                                // centroid x, z; halo radius
    uOpacity: { value: 1 },
    uSubdue: { value: 0 },
    uElev: { value: 0 },
    uLampScale: { value: 1 },
  };
}


/** How many camera pictures can be laid onto the model at once; their tiles sit in a COLS x ROWS atlas. */
export const PROJECTORS = 6;
export const PROJ_COLS = 3, PROJ_ROWS = 2;

// Reality view. Runs after tone mapping and output encoding, because a camera picture is already display-ready.
// For each projector: inside its frustum, in front of whatever its lens sees first (the depth tile), fading
// out with distance, at grazing angles and toward the edge of the frame, so a picture never ends in a hard
// rectangle and never smears along a far surface.
const FRAG_PROJ = /* glsl */`
if (uRV > 0.001 && abs(vInfo.x - 2.0) > 0.5) {
  vec3 pAcc = vec3(0.0);
  float pW = 0.0, pKeep = 1.0;
  vec3 pN = normalize(vWNormal);
  #ifdef HV_PROJ_FLOORS
    float pSurface = step(0.6, pN.y);
  #else
    float pSurface = 1.0;
  #endif
  for (int i = 0; i < ${'PROJ_N'}; i++) {
    vec4 R = uProjR[i];
    if (R.z < 0.004 || pSurface < 0.5) continue;
    vec4 P = uProjP[i];
    if (abs(P.w - uElev) > 0.01) continue;
    vec3 toLens = P.xyz - vWPos;
    float dist = length(toLens);
    if (dist >= R.y) continue;
    vec4 c = uProjM[i] * vec4(vWPos, 1.0);
    if (c.w < 0.12) continue;
    vec2 ndc = c.xy / c.w;
    vec2 q = abs(ndc);
    if (max(q.x, q.y) >= 1.0) continue;
    // a rounded, feathered frame edge
    vec2 fe = max(q - 0.66, 0.0) / 0.34;
    float edge = 1.0 - smoothstep(0.0, 1.0, length(fe));
    edge *= edge;
    float ndl = dot(pN, toLens / dist);
    float graze = smoothstep(0.03, 0.24, ndl);
    float reach = 1.0 - smoothstep(R.x, R.y, dist);
    float a = edge * graze * reach * R.z;
    if (a < 0.004) continue;
    vec2 tile = vec2(mod(float(i), ${'PROJ_COLS'}.0), floor(float(i) / ${'PROJ_COLS'}.0));
    vec2 auv = (tile + clamp(ndc * 0.5 + 0.5, 0.003, 0.997)) / vec2(${'PROJ_COLS'}.0, ${'PROJ_ROWS'}.0);
    // what the lens sees first along this ray; a few taps soften the edge of a wall's shadow
    float bias = 0.035 + R.w * c.w / max(ndl, 0.12);
    float vis = 0.0;
    #ifdef HV_PROJ_FLOORS
      float zb = textureLod(uFeedDepth, auv, 0.0).r;
      vis = step(c.w, (2.0 * uProjZ.x * uProjZ.y) / (uProjZ.y + uProjZ.x - (zb * 2.0 - 1.0) * (uProjZ.y - uProjZ.x)) + bias);
    #else
      for (int k = 0; k < 5; k++) {
        vec2 o = k == 0 ? vec2(0.0) : vec2(k == 1 || k == 2 ? -1.0 : 1.0, k == 1 || k == 3 ? -1.0 : 1.0);
        float zb = textureLod(uFeedDepth, auv + o * uProjZ.zw, 0.0).r;
        float lin = (2.0 * uProjZ.x * uProjZ.y) / (uProjZ.y + uProjZ.x - (zb * 2.0 - 1.0) * (uProjZ.y - uProjZ.x));
        vis += step(c.w, lin + bias) * (k == 0 ? 0.4 : 0.15);
      }
    #endif
    a *= vis;
    if (a < 0.004) continue;
    pAcc += textureLod(uFeedTex, auv, 0.0).rgb * a;
    pW += a;
    pKeep *= 1.0 - a;
  }
  if (pW > 0.004) gl_FragColor.rgb = mix(gl_FragColor.rgb, pAcc / pW, (1.0 - pKeep) * uRV);
}
`.replace(/PROJ_N/g, String(PROJECTORS)).replace(/PROJ_COLS/g, String(PROJ_COLS)).replace(/PROJ_ROWS/g, String(PROJ_ROWS));

const VERT_DECL = /* glsl */`
attribute vec4 aInfo;
varying vec4 vInfo;
varying vec3 vWPos;
varying vec3 vWNormal;
`;

const VERT_BODY = /* glsl */`
vInfo = aInfo;
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWNormal = normalize(mat3(modelMatrix) * objectNormal);
`;

const FRAG_DECL = /* glsl */`
varying vec4 vInfo;
varying vec3 vWPos;
varying vec3 vWNormal;
uniform vec3 uPal[${MAT_COUNT}];
uniform vec4 uLamp;
uniform float uLampGain;
uniform vec4 uAlert;
uniform vec4 uHaloCol;
uniform vec3 uHatchCol;
uniform vec4 uContact;
uniform vec3 uSubdueCol;
uniform float uSubdueMix;
uniform float uPx;
uniform vec4 uGroundFade;
uniform vec2 uGroundScale;
uniform sampler2D uOcc;
uniform vec4 uOccXf;
uniform sampler2D uAtlas;
uniform float uGrid;
uniform vec4 uLA[HV_LIGHTS];
uniform vec4 uLB[HV_LIGHTS];
uniform vec4 uLC[HV_LIGHTS];
uniform vec4 uLP[HV_LIGHTS];
uniform vec4 uRoomA[HV_ROOMS];
uniform vec4 uRoomC[HV_ROOMS];
uniform float uOpacity;
uniform float uSubdue;
uniform float uElev;
uniform float uLampScale;
uniform float uHatch;
uniform float uPlain;
uniform vec2 uSection;
uniform float uFade;
uniform float uRV;
uniform mat4 uProjM[${PROJECTORS}];
uniform vec4 uProjP[${PROJECTORS}];
uniform vec4 uProjR[${PROJECTORS}];
uniform vec4 uProjZ;
uniform sampler2D uFeedTex;
uniform sampler2D uFeedDepth;
float hvAO = 1.0;
float hvAlert = 0.0;
float hvFloorish = 0.0;
float hvVertical = 0.0;
`;

const FRAG_COLOR = /* glsl */`
{
  int slot = int(vInfo.x + 0.5);
  vec3 pal = uPal[slot];
  #ifdef HV_PLAIN
    pal = mix(pal, uPal[12], uPlain);
  #endif
  float h = vWPos.y - uElev;
  hvVertical = step(abs(vWNormal.y), 0.4);
  hvFloorish = step(0.6, vWNormal.y) * step(h, 0.06);
  hvAO = vInfo.z;
  // Baked occlusion from the plan's distance field: floors darken toward walls and furniture,
  // wall faces darken toward inside corners.
  vec2 probe = vWPos.xz + vWNormal.xz * 0.3 * hvVertical;
  vec4 occ = texture2D(uOcc, (probe - uOccXf.xy) * uOccXf.zw);
  #ifdef HV_GROUND
    float dOut = 1.0 - occ.b;
    pal = mix(pal, uContact.rgb, uContact.a * dOut * dOut * dOut);
  #else
    float nearWall = 1.0 - occ.r;
    float nearFurn = 1.0 - occ.g;
    hvAO *= 1.0 - hvFloorish * (0.46 * nearWall * nearWall + 0.24 * nearFurn * nearFurn);

    if (slot == 1) hvAO *= mix(1.0, 0.7 + 0.3 * clamp(occ.r * ${(FIELD_WALL_RANGE / 0.3).toFixed(3)}, 0.0, 1.0), hvVertical);
    #ifdef HV_ROOMSTATE
      if (hvFloorish > 0.5) {
        int room = int(vInfo.y + 0.5);
        vec4 ra = uRoomA[room];
        vec4 rc = uRoomC[room];
        pal = mix(pal, uAlert.rgb, ra.x * uAlert.a);
        hvAlert = ra.x;
        // presence / motion: a soft disc of lifted floor with a fine drawn ring, still and neutral
        float hd = length(vWPos.xz - rc.xy) / max(rc.z, 0.01);
        float hw = max(fwidth(hd), 1e-4);
        float halo = 0.2 + 0.8 * (1.0 - smoothstep(0.0, 0.96, hd));
        halo *= 1.0 - smoothstep(0.96 - hw, 0.96 + hw, hd);
        float ring = 1.0 - smoothstep(hw * 0.6, hw * 1.7, abs(hd - 0.96));
        pal = mix(pal, uHaloCol.rgb, ra.y * min(1.0, halo * uHaloCol.a + ring * uHaloCol.a * 0.9));
      }
    #endif
  #endif
  if (slot == 4 && vWNormal.y > 0.6) {
    // paving joints make an outdoor slab read as a deliberate surface
    vec2 pg = abs(fract(vWPos.xz / 0.6) - 0.5);
    float pw = max(0.03, fwidth(vWPos.x) + fwidth(vWPos.z));
    pal *= 1.0 - 0.14 * smoothstep(0.5 - pw, 0.5, max(pg.x, pg.y)) * min(1.0, 0.03 / pw * 2.0);
  }
  if (slot == 17 && vWNormal.y > 0.6) {
    // deck boards: fine parallel joints, running along the deck's long side (vInfo.w picks the axis)
    float across = vInfo.w > 0.5 ? vWPos.x : vWPos.z;
    float bw = max(1e-4, fwidth(across));
    float bg = abs(fract(across / 0.19) - 0.5) * 0.19;                      // metres from the nearest joint
    float joint = 1.0 - smoothstep(0.0, max(0.012, bw), bg);
    pal *= 1.0 - 0.2 * joint * clamp(0.05 / bw - 0.25, 0.0, 1.0);           // fades out before it can shimmer
  }
  if (slot == 18 && vWNormal.y > 0.6) {
    // driveway: large cast panels with a wide shallow joint
    vec2 dq = abs(fract(vWPos.xz / 1.525) - 0.5) * 1.525;
    float dw = max(1e-4, fwidth(vWPos.x) + fwidth(vWPos.z));
    float dj = 1.0 - smoothstep(0.0, max(0.03, dw), min(dq.x, dq.y));
    pal *= 1.0 - 0.16 * dj * clamp(0.2 / dw - 0.25, 0.0, 1.0);
  }
  #ifdef HV_SECTION
    float groove = step(fract((vWPos.y - uSection.x) / uSection.y + 0.03), 0.06);
    pal *= 1.0 - 0.3 * groove;
  #endif
  #ifdef HV_SLATS
    pal *= 0.86 + 0.14 * step(0.3, fract(vWPos.y / 0.075));
  #endif
  diffuseColor.rgb = pal * hvAO;
  diffuseColor.a *= uOpacity * uFade;
  #ifdef HV_GROUND
    float gd = length((vWPos.xz - uGroundFade.xy) * uGroundScale);
    diffuseColor.a *= 1.0 - smoothstep(uGroundFade.z, uGroundFade.w, gd);
  #endif
}
`;

const FRAG_LAMP = /* glsl */`
{
  #ifdef HV_LAMPS
  vec3 lampAcc = vec3(0.0);
  float lampW = 0.0;
  vec2 lp = vWPos.xz + vWNormal.xz * 0.09 * hvVertical;
  float halfTexel = 1.5 / ${'LAMP_TILE_PX'};
  for (int i = 0; i < HV_LIGHTS; i++) {
    vec4 C = uLC[i];
    if (C.a < 0.003) continue;
    vec4 A = uLA[i];
    vec4 B = uLB[i];
    vec2 dv = lp - A.xy;
    vec2 rel = dv / B.x;
    float edge = max(abs(rel.x), abs(rel.y));
    if (edge >= 1.0) continue;
    vec2 cell = vec2(mod(B.z, uGrid), floor(B.z / uGrid + 0.001));
    vec2 tuv = (cell + clamp(rel * 0.5 + 0.5, halfTexel, 1.0 - halfTexel)) / uGrid;
    vec4 t = textureLod(uAtlas, tuv, 0.0);
    float vis = min(1.0, t.r + dot(t.gba, uLP[i].xyz));
    float al = dot(A.zw, A.zw);
    float tt = al > 0.0 ? clamp(dot(dv, A.zw) / al, -1.0, 1.0) : 0.0;
    vec2 off = dv - A.zw * tt;
    float d2 = dot(off, off);
    float fall = (0.78 * pow(1.0 + d2 / (B.y * B.y), -1.5) + 0.22 * pow(1.0 + d2 / (B.y * B.y * 5.0), -1.5)) * (1.0 - smoothstep(0.72, 1.0, length(rel)));
    // wall faces turned toward the lamp catch more of it
    float facing = mix(1.0, 0.4 + 0.6 * clamp(dot(vWNormal.xz, -normalize(off + 1e-4)), 0.0, 1.0), hvVertical);
    float w = C.a * B.w * vis * fall * facing;
    lampAcc += C.rgb * w;
    lampW += w;
  }
  if (lampW > 0.0005) {
    vec3 glow = lampAcc / lampW;
    glow = mix(glow, vec3(1.0), uLamp.w);
    float amount = 1.0 - exp(-3.0 * lampW * uLampGain);
    float core = smoothstep(0.4, 1.0, amount);
    glow = mix(glow, mix(glow, vec3(1.0, 0.84, 0.62), 0.6), core);
    float slotf = vInfo.x;
    float limit = hvFloorish > 0.5 ? uLamp.x : (hvVertical > 0.5 ? uLamp.y : uLamp.z);
    if (abs(slotf - 2.0) < 0.5) limit = uLamp.y * 0.3;         // the cut plane stays a drawn line
    if (abs(slotf - 19.0) < 0.5) limit = uLamp.z * 0.42;       // scale figures stay model-coloured in any light
    #ifdef HV_GROUND
      limit = uLamp.x * 0.1;
      glow = mix(glow, vec3(1.0, 0.8, 0.58), 0.4);
    #endif
    float shade = hvAO * mix(1.0, 0.92, hvVertical);
    outgoingLight = mix(outgoingLight, glow * shade, amount * limit * uLampScale);
  }
  #endif
  #ifdef HV_HATCH
    float hatchLine = step(mod(gl_FragCoord.x + gl_FragCoord.y, 8.0 * uPx), 2.0 * uPx);
    outgoingLight = mix(outgoingLight, mix(outgoingLight * 0.8, uHatchCol, hatchLine * 0.7), uHatch);
  #endif
  // an alert room stays red under lamplight
  outgoingLight = mix(outgoingLight, uAlert.rgb * max(0.3, dot(outgoingLight, vec3(0.3, 0.55, 0.15)) * 1.5), hvAlert * min(1.0, uAlert.a * 2.3));
  outgoingLight = mix(outgoingLight, uSubdueCol, uSubdue * uSubdueMix);
}
`;

/**
 * @param G global uniforms, S level uniforms
 * @param o { lights, rooms, lambert, ground, hatch, plain, section, slats, roomState, transparent }
 */
export function createClayMaterial(G, S, o = {}) {
  const Base = o.lambert ? THREE.MeshLambertMaterial : THREE.MeshStandardMaterial;
  const mat = new Base(o.lambert ? {} : { roughness: 1, metalness: 0 });
  mat.color.set(0xffffff);
  const own = {
    uHatch: { value: 0 }, uPlain: { value: 0 }, uSection: { value: new THREE.Vector2(0, 0.4) }, uFade: { value: 1 },
  };
  mat.userData.u = own;
  const defines = {
    HV_LIGHTS: Math.max(1, o.lights | 0), HV_ROOMS: Math.max(1, o.rooms | 0),
  };
  if ((o.lights | 0) > 0) defines.HV_LAMPS = '';
  if (o.ground) defines.HV_GROUND = '';
  if (o.hatch) defines.HV_HATCH = '';
  if (o.plain) defines.HV_PLAIN = '';
  if (o.section) defines.HV_SECTION = '';
  if (o.slats) defines.HV_SLATS = '';
  if (o.roomState) defines.HV_ROOMSTATE = '';
  if (o.lambert) defines.HV_PROJ_FLOORS = '';      // the low tier lays pictures on floors and ground only
  mat.defines = { ...(mat.defines || {}), ...defines };
  const key = 'hv-clay:' + Object.entries(defines).map(([k, v]) => `${k}=${v}`).join(',');
  mat.customProgramCacheKey = () => key;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, G, S, own);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + VERT_DECL)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + VERT_BODY);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_DECL)
      .replace('#include <color_fragment>', FRAG_COLOR)
      .replace('#include <opaque_fragment>', FRAG_LAMP.replace('LAMP_TILE_PX', (o.tilePx || 128).toFixed(1)) + '\n#include <opaque_fragment>')
      .replace('#include <colorspace_fragment>', '#include <colorspace_fragment>\n' + FRAG_PROJ);
  };
  if (o.ground || o.transparent) { mat.transparent = true; mat.depthWrite = !o.ground; }
  return mat;
}

/** Writes depth only: lets a whole storey fade as one surface instead of showing its insides. */
export function createPrepassMaterial() {
  return new THREE.MeshBasicMaterial({ colorWrite: false });
}

const TONE = /* glsl */`
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;

/** Unlit emissive bits (light fixtures, screens): per-vertex linear rgb + visibility in `color`. */
export function createEmissiveMaterial(G, S) {
  return new THREE.ShaderMaterial({
    uniforms: { uOpacity: S.uOpacity, uSubdue: S.uSubdue, uSubdueCol: G.uSubdueCol, uSubdueMix: G.uSubdueMix, uFade: { value: 1 } },
    vertexShader: /* glsl */`
      attribute vec4 color;
      varying vec4 vColor;
      varying float vShade;
      void main() {
        vColor = color;
        vShade = 0.86 + 0.14 * normalize(mat3(modelMatrix) * normal).y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform float uOpacity; uniform float uSubdue; uniform vec3 uSubdueCol; uniform float uSubdueMix; uniform float uFade;
      varying vec4 vColor;
      varying float vShade;
      void main() {
        if (vColor.a < 0.02) discard;
        vec3 c = mix(vColor.rgb * vShade, uSubdueCol, uSubdue * uSubdueMix);
        gl_FragColor = vec4(c, vColor.a * uOpacity * uFade);
        ${TONE}
      }`,
    transparent: true,
  });
}

/** Soft additive glow around a lit fixture: a camera-facing quad per fixture, in place of a bloom pass. */
export function createHaloMaterial(G, S) {
  return new THREE.ShaderMaterial({
    uniforms: { uOpacity: S.uOpacity, uLampScale: S.uLampScale, uHaloGain: G.uHaloGain },
    vertexShader: /* glsl */`
      attribute vec4 color;
      attribute vec3 aCorner;     // x, y in -1..1, z = radius in metres
      varying vec4 vColor;
      varying vec2 vUv;
      void main() {
        vColor = color;
        vUv = aCorner.xy;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        mv.xy += aCorner.xy * aCorner.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uOpacity; uniform float uLampScale; uniform float uHaloGain;
      varying vec4 vColor;
      varying vec2 vUv;
      void main() {
        float r = length(vUv);
        if (r >= 1.0 || vColor.a < 0.004) discard;
        float f = 1.0 - r;
        float a = (f * f * 0.75 + pow(f, 6.0) * 0.6) * vColor.a * uOpacity * uLampScale * uHaloGain;
        gl_FragColor = vec4(vColor.rgb * a, a);
        ${TONE}
      }`,
    transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
}

/** Flat-tinted glass (brief §3): no reflection, no refraction. aGlass = (alpha weight, hatch amount). */
export function createGlassMaterial(G, S) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uGlass: G.uGlass, uHatchCol: G.uHatchCol, uPx: G.uPx, uOpacity: S.uOpacity, uSubdue: S.uSubdue,
      uSubdueCol: G.uSubdueCol, uSubdueMix: G.uSubdueMix,
    },
    vertexShader: /* glsl */`
      attribute vec2 aGlass;
      varying vec2 vGlass;
      void main() {
        vGlass = aGlass;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec4 uGlass; uniform vec3 uHatchCol; uniform float uPx; uniform float uOpacity;
      uniform float uSubdue; uniform vec3 uSubdueCol; uniform float uSubdueMix;
      varying vec2 vGlass;
      void main() {
        float a = min(0.9, uGlass.a * vGlass.x);
        vec3 c = uGlass.rgb;
        float line = step(mod(gl_FragCoord.x + gl_FragCoord.y, 8.0 * uPx), 2.0 * uPx) * vGlass.y;
        c = mix(c, uHatchCol, line);
        a = mix(a, 0.8, line);
        c = mix(c, uSubdueCol, uSubdue * uSubdueMix * 0.6);
        gl_FragColor = vec4(c, a * uOpacity);
        ${TONE}
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
}

/**
 * A camera's view wedge lying on the ground: a faint fill that thins with distance and a fine rim along its
 * two sides and its far arc. Per vertex: color = linear rgb + fill alpha; aW = (distance 0..1 of the range,
 * angle -1..1 across the field of view, range in metres, half field of view in radians); aS = (lost 0..1,
 * rim alpha). "Lost" (no fresh claim) swaps the fill for the hatch and dashes the rim (brief §8).
 */
export function createWedgeMaterial(G, S) {
  return new THREE.ShaderMaterial({
    uniforms: { uPx: G.uPx, uOpacity: S.uOpacity, uSubdue: S.uSubdue },
    vertexShader: /* glsl */`
      attribute vec4 color;
      attribute vec4 aW;
      attribute vec2 aS;
      varying vec4 vColor;
      varying vec4 vW;
      varying vec2 vS;
      void main() {
        vColor = color; vW = aW; vS = aS;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform float uPx; uniform float uOpacity; uniform float uSubdue;
      varying vec4 vColor;
      varying vec4 vW;
      varying vec2 vS;
      void main() {
        float r = vW.x, range = vW.z;
        float fall = 1.0 - 0.8 * smoothstep(0.25, 1.0, r);
        float side = r * range * sin(min(vW.w * (1.0 - abs(vW.y)), 1.5708));   // metres to the nearer side
        float arc = (1.0 - r) * range;
        float d = min(side, arc);
        float aa = max(fwidth(d), 1e-4);
        float rim = 1.0 - smoothstep(aa * 0.9, aa * 2.1, d);                  // about a pixel and a half wide
        float along = side < arc ? r * range : vW.y * vW.w * range;
        float dash = step(mod(along + 100.0, 0.46), 0.25);
        float lost = vS.x;
        rim *= mix(1.0, dash, lost) * vS.y * (0.55 + 0.45 * fall);
        float hatch = step(mod(gl_FragCoord.x + gl_FragCoord.y, 8.0 * uPx), 1.6 * uPx);
        float fill = vColor.a * fall * mix(1.0, hatch * 1.6, lost);
        float a = max(fill, rim) * uOpacity * (1.0 - 0.6 * uSubdue);
        if (a < 0.004) discard;
        gl_FragColor = vec4(vColor.rgb, a);
        ${TONE}
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
}

/**
 * Screen-space lines of constant pixel width (WebGL lines are 1 px and aliased). Each segment is a quad:
 * position = this end, aOther = the other end, aSide = (-1|1 across, 0|1 which end, distance along the path).
 * `color` is per-vertex rgba (a 0 hides). dash: [on, off] in metres, or null.
 */
export function createLineMaterial(G, S, o = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uResolution: G.uResolution, uPx: G.uPx, uWidth: { value: o.width ?? 2 }, uOpacity: S ? S.uOpacity : { value: 1 },
      uDash: { value: new THREE.Vector2(o.dash ? o.dash[0] : 1, o.dash ? o.dash[1] : 0) },
      uTint: { value: o.color || new THREE.Color(1, 1, 1) },
      uFade: { value: 1 },
    },
    vertexShader: /* glsl */`
      uniform vec2 uResolution; uniform float uPx; uniform float uWidth;
      attribute vec3 aOther;
      attribute vec3 aSide;
      attribute vec4 color;
      varying vec4 vColor;
      varying float vDist;
      varying float vAcross;
      void main() {
        vColor = color;
        vDist = aSide.z;
        vAcross = aSide.x;
        vec4 a = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        vec4 b = projectionMatrix * modelViewMatrix * vec4(aOther, 1.0);
        vec2 sa = a.xy / a.w * uResolution;
        vec2 sb = b.xy / b.w * uResolution;
        vec2 dir = sb - sa;
        float len = length(dir);
        dir = len > 1e-5 ? dir / len : vec2(1.0, 0.0);
        if (aSide.y > 0.5) dir = -dir;
        vec2 nrm = vec2(-dir.y, dir.x);
        float w = (uWidth + 1.0) * uPx;      // one extra pixel for the soft edge
        a.xy += nrm * aSide.x * w / uResolution * a.w;
        gl_Position = a;
      }`,
    fragmentShader: /* glsl */`
      uniform vec2 uDash; uniform vec3 uTint; uniform float uOpacity; uniform float uWidth; uniform float uFade;
      varying vec4 vColor;
      varying float vDist;
      varying float vAcross;
      void main() {
        if (vColor.a < 0.01) discard;
        if (uDash.y > 0.0 && mod(vDist, uDash.x + uDash.y) > uDash.x) discard;
        float edge = 1.0 - smoothstep(uWidth / (uWidth + 1.0) - 0.15, 1.0, abs(vAcross));
        gl_FragColor = vec4(vColor.rgb * uTint, vColor.a * uOpacity * uFade * edge);
        ${TONE}
      }`,
    transparent: true, depthWrite: false, depthTest: o.depthTest !== false, side: THREE.DoubleSide,
  });
}

/** Build the quad geometry for createLineMaterial from a list of paths ([[x,y,z], ...], closed?). */
export function buildLineGeometry(paths) {
  const pos = [], other = [], side = [], col = [], idx = [];
  const ranges = [];
  for (const { points, closed, rgba = [1, 1, 1, 1] } of paths) {
    const start = pos.length / 3;
    let dist = 0;
    const n = points.length, segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = points[i], b = points[(i + 1) % n];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const base = pos.length / 3;
      pos.push(...a, ...a, ...b, ...b);
      other.push(...b, ...b, ...a, ...a);
      side.push(-1, 0, dist, 1, 0, dist, 1, 1, dist + len, -1, 1, dist + len);
      for (let k = 0; k < 4; k++) col.push(...rgba);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      dist += len;
    }
    ranges.push([start, pos.length / 3]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aOther', new THREE.Float32BufferAttribute(other, 3));
  g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.setIndex(idx);
  g.computeBoundingSphere();
  g.userData.ranges = ranges;
  return g;
}

/** Selection rim, drawn in two steps without post-processing: the object is stamped into the stencil buffer,
 * then redrawn shifted a few pixels in eight screen directions wherever the stamp is absent. The result is an
 * even outline of the whole silhouette that also shows through walls.
 */
export function createHullMaterials(G) {
  const mask = new THREE.MeshBasicMaterial({
    colorWrite: false, depthWrite: false, depthTest: false, transparent: true, side: THREE.DoubleSide,
    stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp,
    stencilZFail: THREE.ReplaceStencilOp,
  });
  const rims = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    rims.push(new THREE.ShaderMaterial({
      uniforms: { uResolution: G.uResolution, uPx: G.uPx, uAccent: G.uAccent, uWidth: { value: 2.2 }, uOffset: { value: new THREE.Vector2(Math.cos(a), Math.sin(a)) } },
      vertexShader: /* glsl */`
        uniform vec2 uResolution; uniform float uPx; uniform float uWidth; uniform vec2 uOffset;
        void main() {
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          p.xy += uOffset * uWidth * uPx * 2.0 / uResolution * p.w;
          gl_Position = p;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uAccent;
        void main() {
          gl_FragColor = vec4(uAccent, 1.0);
          ${TONE}
        }`,
      side: THREE.DoubleSide, transparent: true, depthWrite: false, depthTest: false,
      stencilWrite: true, stencilRef: 1, stencilFunc: THREE.NotEqualStencilFunc,
      stencilZPass: THREE.KeepStencilOp, stencilZFail: THREE.KeepStencilOp, stencilFail: THREE.KeepStencilOp,
    }));
  }
  return { mask, rims, dispose() { mask.dispose(); rims.forEach((m) => m.dispose()); } };
}

/** Geometry for the hull: positions plus normals averaged across every face that shares a point. */
export function buildHullGeometry(positions, indices) {
  const key = (i) => `${Math.round(positions[i * 3] * 500)},${Math.round(positions[i * 3 + 1] * 500)},${Math.round(positions[i * 3 + 2] * 500)}`;
  const sums = new Map();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  const seen = new Map();
  for (let t = 0; t < indices.length; t += 3) {
    const i0 = indices[t], i1 = indices[t + 1], i2 = indices[t + 2];
    a.fromArray(positions, i0 * 3); b.fromArray(positions, i1 * 3); c.fromArray(positions, i2 * 3);
    n.copy(b).sub(a).cross(c.sub(a));
    if (n.lengthSq() < 1e-14) continue;
    n.normalize();
    const nk = `${Math.round(n.x * 50)},${Math.round(n.y * 50)},${Math.round(n.z * 50)}`;
    for (const i of [i0, i1, i2]) {
      const k = key(i);
      // each distinct face direction counts once per point, so big and small faces weigh the same
      const tag = k + '|' + nk;
      if (seen.has(tag)) continue;
      seen.set(tag, true);
      const s = sums.get(k) || [0, 0, 0];
      s[0] += n.x; s[1] += n.y; s[2] += n.z;
      sums.set(k, s);
    }
  }
  const count = positions.length / 3;
  const smooth = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const s = sums.get(key(i));
    if (!s) continue;
    const l = Math.hypot(s[0], s[1], s[2]) || 1;
    smooth[i * 3] = s[0] / l; smooth[i * 3 + 1] = s[1] / l; smooth[i * 3 + 2] = s[2] / l;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('aSmooth', new THREE.BufferAttribute(smooth, 3));
  g.setIndex(Array.from(indices));
  g.computeBoundingSphere();
  return g;
}
