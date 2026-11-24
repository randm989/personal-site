// Wording and number typography for the UI. Durations, clock and temperature
// come from the shared helpers in src/state/format.js so the UI and the brain
// say the same thing; this file adds only what is specific to drawing text.

import { formatDuration, formatClock, formatTemp, formatRemaining } from '../state/format.js';

export { formatDuration, formatClock, formatTemp, formatRemaining };

const NNBSP = ' ';   // narrow no-break space between a number and its unit
const MINUS = '−';

/** Age of something as a duration, or '' when there is nothing to say. */
export function age(now, at) {
  if (typeof at !== 'number' || !Number.isFinite(at) || typeof now !== 'number') return '';
  return formatDuration(Math.max(0, now - at));
}

/** '4 min ago'; '' when under a minute old or unknown (brief section 8 rule 4). */
export function ago(now, at) {
  const d = age(now, at);
  return !d || d === 'just now' ? '' : `${d} ago`;
}

/** '4 min ago', or 'Just now' under a minute; '' when the time is not known. */
export function agoOrNow(now, at) {
  const d = age(now, at);
  return !d ? '' : d === 'just now' ? 'Just now' : `${d} ago`;
}

/** 'Thu 23' in the viewer's locale. */
export function formatDay(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  try {
    const wd = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(d);
    return `${wd} ${d.getDate()}`;
  } catch {
    return String(d.getDate());
  }
}

/** A glanceable temperature: whole degrees, '21 °C'. */
export function glanceTemp(reading) {
  if (!reading || typeof reading.value !== 'number' || !Number.isFinite(reading.value)) return '';
  return formatTemp(Math.round(reading.value), reading.unit);
}

const UNIT = /(\d[\d.,]*)[   ]?(°C|°F|°|%|min|h|d|K|W|kW|kWh|ppm|lx)(?![A-Za-z])/g;

/**
 * Text → DOM with number typography applied: a narrow no-break space before the
 * unit, the unit in its own span (drawn one text level down), a true minus.
 * @param {string} str
 * @returns {DocumentFragment}
 */
export function rich(str) {
  const frag = document.createDocumentFragment();
  const text = String(str == null ? '' : str).replace(/(^|[\s(])-(?=\d)/g, `$1${MINUS}`);
  let last = 0;
  UNIT.lastIndex = 0;
  let m;
  while ((m = UNIT.exec(text))) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    frag.append(m[1]);
    const unit = document.createElement('span');
    unit.className = 'hv-unit';
    unit.textContent = NNBSP + m[2];
    frag.append(unit);
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

/** 'Sam and Alex home' | 'Nobody home' | '' (no people configured or nothing known). */
export function peopleLine(people) {
  if (!Array.isArray(people) || people.length === 0) return '';
  const home = people.filter((p) => p.home === true).map((p) => p.name);
  if (home.length) {
    const names = home.length <= 2 ? home.join(' and ') : `${home.slice(0, -1).join(', ')} and ${home[home.length - 1]}`;
    return `${names} home`;
  }
  if (people.every((p) => p.home === false)) return 'Nobody home';
  return '';   // presence unknown: say nothing rather than guess
}

/** The everyday noun for a thing kind, for honest sentences. */
export function kindNoun(thing) {
  switch (thing.kind) {
    case 'door': return 'door';
    case 'window': return 'window';
    case 'light': return 'light';
    case 'camera': return 'camera';
    case 'person': return 'person';
    case 'room': return 'room';
    case 'object': return (thing.name || 'item').toLowerCase();
    case 'house': return 'house';
    default: return 'item';
  }
}
