// Scene palette for both themes (style brief §3) and small colour helpers. Hexes are authored as sRGB and
// converted to linear once; the shaders work in linear and the renderer converts back on output.

import * as THREE from 'three';
import { MAT, MAT_COUNT } from './builder.js';

const lin = (hex) => new THREE.Color().setStyle(hex, THREE.SRGBColorSpace);   // -> linear working space

const NIGHT = {
  slots: {
    floor: '#303945', wall: '#55606F', cap: '#8B95A3', furn: '#3D4856', slab: '#2B3441', leaf: '#8B95A3',
    furnDark: '#232B35', furnLight: '#5A6575', carBody: '#77828F', carGlass: '#1C232C', tyre: '#12171D',
    rug: '#39434F', leafPlain: '#616C7B', edge: '#4B5563', blind: '#7C8696', ground: '#161C24',
    // scenery: water is a desaturated slate, timber and paving are tones of the same family, never colours
    water: '#46586E', deck: '#3B3A3D', drive: '#252D38', figure: '#C3CAD4', device: '#9AA4B1', coping: '#4A5361',
  },
  // camera view wedges: a quiet neutral, a calm lighter neutral while something moves, attention only on request
  wedge: '#9FB0C6', wedgeActive: '#E6ECF4', attention: '#FF9440', wedgeFill: 0.085, wedgeFillActive: 0.26, wedgeRim: 0.34,
  applianceOn: '#FFB25E', applianceDone: '#AEB8C5',
  key: '#C9D6E8', keyIntensity: 3.1,
  hemiSky: '#DCDFE6', hemiGround: '#8A8F9A', hemiIntensity: 1.45,
  envIntensity: 0.1,
  glass: '#8FA6C2', glassOpacity: 0.24,
  contact: '#070B10', contactOpacity: 0.55,
  alert: '#F2463E', alertMix: 0.3,
  halo: '#A3B3C9', haloMix: 0.3,
  hatch: '#8D98A8',
  accent: '#6CA3EE',
  fixtureOff: '#6B7686',
  subdue: '#1B222C', subdueMix: 0.5,
  lampFloor: 0.8, lampWall: 0.56, lampFurn: 0.6, lampWhiten: 0.0, lampGain: 1.0,
  haloGain: 0.55,
  shadowIntensity: 0.9,
};

const DAY = {
  slots: {
    floor: '#D9DEE6', wall: '#F7F8FA', cap: '#8793A3', furn: '#EEF1F4', slab: '#CBD2DB', leaf: '#C4CBD4',
    furnDark: '#A9B2BE', furnLight: '#F4F6F8', carBody: '#C3CAD3', carGlass: '#5E6B7A', tyre: '#3A4450',
    rug: '#CFD6DE', leafPlain: '#E3E7EC', edge: '#E6E9EE', blind: '#CBD1D9', ground: '#DCE1E8',
    water: '#B3C5D6', deck: '#D9D3CB', drive: '#C1C8D1', figure: '#7A8697', device: '#8793A3', coping: '#EEF1F4',
  },
  wedge: '#6E7F96', wedgeActive: '#3F4E63', attention: '#BF5210', wedgeFill: 0.1, wedgeFillActive: 0.3, wedgeRim: 0.42,
  applianceOn: '#F2A63A', applianceDone: '#8793A3',
  key: '#FFF6E8', keyIntensity: 2.0,
  hemiSky: '#FFFFFF', hemiGround: '#D4DAE2', hemiIntensity: 1.05,
  envIntensity: 0.1,
  glass: '#8FAECB', glassOpacity: 0.3,
  contact: '#3B4A5E', contactOpacity: 0.36,
  alert: '#A8102A', alertMix: 0.18,
  halo: '#6F7F95', haloMix: 0.22,
  hatch: '#7B8798',
  accent: '#1D63B8',
  fixtureOff: '#B3BCC8',
  subdue: '#D5DAE1', subdueMix: 0.45,
  lampFloor: 0.88, lampWall: 0.6, lampFurn: 0.62, lampWhiten: 0.08, lampGain: 1.1,
  haloGain: 0.42,
  shadowIntensity: 0.8,

};

function compile(t) {
  const slots = new Array(MAT_COUNT);
  for (const [name, index] of Object.entries(MAT)) slots[index] = lin(t.slots[name] || '#ff00ff');
  const out = { slots };
  for (const [k, v] of Object.entries(t)) {
    if (k === 'slots') continue;
    out[k] = typeof v === 'string' ? lin(v) : v;
  }
  return out;
}

export const THEMES = { night: compile(NIGHT), day: compile(DAY) };

/** Blend two compiled themes (0 = a, 1 = b) into `out` (same shape). */
export function mixThemes(a, b, t, out) {
  out = out || { slots: a.slots.map((c) => c.clone()) };
  for (let i = 0; i < a.slots.length; i++) out.slots[i].copy(a.slots[i]).lerp(b.slots[i], t);
  for (const k of Object.keys(a)) {
    if (k === 'slots') continue;
    if (a[k].isColor) { out[k] = (out[k] || new THREE.Color()).copy(a[k]).lerp(b[k], t); }
    else out[k] = a[k] + (b[k] - a[k]) * t;
  }
  return out;
}

// Colour temperature -> glow colour (style brief §3 table), sRGB.
const TEMPS = [
  [2200, 0xFF, 0x9A, 0x3D], [2700, 0xFF, 0xA9, 0x57], [3000, 0xFF, 0xB4, 0x6B],
  [4000, 0xFF, 0xD1, 0xA3], [5000, 0xFF, 0xE4, 0xCE], [6500, 0xFF, 0xF9, 0xFD],
];

/** @returns {[number, number, number]} linear RGB for a colour temperature (default 2700 K). */
export function kelvinToLinear(k) {
  if (typeof k !== 'number' || !Number.isFinite(k)) k = 2700;
  k = Math.max(TEMPS[0][0], Math.min(TEMPS[TEMPS.length - 1][0], k));
  let i = 0;
  while (i < TEMPS.length - 2 && k > TEMPS[i + 1][0]) i++;
  const a = TEMPS[i], b = TEMPS[i + 1];
  const t = (k - a[0]) / (b[0] - a[0]);
  const c = new THREE.Color().setRGB(
    (a[1] + (b[1] - a[1]) * t) / 255, (a[2] + (b[2] - a[2]) * t) / 255, (a[3] + (b[3] - a[3]) * t) / 255,
    THREE.SRGBColorSpace);
  return [c.r, c.g, c.b];
}

/** An RGB lamp showing a colour: that hue at 70% saturation (brief §3). */
export function rgbToLinear(rgb) {
  const c = new THREE.Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
  const hsl = {};
  c.getHSL(hsl, THREE.SRGBColorSpace);
  c.setHSL(hsl.h, hsl.s * 0.7, Math.max(0.45, hsl.l), THREE.SRGBColorSpace);
  return [c.r, c.g, c.b];
}
