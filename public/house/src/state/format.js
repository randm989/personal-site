// Pure text helpers shared by the UI and the brain. No state, no DOM.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * '14 min', '3 h', '2 d'. Rounded down, never seconds; under a minute is 'just now'.
 * @param {number} ms
 */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < MINUTE) return 'just now';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h`;
  return `${Math.floor(ms / DAY)} d`;
}

/** '21:04' in local time, 24-hour. */
export function formatClock(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const two = (n) => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** '21.5 °C', '8 °C'. At most one decimal; '' when there is no value. */
export function formatTemp(value, unit = '°C') {
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(n)) return '';
  let rounded = Math.round(n * 10) / 10;
  if (Object.is(rounded, -0)) rounded = 0;
  return `${rounded} ${unit || '°C'}`;
}

/** Time left, from minutes: 'under a minute', '47 min', '1 h 20 min', '3 h'. */
export function formatRemaining(minutes) {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) return '';
  const m = Math.round(minutes);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** '60%' from a 0..1 fraction. */
export function formatPercent(fraction) {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return '';
  return `${Math.round(fraction * 100)}%`;
}
