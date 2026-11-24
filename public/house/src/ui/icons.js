// Phosphor icons, vendored as individual SVG files. Each file is fetched once,
// cached, and inlined so it takes `currentColor`. No network beyond our own origin.

import { customIcon } from "./custom-icons.js";

const BASE = new URL('../../vendor/icons/phosphor/', import.meta.url);

/** @type {Map<string, string>} resolved SVG markup by "weight/name" */
const ready = new Map();
/** @type {Map<string, Promise<string>>} */
const pending = new Map();

function fileFor(name, weight) {
  const suffix = weight === 'regular' ? '' : `-${weight}`;
  return new URL(`${weight}/${name}${suffix}.svg`, BASE);
}

function load(name, weight) {
  const key = `${weight}/${name}`;
  if (pending.has(key)) return pending.get(key);
  // Hand-drawn icons (custom-icons.js) need no file.
  const own = customIcon(name, weight);
  if (own) {
    ready.set(key, own);
    const done = Promise.resolve(own);
    pending.set(key, done);
    return done;
  }
  const p = fetch(fileFor(name, weight))
    .then((res) => {
      if (!res.ok) throw new Error(`icon ${key}: HTTP ${res.status}`);
      return res.text();
    })
    .then((text) => {
      const start = text.indexOf('<svg');
      if (start < 0) throw new Error(`icon ${key}: not an SVG`);
      // Decorative: the word beside it carries the meaning.
      const svg = text.slice(start).replace('<svg', '<svg aria-hidden="true" focusable="false"');
      ready.set(key, svg);
      return svg;
    })
    .catch((err) => {
      // Fail loudly in the console, quietly on screen: an empty box, never a wrong icon.
      console.error(`[house-view] ${err.message}`);
      ready.set(key, '');
      return '';
    });
  pending.set(key, p);
  return p;
}

/**
 * An inline icon element. Returned synchronously; the artwork fills in when the
 * file arrives (immediately, if it was loaded before).
 * @param {string} name   Phosphor name, e.g. 'door-open'
 * @param {'regular'|'fill'|'bold'} [weight]
 * @returns {HTMLSpanElement}
 */
export function icon(name, weight = 'regular') {
  const el = document.createElement('span');
  el.className = 'hv-icon';
  el.dataset.icon = name;
  el.setAttribute('aria-hidden', 'true');
  const key = `${weight}/${name}`;
  if (ready.has(key)) el.innerHTML = ready.get(key);
  else load(name, weight).then((svg) => { el.innerHTML = svg; });
  return el;
}

/** Warm the cache so first paint has its icons. Resolves when all have settled. */
export function preloadIcons(list) {
  return Promise.all(list.map(([name, weight = 'regular']) => load(name, weight)));
}
