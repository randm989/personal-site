// Composition root. The only file that knows every module; each module knows only its contract
// (docs/CONTRACTS.md). Swapping the state source or adding a brain happens here.

import { loadPlan } from './plan/index.js';
import { createStore } from './state/store.js';
import { createDeriver } from './state/derive.js';
import { createSimulatorSource } from './state/sources/simulator.js';
import scenarios from '../data/scenarios.js';
import { createHomeAssistantSource } from './state/sources/homeassistant.js';
import { createCommands } from './brain/commands.js';
import { createRenderer } from './render/index.js';
import { createUI } from './ui/index.js';

const params = new URLSearchParams(location.search);

function fatal(message) {
  const ui = document.getElementById('ui');
  const p = document.createElement('p');
  p.className = 'fatal';
  p.textContent = message;
  ui.replaceChildren(p);
  console.error(message);
}

function initialTheme() {
  const asked = params.get('theme');
  if (asked === 'day' || asked === 'night') return asked;
  const hour = new Date().getHours();
  return hour >= 7 && hour < 19 ? 'day' : 'night';
}

function initialMode() {
  const asked = params.get('mode');
  if (asked === 'tv' || asked === 'panel') return asked;
  const noInput = matchMedia('(hover: none) and (pointer: none)').matches;
  return noInput && innerWidth >= 1280 ? 'tv' : 'auto';
}

function createSource(plan, bindings) {
  if (params.get('source') === 'ha') {
    // Connection details live in this browser only, never in the address bar or the repo.
    const url = localStorage.getItem('houseview.ha.url');
    const token = localStorage.getItem('houseview.ha.token');
    if (!url || !token) {
      throw new Error('Home Assistant source selected, but houseview.ha.url and houseview.ha.token are not set in this browser. See README.');
    }
    return createHomeAssistantSource({ url, token });
  }
  return createSimulatorSource(plan, bindings, {
    scenario: params.get('scenario') || 'evening',
    scenarios,
    freeze: params.get('freeze') === '1',
    speed: Number(params.get('speed')) || 1,
  });
}

async function boot() {
  const [plan, bindings] = await Promise.all([
    loadPlan('./data/house.json'),
    fetch('./data/bindings.json').then((r) => {
      if (!r.ok) throw new Error(`data/bindings.json: HTTP ${r.status}`);
      return r.json();
    }),
  ]);

  let theme = initialTheme();
  const mode = initialMode();
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.mode = mode;

  const renderer = createRenderer(document.getElementById('scene'), plan, {
    theme,
    tier: params.get('tier') || undefined,
  });
  let view = params.get('view') === 'reality' ? 'reality' : 'model';
  const ui = createUI(document.getElementById('ui'), plan, {
    mode, theme, view,
    getFeedCanvas: (id) => (renderer.feedCanvas ? renderer.feedCanvas(id) : null),
  });
  const store = createStore();
  const deriveNow = createDeriver(plan, bindings);
  const source = createSource(plan, bindings);

  let derived = null;
  let selected = null;
  let level = plan.levels.some((l) => l.id === params.get('level')) ? params.get('level') : plan.levels[0].id;

  function refresh() {
    derived = deriveNow(store.all(), store.connection, Date.now(), store.snapshotAt);
    renderer.update(derived);
    ui.update(derived);
  }

  function setLevel(id, from) {
    if (!plan.levels.some((l) => l.id === id) || id === level) return;
    level = id;
    if (from !== 'renderer') renderer.setLevel(id);
    ui.setLevel(id);
  }

  function select(id) {
    // A person ('person:<id>') is not a plan thing: the card is theirs, the camera goes to their phone's room.
    const person = typeof id === 'string' && id.startsWith('person:')
      ? (derived?.people || []).find((p) => `person:${p.id}` === id) : null;
    selected = person ? id : (id && plan.things[id] ? id : null);
    const focusId = person ? (person.room && plan.things[person.room] ? person.room : null) : selected;
    const thing = focusId ? plan.things[focusId] : null;
    if (thing && thing.level) setLevel(thing.level);
    ui.setSelected(selected);
    syncInsets();
    if (!person || focusId) renderer.focus(focusId);
  }

  function syncInsets() { renderer.setInsets(ui.getInsets()); }

  store.subscribe(refresh);
  // Ages ("14 min") and staleness move with the clock even when no device speaks.
  setInterval(refresh, 20_000);

  renderer.on('frame', () => ui.placeMarkers((id) => renderer.project(id)));
  renderer.on('select', select);
  renderer.on('level', (id) => setLevel(id, 'renderer'));

  ui.on('select', select);
  ui.on('level', (id) => setLevel(id));
  ui.on('insets', syncInsets);
  ui.on('theme', (next) => setTheme(next));
  ui.on('view', (next) => setView(next));
  ui.on('action', (call) => {
    source.call(call.domain, call.service, call.data).catch((err) => console.error('action failed', err));
  });

  function setTheme(next) {
    if (next !== 'day' && next !== 'night') return;
    theme = next;
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]').content = theme === 'night' ? '#10151C' : '#F1F3F6';
    renderer.setTheme(theme);
    ui.setTheme(theme);
  }

  // 'reality' lays live camera pictures onto the model; 'model' is the plain maquette.
  function setView(next) {
    if (next !== 'model' && next !== 'reality') return;
    view = next;
    if (renderer.setView) renderer.setView(view);
    if (ui.setView) ui.setView(view);
  }

  addEventListener('resize', syncInsets);
  addEventListener('keydown', (e) => { if (e.key === 'Escape') select(null); });

  setView(view);
  renderer.setLevel(level);
  ui.setLevel(level);
  refresh();
  syncInsets();
  if (mode === 'tv') renderer.setAmbient(true);

  source.start({
    onSnapshot: (states) => store.applySnapshot(states),
    onChange: (state) => store.applyChange(state),
    onRemove: (entityId) => store.remove(entityId),
    onConnection: (status) => store.setConnection(status),
  });

  // The brain seam: what the view knows, in words, and the handful of ways to drive it.
  window.houseView = createCommands({
    renderer: {
      focus: (id) => select(id),
      setLevel: (id) => setLevel(id),
      highlight: (ids, ms) => renderer.highlight(ids, ms),
      setTheme,
      setView,
    },
    ui,
    store,
    plan,
    getDerived: () => derived,
    getView: () => view,
  });
}

boot().catch((err) => fatal(`House View could not start: ${err && err.message ? err.message : err}`));
