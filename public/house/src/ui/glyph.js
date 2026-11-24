// State glyphs: every state has a shape, a fill style and (beside it) a word.
// Colour is the third cue. Shapes per style brief section 2:
//   on        filled disc, Fill icon in ink
//   attention ring with a gap (270° arc), Regular icon in the state colour
//   alert     filled triangle, point up
//   unknown   dashed circle (4 dashes) with ?, clock (stale) or slashed wifi (offline)
//   secure    small filled rounded square, Fill lock (detail card only)
//   off/none  no shape: a Regular outline icon in tertiary text
//   feed      no shape: the live-picture mark on a small plate (a camera with a picture, reality view)

import { icon } from './icons.js';

const SVG = (inner) =>
  `<svg class="hv-glyph-shape" viewBox="0 0 32 32" aria-hidden="true" focusable="false">${inner}</svg>`;

const SHAPES = {
  on: SVG('<circle class="hv-shape-fill" cx="16" cy="16" r="15.5"/><circle class="hv-shape-edge" cx="16" cy="16" r="15.5"/>'),
  // Dash starts at 3 o'clock and runs clockwise for 270°, leaving the top-right quarter open.
  attention: SVG('<circle class="hv-shape-line" cx="16" cy="16" r="13.5" pathLength="100" stroke-dasharray="75 25" stroke-linecap="round"/>'),
  // Four dashes centred on the compass points.
  unknown: SVG('<circle class="hv-shape-line" cx="16" cy="16" r="13.5" pathLength="12" stroke-dasharray="2 1" transform="rotate(-30 16 16)"/>'),
  alert: SVG('<path class="hv-shape-fill hv-shape-tri" d="M16 4.5 29 27H3Z"/><path class="hv-shape-mark" d="M16 12.5v7.5"/><circle class="hv-shape-dot" cx="16" cy="23.6" r="1.5"/>'),
  secure: SVG('<rect class="hv-shape-fill" x="3" y="3" width="26" height="26" rx="8"/>'),
};

/**
 * @param {'on'|'off'|'attention'|'secure'|'alert'|'unknown'|'none'} status
 * @param {string|null} iconName  Phosphor name drawn inside (ignored for alert)
 * @param {{ bold?: boolean, plate?: boolean, bare?: boolean }} [opts]
 *        bold: TV and markers use the Bold weight in place of Regular.
 *        plate: sit the glyph on a --surface disc (required whenever it is not already on a panel).
 *        bare: draw the shape only, with no icon inside (small sizes).
 */
export function glyph(status, iconName, opts = {}) {
  const el = document.createElement('span');
  el.className = 'hv-glyph';
  el.dataset.status = status;
  el.setAttribute('aria-hidden', 'true');
  if (opts.plate) el.classList.add('hv-glyph--plate');
  const shape = SHAPES[status];
  if (shape) el.innerHTML = shape;
  if (status === 'alert') return el;                    // the triangle is the whole glyph
  if (opts.bare && shape) return el;
  if (!iconName) return el;
  const filled = status === 'on' || status === 'secure';
  const weight = filled ? 'fill' : (opts.bold ? 'bold' : 'regular');
  el.append(icon(iconName, weight));
  return el;
}

/** What to draw inside a dashed circle: why we do not know. */
export function unknownIcon(why) {
  if (why === 'stale') return 'clock';
  if (why === 'offline') return 'wifi-slash';
  return 'question';             // 'no-data' and anything else
}

/**
 * The icon that names a thing, given what it is and (for doors) what it is doing.
 * There is no vendored "window" or "blinds" icon: square-half (a frame, one half slatted) stands in.
 */
export function thingIcon(thing, plan) {
  if (!thing) return 'circle';
  switch (thing.kind) {
    case 'light': return 'lightbulb';
    case 'door': {
      const opening = plan && Array.isArray(plan.openings) ? plan.openings.find((o) => o.id === thing.id) : null;
      if (opening && opening.style === 'garage') return 'garage';
      if (thing.open === true) return 'door-open';
      if (thing.locked === false) return 'lock-open';
      if (thing.locked === true) return 'lock';
      return 'door';
    }
    case 'window': return 'square-half';
    case 'camera': return 'camera';
    case 'person': return 'user';
    case 'room':
      if (thing.alert === 'leak') return 'drop';
      if (thing.alert === 'smoke') return 'fire';
      // Motion that matters (the alarm is armed): the sensor's waves, not a thermometer.
      if (thing.motion === true && thing.status === 'attention') return 'broadcast';
      return 'thermometer-simple';
    case 'object': {
      const obj = plan && Array.isArray(plan.objects) ? plan.objects.find((o) => o.id === thing.id) : null;
      const type = obj ? obj.type : '';
      if (obj && obj.role === 'vehicle') return 'car-simple';
      if (type === 'washer' || type === 'dryer') return 'washing-machine';
      if (type === 'tv') return 'television-simple';
      if (type === 'stove') return 'oven';
      if (type === 'console') return 'game-controller';
      if (type === 'printer3d') return 'printer3d';
      return 'power';
    }
    case 'house': return 'house-line';
    default: return 'circle';
  }
}

/** Glyph for a thing in its current state (card header, markers). */
export function thingGlyph(thing, plan, opts = {}) {
  const status = thing.status;
  if (status === 'unknown') return glyph('unknown', unknownIcon(thing.freshness), opts);
  if (status === 'alert') return glyph('alert', null, opts);
  return glyph(status, thingIcon(thing, plan), opts);
}

/** Every icon the UI can ask for, so first paint is complete. */
export const ICONS_USED = [
  ['lightbulb'], ['lightbulb', 'fill'], ['lightbulb', 'bold'],
  ['door'], ['door-open'], ['door-open', 'bold'], ['garage'], ['garage', 'bold'],
  ['lock'], ['lock', 'fill'], ['lock-open'], ['lock-open', 'bold'],
  ['square-half'], ['square-half', 'bold'], ['drop'], ['fire'],
  ['thermometer-simple'], ['car-simple'], ['car-simple', 'fill'],
  ['washing-machine'], ['washing-machine', 'fill'], ['power'], ['power', 'fill'],
  ['house-line'], ['question'], ['question', 'bold'], ['clock'], ['clock', 'bold'],
  ['wifi-slash'], ['wifi-slash', 'bold'], ['shield-check'], ['shield-check', 'bold'],
  ['x'], ['sun'], ['moon'], ['caret-right'], ['users'], ['user'],
  ['television-simple'], ['television-simple', 'fill'], ['oven'], ['broadcast'], ['broadcast', 'bold'],
  ['battery-charging'],
  // hand-drawn (custom-icons.js)
  ['camera'], ['camera', 'fill'], ['camera', 'bold'], ['game-controller'], ['game-controller', 'fill'],
  ['printer3d'], ['printer3d', 'fill'], ['printer3d', 'bold'], ['phone'], ['battery-low'],
  ['live-picture'], ['live-picture', 'bold'],
];
