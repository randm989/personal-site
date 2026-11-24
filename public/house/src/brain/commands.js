// The brain seam, driving side: the handful of ways an assistant can steer the view.
// Device control is deliberately absent: that belongs to the hub, where every brain already has it.
// The same commands are described for tool-calling models in ./tools.json.
//
// Commands run synchronously. A bad argument throws an Error whose message says what would have worked.

import { describe, describeJSON } from './describe.js';

const THEMES = ['day', 'night'];
const VIEWS = ['model', 'reality'];

/**
 * @param {{ renderer?:object, ui?:object, store?:object, getDerived:() => object|null, plan:object, getView?:() => string }} deps
 *   getView: the app's current view ('model' | 'reality'); when given, state() reports it.
 */
export function createCommands({ renderer, ui, store, getDerived, plan, getView }) {
  if (!plan || !plan.things) throw new Error('createCommands: a compiled plan is required');
  if (typeof getDerived !== 'function') throw new Error('createCommands: getDerived is required');
  const things = plan.things;
  const levels = plan.levels || [];

  /** Call an optional method on the renderer and the UI. Every one of these is idempotent. */
  const tell = (target, method, ...args) => {
    if (target && typeof target[method] === 'function') target[method](...args);
  };

  function current() {
    const derived = getDerived();
    if (!derived) throw new Error('The view has not received any state yet. Try again in a moment.');
    return derived;
  }

  /** Accepts an id, or a name as a person would say it ("garage door"). */
  function resolveThing(input) {
    if (typeof input !== 'string' || !input.trim()) throw new Error('Expected a thing or room id, a camera id or a person id, for example "garage_door" or "kitchen".');
    if (things[input]) return things[input];
    const wanted = normal(input);
    const matches = Object.values(things).filter((t) => normal(t.id) === wanted || normal(t.name) === wanted);
    if (matches.length === 1) return matches[0];
    const person = resolvePerson(input);
    if (person) return person;
    const derived = getDerived();
    const candidates = Object.values(things).map((t) => ({ id: t.id, name: t.name }))
      .concat(((derived && derived.people) || []).map((p) => ({ id: p.id, name: p.name })));
    const close = closest(input, candidates);
    throw new Error(`Unknown thing "${input}". ${close.length ? `Close matches: ${close.join(', ')}.` : 'Nothing similar is in the plan.'}`);
  }

  /**
   * A person id ("josh", "person:josh") or name resolves to the room their phone is in. Returns null when the
   * input names nobody; throws when it names someone whose phone is not in a known room.
   */
  function resolvePerson(input) {
    const derived = getDerived();
    const people = (derived && derived.people) || [];
    const wanted = normal(String(input).replace(/^person:/i, ''));
    const hits = people.filter((p) => normal(p.id) === wanted || normal(p.name) === wanted);
    if (hits.length !== 1) return null;
    const p = hits[0];
    const room = p.room && things[p.room];
    if (!room) {
      const why = p.home === false ? `${p.name} is away`
        : p.home === true ? `${p.name} is home, but their phone is not reporting a room right now`
          : `nothing is known about ${p.name} right now`;
      throw new Error(`Cannot show where ${p.name} is: ${why}. A person can only be shown while their phone reports a room.`);
    }
    return { ...room, person: p.id };
  }

  function resolveLevel(input) {
    if (input === 'all') return 'all';
    const hit = levels.find((l) => l.id === input)
      || levels.find((l) => normal(l.name) === normal(input) || normal(l.short) === normal(input));
    if (hit) return hit.id;
    throw new Error(`Unknown level "${input}". Levels: ${levels.map((l) => `${l.id} (${l.name})`).join(', ')}.`);
  }

  const commands = {
    /** What the view shows, in words. */
    describe() { return describe(current(), plan); },
    /** The same, structured. */
    state() {
      const out = describeJSON(current(), plan);
      if (typeof getView === 'function') out.view = getView();
      return out;
    },
    /** Move the camera toward a thing or room and open its card; null returns to the overview. */
    focus(idOrNull) {
      if (idOrNull == null) {
        tell(renderer, 'focus', null);
        tell(ui, 'setSelected', null);
        return { ok: true, focused: null };
      }
      const ref = resolveThing(idOrNull);
      tell(renderer, 'focus', ref.id);
      tell(ui, 'setSelected', ref.id);
      const result = { ok: true, focused: ref.id, name: ref.name };
      if (ref.person) result.person = ref.person;       // focused on the room this person's phone is in
      return result;
    },
    /** Show one storey. */
    setLevel(levelId) {
      const id = resolveLevel(levelId);
      tell(renderer, 'setLevel', id);
      if (id !== 'all') tell(ui, 'setLevel', id);
      return { ok: true, level: id };
    },
    /** Pulse a few things so a person can see which ones are meant. */
    highlight(ids, ms = 4000) {
      const list = (Array.isArray(ids) ? ids : [ids]).map((id) => resolveThing(id).id);
      const duration = Number.isFinite(Number(ms)) && Number(ms) > 0 ? Math.min(Number(ms), 60000) : 4000;
      tell(renderer, 'highlight', list, duration);
      return { ok: true, highlighted: list, ms: duration };
    },
    setTheme(theme) {
      if (!THEMES.includes(theme)) throw new Error(`Unknown theme "${theme}". Themes: ${THEMES.join(', ')}.`);
      tell(renderer, 'setTheme', theme);
      tell(ui, 'setTheme', theme);
      return { ok: true, theme };
    },
    /**
     * 'model': the maquette. 'reality': cameras with a live picture project it onto what they can see.
     * The renderer's setView is the app-level setter (main.js), so the switch in the UI follows.
     */
    setView(view) {
      if (!VIEWS.includes(view)) throw new Error(`Unknown view ${typeof view === 'string' ? `"${view}"` : String(view)}. Views: ${VIEWS.join(', ')}.`);
      tell(renderer, 'setView', view);
      return { ok: true, view };
    },
    /** Back to the overview: no focus, no highlight. */
    reset() {
      tell(renderer, 'highlight', [], 0);
      tell(renderer, 'focus', null);
      tell(ui, 'setSelected', null);
      return { ok: true };
    },
    /** Dispatch a tool call shaped like tools.json: call('focus', { id: 'garage_door' }). */
    call(name, input = {}) {
      switch (name) {
        case 'describe': return commands.describe();
        case 'state': return commands.state();
        case 'focus': return commands.focus(input.id == null ? null : input.id);
        case 'setLevel': return commands.setLevel(input.level);
        case 'highlight': return commands.highlight(input.ids, input.ms);
        case 'setTheme': return commands.setTheme(input.theme);
        case 'setView': return commands.setView(input.view);
        case 'reset': return commands.reset();
        default: throw new Error(`Unknown command "${name}". Commands: describe, state, focus, setLevel, highlight, setTheme, setView, reset.`);
      }
    },
  };
  // `store` is accepted for the contract's sake; everything the brain may read comes through getDerived.
  void store;
  return commands;
}

const normal = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** Up to five ids that look like what was asked for. */
function closest(input, candidates) {
  const wanted = normal(input);
  const tokens = wanted.split('_').filter(Boolean);
  const scored = [];
  for (const c of candidates) {
    const id = normal(c.id);
    const name = normal(c.name);
    let score = Math.min(distance(wanted, id), distance(wanted, name));
    const hay = `${id}_${name}`.split('_');
    const shared = tokens.filter((tk) => hay.some((h) => h === tk || (tk.length > 2 && (h.startsWith(tk) || tk.startsWith(h) && h.length > 2)))).length;
    score -= shared * 4;
    if (id.includes(wanted) || name.includes(wanted)) score -= 4;
    const limit = Math.max(2, Math.floor(wanted.length / 2));
    if (shared > 0 || score <= limit) scored.push({ id: c.id, score });
  }
  return scored.sort((a, b) => a.score - b.score || a.id.localeCompare(b.id)).slice(0, 5).map((s) => s.id);
}

function distance(a, b) {
  if (a === b) return 0;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = keep;
    }
  }
  return prev[b.length];
}
