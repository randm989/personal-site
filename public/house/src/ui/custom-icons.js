// Icons the vendored Phosphor set does not have, hand-drawn on the same 256 grid.
// Regular is a 16-unit round stroke, Bold 24, exactly as Phosphor draws them; Fill is the
// solid twin (the "on" form). They take currentColor like the vendored files.
// Nothing here is downloaded.

const stroke = (w, inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`;
const solid = (inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" focusable="false">${inner}</svg>`;

/** name → (weight) → svg markup */
const DRAW = {
  // A camera: body and lens hood.
  camera: (w) => (w === 'fill'
    ? solid('<path stroke="currentColor" stroke-width="16" stroke-linejoin="round" d="M40 64h144a16 16 0 0 1 16 16v32l48-32v96l-48-32v32a16 16 0 0 1-16 16H40a16 16 0 0 1-16-16V80a16 16 0 0 1 16-16Z"/>')
    : stroke(w === 'bold' ? 24 : 16, '<rect x="24" y="64" width="176" height="128" rx="16"/><path d="M200 112l48-32v96l-48-32"/>')),

  // A game pad: pill body, d-pad on the left, two buttons on the right.
  'game-controller': (w) => {
    if (w === 'fill') {
      return solid('<path fill-rule="evenodd" d="M80 64h96a64 64 0 0 1 0 128H80a64 64 0 0 1 0-128Zm4 36v20H64v16h20v20h16v-20h20v-16h-20v-20Zm68 12a12 12 0 1 0 24 0a12 12 0 1 0-24 0Zm24 32a12 12 0 1 0 24 0a12 12 0 1 0-24 0Z"/>');
    }
    const b = w === 'bold';
    const r = b ? 14 : 12;
    return stroke(b ? 24 : 16,
      `<rect x="24" y="72" width="208" height="112" rx="56"/><path d="M72 128h40M92 108v40"/><circle cx="164" cy="112" r="${r}" fill="currentColor" stroke="none"/><circle cx="188" cy="144" r="${r}" fill="currentColor" stroke="none"/>`);
  },

  // A 3D printer: a gantry over the bed, the nozzle, and the part growing under it
  // (a dome, so the whole never reads as a floppy disk).
  printer3d: (w) => {
    const sw = w === 'bold' ? 24 : 16;
    const part = w === 'fill'
      ? '<path fill="currentColor" d="M84 208a44 44 0 0 1 88 0Z"/>'
      : '<path d="M88 208a40 40 0 0 1 80 0"/>';
    return stroke(sw, `<path d="M24 208h208M56 208V72a24 24 0 0 1 24-24h96a24 24 0 0 1 24 24v136M128 48v40"/><path fill="currentColor" d="M112 88h32l-16 24Z"/>${part}`);
  },

  // A phone.
  phone: (w) => (w === 'fill'
    ? solid('<path fill-rule="evenodd" d="M80 16h96a24 24 0 0 1 24 24v176a24 24 0 0 1-24 24H80a24 24 0 0 1-24-24V40a24 24 0 0 1 24-24Zm24 36a8 8 0 0 0 0 16h48a8 8 0 0 0 0-16Z"/>')
    : stroke(w === 'bold' ? 24 : 16, '<rect x="64" y="24" width="128" height="208" rx="16"/><path d="M108 60h40"/>')),

  // A live picture: a frame with a steady dot in it (a picture that is being taken now).
  'live-picture': (w) => (w === 'fill'
    ? solid('<path fill-rule="evenodd" d="M48 48h160a24 24 0 0 1 24 24v112a24 24 0 0 1-24 24H48a24 24 0 0 1-24-24V72a24 24 0 0 1 24-24Zm80 44a36 36 0 1 0 0 72a36 36 0 1 0 0-72Z"/>')
    : stroke(w === 'bold' ? 24 : 16, `<rect x="32" y="56" width="192" height="144" rx="24"/><circle cx="128" cy="128" r="${w === 'bold' ? 30 : 28}" fill="currentColor" stroke="none"/>`)),

  // A battery with one bar left.
  'battery-low': (w) => stroke(w === 'bold' ? 24 : 16,
    '<rect x="16" y="64" width="200" height="128" rx="24"/><path d="M248 100v56M56 104v48"/>'),
};

/** Markup for a hand-drawn icon, or null when the name is not one of ours. */
export function customIcon(name, weight = 'regular') {
  const draw = DRAW[name];
  return draw ? draw(weight) : null;
}

export const CUSTOM_ICONS = Object.keys(DRAW);
