// House View UI overlay (CONTRACTS.md section 5). The thin 2D layer over the model:
// status strip, attention list, floor switcher, Model / Reality switch, detail card, markers,
// offline banner.
// Reads CompiledPlan and Derived only. Never sees an entity id: action calls are
// passed through untouched from ThingState.actions.

import { icon, preloadIcons } from './icons.js';
import { glyph, thingGlyph, thingIcon, unknownIcon, ICONS_USED } from './glyph.js';
import { age, ago, agoOrNow, formatClock, formatDay, formatTemp, formatRemaining, glanceTemp, rich, kindNoun } from './text.js';

const MARKER_STATUSES = new Set(['on', 'attention', 'alert', 'unknown']);
const MARKER_Z = { on: 1, unknown: 2, attention: 3, alert: 4 };
const LABEL_CLEAR = 40;      // px: a room label hides this close to a full marker
const CARD_IDLE_MS = 30000;  // tablet: an untouched card closes itself
const FAN_NEAR = 28;         // px: full markers closer than this are fanned apart
const ZERO = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });
const FEED_MS = 500;         // an open camera card redraws its picture about twice a second
const PERSON = 'person:';    // a selected person is 'person:<id>' (the renderer's pick uses the same form)
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(className, label) {
  const b = el('button', className);
  b.type = 'button';
  if (label) b.setAttribute('aria-label', label);
  return b;
}

/**
 * @param {HTMLElement} root
 * @param {object} plan  CompiledPlan
 * @param {{ mode?: 'auto'|'panel'|'tv', theme?: 'day'|'night', view?: 'model'|'reality',
 *           getFeedCanvas?: (cameraId: string) => HTMLCanvasElement|null }} [options]
 */
export function createUI(root, plan, options = {}) {
  if (!root || root.nodeType !== 1) throw new Error('createUI: root must be an element');
  if (!plan || !Array.isArray(plan.levels)) throw new Error('createUI: plan.levels is missing');

  const doc = root.ownerDocument;
  const win = doc.defaultView || window;
  const mode = options.mode === 'tv' || options.mode === 'panel' ? options.mode : 'auto';
  let theme = options.theme === 'day' ? 'day' : 'night';
  let view = options.view === 'reality' ? 'reality' : 'model';
  const getFeedCanvas = typeof options.getFeedCanvas === 'function' ? options.getFeedCanvas : null;
  const feedMs = Number.isFinite(options.feedRefreshMs) && options.feedRefreshMs > 0 ? options.feedRefreshMs : FEED_MS;

  /** @type {any} */ let derived = null;
  /** @type {string|null} */ let selected = null;
  let level = plan.levels.length ? plan.levels[0].id : null;
  let layout = 'desktop';
  let collapsed = false;                 // phone sheet
  let insets = { ...ZERO };
  let destroyed = false;
  let firstUpdateDone = false;
  const sig = { headline: '', attention: '', card: '', strip: '', people: '', legend: null };
  let echoing = null;                    // the id being announced by a user 'select', while listeners run

  // ---- events ---------------------------------------------------------------
  const listeners = new Map();
  function on(name, fn) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(fn);
    return () => listeners.get(name).delete(fn);
  }
  function emit(name, payload) {
    const set = listeners.get(name);
    if (set) for (const fn of [...set]) fn(payload);
  }

  // ---- skeleton -------------------------------------------------------------
  const hv = el('div', 'hv');
  hv.dataset.mode = mode;
  hv.dataset.card = 'closed';
  hv.dataset.conn = 'connecting';
  hv.dataset.view = view;
  hv.classList.add('is-booting');

  const markersLayer = el('div', 'hv-markers');
  const labelsLayer = el('div', 'hv-labels');
  labelsLayer.setAttribute('aria-hidden', 'true');

  const strip = el('header', 'hv-strip');
  const nameEl = el('span', 'hv-name', plan.name || '');
  const clockEl = el('time', 'hv-clock');
  const headlineEl = el('span', 'hv-headline');
  headlineEl.setAttribute('role', 'status');
  const lightsEl = el('span', 'hv-lights');
  const aside = el('div', 'hv-aside');
  const tempsEl = el('span', 'hv-temps');
  const tempIn = el('span', 'hv-temp');
  const tempOut = el('span', 'hv-temp');
  tempsEl.append(tempIn, tempOut);
  const dateEl = el('span', 'hv-date');
  const peopleEl = el('div', 'hv-people');
  peopleEl.setAttribute('role', 'group');
  peopleEl.setAttribute('aria-label', 'People');
  aside.append(tempsEl, dateEl, peopleEl);
  const themeBtn = button('hv-theme');
  strip.append(nameEl, clockEl, headlineEl, lightsEl, aside, themeBtn);

  const banner = el('div', 'hv-banner');
  banner.setAttribute('role', 'status');
  banner.hidden = true;

  const sheet = el('section', 'hv-sheet');
  const grabber = button('hv-grabber', 'Collapse list');
  grabber.append(el('span', 'hv-grabber-bar'));
  const summaryEl = el('p', 'hv-summary');
  // Phone: the same people chips, in the sheet where the thumb reaches.
  const sheetPeople = el('div', 'hv-people hv-sheet-people');
  sheetPeople.setAttribute('role', 'group');
  sheetPeople.setAttribute('aria-label', 'People');
  sheetPeople.hidden = true;
  sheet.append(grabber, sheetPeople, summaryEl);
  /** @type {HTMLElement|null} */ let attentionEl = null;   // not in the DOM when the list is empty
  let attentionIds = new Set();

  const floors = el('nav', 'hv-floors');
  floors.setAttribute('aria-label', 'Floor');
  const floorButtons = new Map();
  // Top storey first.
  for (const lv of [...plan.levels].reverse()) {
    const b = button('hv-floor', lv.name || lv.id);
    b.dataset.level = lv.id;
    b.textContent = lv.short || (lv.name || lv.id).slice(0, 1);
    b.addEventListener('click', () => userLevel(lv.id));
    floorButtons.set(lv.id, b);
    floors.append(b);
  }
  if (plan.levels.length < 2) floors.hidden = true;

  // Model / Reality: which way of looking at the same house. Same family as the floor switcher.
  const viewSwitch = el('div', 'hv-view');
  viewSwitch.setAttribute('role', 'group');
  viewSwitch.setAttribute('aria-label', 'View');
  const viewButtons = new Map();
  for (const [id, word, hint] of [['model', 'Model', 'Model view'], ['reality', 'Reality', 'Reality view: camera pictures on the model']]) {
    const b = button('hv-view-seg');
    b.dataset.view = id;
    b.textContent = word;
    b.title = hint;
    b.addEventListener('click', () => userView(id));
    viewButtons.set(id, b);
    viewSwitch.append(b);
  }
  // The two switchers share one dock, so each layout places them as a pair.
  const dock = el('div', 'hv-dock');
  dock.append(viewSwitch, floors);

  // Reality view: one quiet line saying what is picture and what is model.
  const legend = el('p', 'hv-legend');
  legend.setAttribute('role', 'status');
  legend.hidden = true;

  const card = el('aside', 'hv-card');
  card.setAttribute('aria-hidden', 'true');

  // Markers come last in the DOM so Tab reaches the list and the floors first; CSS keeps them beneath the panels.
  hv.append(labelsLayer, strip, banner, sheet, dock, legend, card, markersLayer);
  root.append(hv);

  // ---- layout: which of the four surfaces ------------------------------------
  // CSS draws each layout from [data-layout]; the choice itself is made with the
  // same media queries the brief names, so `mode` can override it in one place.
  const mq = {
    narrow: win.matchMedia('(max-width: 899.98px)'),
    landscapePhone: win.matchMedia('(max-height: 499.98px) and (orientation: landscape)'),
    tv: win.matchMedia('(hover: none) and (pointer: none) and (min-width: 1280px)'),
    fine: win.matchMedia('(hover: hover) and (pointer: fine)'),
    reduced: win.matchMedia('(prefers-reduced-motion: reduce)'),
  };

  function chooseLayout() {
    if (mode === 'tv') return 'tv';
    if (mq.narrow.matches && !mq.landscapePhone.matches) return 'phone';
    if (mode === 'panel') return 'tablet';
    if (mq.tv.matches) return 'tv';
    if (mq.landscapePhone.matches) return 'tablet';
    return mq.fine.matches ? 'desktop' : 'tablet';
  }

  function applyLayout() {
    const next = chooseLayout();
    // Size tier: a portrait wall panel uses the phone layout at tablet sizes;
    // a landscape phone uses the tablet layout one step down.
    const tier = next === 'phone' && mode === 'panel' ? 'panel'
      : next === 'tablet' && mq.landscapePhone.matches ? 'compact' : '';
    const changed = next !== layout || hv.dataset.layout !== next || (hv.dataset.tier || '') !== tier;
    layout = next;
    hv.dataset.layout = next;
    if (tier) hv.dataset.tier = tier; else delete hv.dataset.tier;
    hv.inert = next === 'tv';            // TV: no controls, nothing focusable
    viewSwitch.hidden = next === 'tv';   // the TV follows ?view=; it has no switch
    dock.hidden = next === 'tv';
    return changed;
  }

  // ---- public: state in -----------------------------------------------------
  function update(next) {
    if (destroyed) return;
    if (!next || typeof next !== 'object' || !next.summary || !next.things) {
      throw new Error('ui.update: expected a Derived object with summary and things');
    }
    derived = next;
    render();
    if (!firstUpdateDone) {
      // First paint appears in its current state: nothing slides in to catch up.
      win.requestAnimationFrame(() => win.requestAnimationFrame(() => hv.classList.remove('is-booting')));
    }
    firstUpdateDone = true;
  }

  function setSelected(id) {
    const next = id == null ? null : String(id);
    if (next === selected) return;
    // A host that only knows plan things answers a person selection by clearing it. The person
    // card is the UI's own, so that echo is not a reason to close it.
    if (next === null && echoing && echoing.startsWith(PERSON)) return;
    selected = next;
    if (derived) { renderPeople(); renderAttention(); renderCard(); renderMarkers(); syncGeometry(); }
  }

  function setLevel(id) {
    if (id == null || !floorButtons.has(id) || id === level) { syncFloors(); return; }
    level = id;
    syncFloors();
  }

  function setTheme(next) {
    const t = next === 'day' ? 'day' : 'night';
    const html = doc.documentElement;
    const same = t === theme && html.dataset.theme === t;
    theme = t;
    // Applies whatever was asked for last, so overlapping fades cannot land on a stale theme.
    const apply = () => {
      html.dataset.theme = theme;
      const meta = doc.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', theme === 'day' ? '#F1F3F6' : '#10151C');
      syncThemeButton();
    };
    // One cross-fade of the whole view; never a hard flip (brief section 6).
    if (!same && firstUpdateDone && hv.isConnected && typeof doc.startViewTransition === 'function' && doc.visibilityState === 'visible') {
      theme = t;
      try {
        const vt = doc.startViewTransition(apply);
        // A skipped or interrupted fade still applies the theme; it is not an error.
        const quiet = () => {};
        if (vt && vt.ready) vt.ready.catch(quiet);
        if (vt && vt.finished) vt.finished.catch(quiet);
        if (vt && vt.updateCallbackDone) vt.updateCallbackDone.catch(() => apply());
        return;
      } catch { /* fall through to a plain switch */ }
    }
    apply();
  }

  function setView(next) {
    const v = next === 'reality' ? 'reality' : 'model';
    if (v === view) { syncView(); return; }
    view = v;
    syncView();
    if (derived) { renderLegend(); renderMarkers(); syncGeometry(); }
  }

  function syncView() {
    hv.dataset.view = view;
    for (const [id, b] of viewButtons) b.setAttribute('aria-pressed', id === view ? 'true' : 'false');
  }

  // ---- user intent out ------------------------------------------------------
  function userView(id) {
    if (id === view) return;
    setView(id);
    emit('view', id);
  }
  function userSelect(id) {
    setSelected(id);
    echoing = id;
    try { emit('select', id); } finally { echoing = null; }
  }
  function userLevel(id) {
    if (id === level) return;
    setLevel(id);
    emit('level', id);
  }

  // ---- render ---------------------------------------------------------------
  function render() {
    if (!derived) return;
    hv.dataset.conn = derived.connection;
    renderStrip();
    renderPeople();
    renderBanner();
    renderLegend();
    renderAttention();
    renderCard();
    renderMarkers();
    renderLabels();
    syncFloors();
    syncGeometry();
  }

  function isLive() { return derived && derived.connection === 'live'; }
  function isOffline() { return derived && derived.connection === 'offline'; }

  // Security things we cannot vouch for: id → why ('offline' | 'stale' | 'no-data').
  // These are the unknown-severity entries of derived.attention; other unknowns stay quiet.
  function whyUnknown(thing, item) {
    const r = (item && item.reason) || (thing && thing.reason);
    if (r === 'offline' || r === 'stale' || r === 'no-data') return r;
    const f = thing ? thing.freshness : '';
    return f === 'stale' ? 'stale' : f === 'offline' ? 'offline' : 'no-data';
  }
  function securityUnknowns() {
    const out = new Map();
    if (!derived || !Array.isArray(derived.attention)) return out;
    for (const it of derived.attention) {
      if (it && it.severity === 'unknown') out.set(it.id, whyUnknown(derived.things[it.id], it));
    }
    return out;
  }
  // The glyph for a thing, with the attention tone when it is a security unknown.
  function glyphFor(thing, opts) {
    if (thing.status !== 'unknown') return thingGlyph(thing, plan, opts);
    const sec = securityUnknowns();
    const g = glyph('unknown', unknownIcon(sec.get(thing.id) || whyUnknown(thing, null)), opts);
    if (sec.has(thing.id)) g.dataset.tone = 'attention';
    return g;
  }

  function countLine() {
    // Counts are claims: only made while live, and only if any light reports at all.
    if (!isLive()) return { lights: '', open: '' };
    const s = derived.summary;
    const anyLightSensed = Object.values(derived.things).some((t) => t.kind === 'light' && t.freshness !== 'unsensed');
    const n = s.lightsOn | 0;
    const lights = !anyLightSensed ? '' : n === 0 ? 'No lights on' : n === 1 ? '1 light on' : `${n} lights on`;
    const open = s.openCount > 0 ? `${s.openCount} open` : '';
    return { lights, open };
  }

  function renderStrip() {
    const s = derived.summary;
    const clock = formatClock(derived.now);
    if (clockEl.textContent !== clock) {
      clockEl.textContent = clock;
      clockEl.dateTime = clock;
    }

    // Openings on the outside of the house that nothing watches: said quietly beside the
    // headline, so "secure" never reads as more than "secure where sensed".
    const blind = isLive() && Number.isFinite(s.unsensedExterior) && s.unsensedExterior > 0 ? s.unsensedExterior | 0 : 0;
    const unknownItems = securityUnknowns();
    const headSig = [layout, s.headline, s.headlineStatus, derived.connection, blind, unknownItems.size, [...unknownItems.values()][0] || ''].join('|');
    if (headSig !== sig.headline) {
      sig.headline = headSig;
      headlineEl.replaceChildren();
      headlineEl.dataset.status = s.headlineStatus;
      const bold = layout === 'tv';
      let mark = null;
      if (s.headlineStatus === 'attention') mark = glyph('attention', null, { plate: true, bare: true });
      else if (s.headlineStatus === 'alert') mark = glyph('alert', null, { plate: true });
      else if (s.headlineStatus === 'unknown') {
        // A security thing we cannot vouch for is drawn in the attention colour; a hub that is
        // simply unreachable keeps the quiet unknown colour.
        const first = unknownItems.size ? [...unknownItems.values()][0] : null;
        mark = glyph('unknown', isOffline() ? 'wifi-slash' : first ? unknownIcon(first) : 'question', { plate: true, bold });
        if (first && !isOffline()) mark.dataset.tone = 'attention';
      }
      else if (s.headlineStatus === 'secure') mark = glyph('none', 'shield-check', { bold });   // no state colour at rest
      if (mark) headlineEl.append(mark);
      const words = el('span', 'hv-headline-words');
      words.append(el('span', 'hv-headline-text', s.headline || ''));
      if (blind) {
        const long = blind === 1 ? '1 opening has no sensor' : `${blind} openings have no sensor`;
        // CSS swaps in the short form where the strip is tight (TV, phone, narrow desktop).
        const note = el('span', 'hv-headline-note', long);
        note.dataset.short = `${blind} unsensed`;
        words.append(note);
      }
      headlineEl.append(words);
    }

    const counts = countLine();
    const tin = isLive() ? glanceTemp(s.indoor) : '';
    const tout = isLive() ? glanceTemp(s.outdoor) : '';
    const day = formatDay(derived.now);
    const stripSig = [counts.lights, counts.open, tin, tout, day].join('|');
    if (stripSig === sig.strip) return;
    sig.strip = stripSig;

    lightsEl.textContent = counts.lights;
    lightsEl.hidden = !counts.lights;

    fillTemp(tempIn, 'Inside', tin);
    fillTemp(tempOut, 'Outside', tout);
    tempsEl.hidden = !tin && !tout;
    dateEl.textContent = day;

    summaryEl.replaceChildren();
    for (const part of [counts.lights, counts.open]) {
      if (part) summaryEl.append(el('span', 'hv-summary-item', part));
    }
    // Nothing to say: the phone sheet is not drawn at all (unless it holds the list).
    summaryEl.hidden = !summaryEl.childNodes.length;
    hv.classList.toggle('has-summary', !summaryEl.hidden);
  }

  // ---- people -----------------------------------------------------------------
  // Derived.people when the state layer gives it; else the summary's short entries. A room is
  // the phone's room (honesty rule 8) and is shown only for someone who is home.
  function peopleList() {
    if (!derived) return [];
    const full = Array.isArray(derived.people) && derived.people.length ? derived.people : null;
    const src = full || (Array.isArray(derived.summary.people) ? derived.summary.people : []);
    const out = [];
    src.forEach((p, i) => {
      if (!p || typeof p !== 'object') return;
      const id = p.id != null && p.id !== '' ? String(p.id) : `n${i}`;
      const home = p.home === true ? true : p.home === false ? false : null;
      const roomRef = home === true && typeof p.room === 'string' && Array.isArray(plan.rooms) ? plan.rooms.find((r) => r.id === p.room) : null;
      const roomName = roomRef ? (roomRef.name || roomRef.id) : (home === true && p.room && typeof p.roomName === 'string' ? p.roomName : '');
      const lv = roomRef ? plan.levels.find((l) => l.id === roomRef.level) : null;
      out.push({
        id, name: String(p.name || id), home, roomName, levelName: lv && plan.levels.length > 1 ? lv.name || '' : '',
        word: roomName || (home === true ? 'Home' : home === false ? 'Away' : 'No data'),
        battery: finite(p.battery) ? clamp01(p.battery) : null,
        charging: p.charging === true ? true : p.charging === false ? false : null,
        batteryLow: p.batteryLow === true,
        since: finite(p.since) ? p.since : null,
        freshness: typeof p.freshness === 'string' ? p.freshness : 'fresh',
        facts: Array.isArray(p.facts) ? p.facts : [],
      });
    });
    return out;
  }

  function personLabel(p) {
    const where = p.roomName ? `phone in ${p.roomName}` : p.home === true ? 'home' : p.home === false ? 'away' : 'no data';
    return `${p.name}: ${where}${p.batteryLow ? ', phone battery low' : ''}`;
  }

  function renderPeople() {
    // Who is home is a claim: only while live.
    const list = isLive() ? peopleList() : [];
    const next = JSON.stringify([layout, list.map((p) => [p.id, p.name, p.word, p.home, p.batteryLow]), selected && selected.startsWith(PERSON) ? selected : '']);
    if (next === sig.people) return;
    sig.people = next;
    for (const host of [peopleEl, sheetPeople]) {
      const focused = host.contains(doc.activeElement) ? doc.activeElement.dataset.person : null;
      host.replaceChildren();
      host.hidden = !list.length;
      for (const p of list) {
        const key = PERSON + p.id;
        const b = button('hv-chip', personLabel(p));
        b.dataset.person = p.id;
        b.dataset.home = p.home === true ? 'home' : p.home === false ? 'away' : 'unknown';
        b.setAttribute('aria-pressed', key === selected ? 'true' : 'false');
        b.append(el('span', 'hv-chip-name', p.name), ' ', el('span', 'hv-chip-where', p.word));
        if (p.batteryLow) {
          const low = el('span', 'hv-chip-battery');
          low.append(icon('battery-low'));
          b.append(low);
        }
        b.addEventListener('click', () => userSelect(key === selected ? null : key));
        host.append(b);
        if (focused && focused === p.id) b.focus({ preventScroll: true });
      }
    }
    hv.classList.toggle('has-people', list.length > 0);
  }

  // A person as a card subject: the same shape a thing has, so one card draws both.
  function personThing(p) {
    const live = isLive();
    return {
      id: PERSON + p.id, kind: 'person', name: p.name, person: p,
      freshness: live ? p.freshness : derived.connection === 'offline' ? 'offline' : 'unknown',
      status: 'none',
      text: !live ? '' : p.home === true ? 'Home' : p.home === false ? 'Away' : '',
      since: p.since, reportedAt: null, facts: p.facts, actions: [],
    };
  }

  /** What the card is about: a plan thing, or a person. */
  function subject() {
    if (!selected || !derived) return null;
    if (selected.startsWith(PERSON)) {
      const p = peopleList().find((x) => PERSON + x.id === selected);
      return p ? personThing(p) : null;
    }
    return derived.things[selected] || null;
  }

  function fillTemp(node, label, value) {

    node.replaceChildren();
    node.hidden = !value;
    if (!value) return;
    const lab = el('span', 'hv-temp-label', label);
    lab.dataset.short = label === 'Inside' ? 'In' : 'Out';
    node.append(lab, ' ');
    const v = el('span', 'hv-temp-value');
    v.append(rich(value));
    node.append(v);
  }

  function bannerText() {
    if (typeof derived.snapshotAt === 'number') return `Not connected. Showing ${formatClock(derived.snapshotAt)}`;
    return 'Not connected. Nothing received yet';
  }

  function renderBanner() {
    const show = isOffline();
    if (show) {
      const text = bannerText();
      if (banner.dataset.text !== text) {
        banner.dataset.text = text;
        const cut = text.indexOf('. ');
        const lead = el('span', 'hv-banner-lead', text.slice(0, cut + 1));
        const rest = el('span', 'hv-banner-rest', text.slice(cut + 1));
        banner.replaceChildren(icon('wifi-slash', layout === 'tv' ? 'bold' : 'regular'), lead, rest);
      }
    }
    banner.hidden = !show;
    hv.classList.toggle('is-offline', show);
  }

  // ---- reality view: live pictures ---------------------------------------------
  // A feed is a claim (honesty rule 13): only while live, only from a camera that says it has
  // one and is not in privacy. Its URL carries a token and is never read here.
  function feedOf(thing) {
    if (!isLive() || !thing || thing.kind !== 'camera' || thing.privacy === true) return null;
    return thing.feed && typeof thing.feed === 'object' ? thing.feed : null;
  }

  function renderLegend() {
    const show = view === 'reality';
    const feeds = show ? Object.values(derived.things).filter((t) => feedOf(t)) : [];
    const sim = feeds.filter((t) => t.feed.simulated === true).length;
    const next = show ? `${feeds.length}|${sim}` : '';
    if (next === sig.legend) return;
    sig.legend = next;
    legend.hidden = !show;
    hv.classList.toggle('has-legend', show);
    legend.replaceChildren();
    if (!show) return;
    const n = feeds.length;
    legend.dataset.live = String(n);
    if (!n) {
      legend.append(el('span', 'hv-legend-text', 'No live cameras. Showing the model.'));
      return;
    }
    const count = el('span', 'hv-legend-count');
    // A simulated feed is not a real picture, and the count says so.
    const tail = !sim ? '' : sim === n ? ', simulated' : `, ${sim} simulated`;
    count.append(icon('live-picture'), el('span', null, `${n} ${n === 1 ? 'camera' : 'cameras'} live${tail}`));
    legend.append(el('span', 'hv-legend-text', 'Camera pictures where a camera can see. The rest is the model.'), ' ', count);
  }

  // The raw frame in an open camera card: copied from the renderer's canvas about twice a
  // second, and only while that card is open.
  const feedCanvas = el('canvas', 'hv-feed-canvas');
  feedCanvas.setAttribute('role', 'img');
  let feedTimer = 0;
  /** @type {string|null} */ let feedFor = null;
  let feedReady = false;

  function drawFeed() {
    if (destroyed || !feedFor || !getFeedCanvas) return;
    let src = null;
    try { src = getFeedCanvas(feedFor); } catch (err) { console.error('[house-view] getFeedCanvas failed:', err); }
    if (!src || !(src.width > 0) || !(src.height > 0)) return;      // nothing new: the last frame stays
    try {
      if (feedCanvas.width !== src.width || feedCanvas.height !== src.height) {
        feedCanvas.width = src.width;
        feedCanvas.height = src.height;
      }
      feedCanvas.getContext('2d').drawImage(src, 0, 0);
    } catch { return; }
    if (!feedReady) {
      feedReady = true;
      if (feedCanvas.parentNode) feedCanvas.parentNode.dataset.ready = '1';
    }
  }

  /** Start, move or stop the picture refresh. `id` is the camera whose card shows a picture, or null. */
  function syncFeed(id) {
    if (id === feedFor) return;
    if (feedTimer) { win.clearInterval(feedTimer); feedTimer = 0; }
    feedFor = id;
    feedReady = false;                   // never one camera's frame under another camera's name
    if (feedCanvas.parentNode) delete feedCanvas.parentNode.dataset.ready;
    if (!id) return;
    drawFeed();
    feedTimer = win.setInterval(drawFeed, feedMs);
  }

  // What a camera card adds: whether it is indoors, whether the lens is shut, and its picture.
  function cameraInfo(thing) {
    if (thing.kind !== 'camera') return null;
    const fx = Array.isArray(plan.fixtures) ? plan.fixtures.find((f) => f.id === thing.id) : null;
    const indoor = typeof thing.indoor === 'boolean' ? thing.indoor
      : fx ? (typeof fx.indoor === 'boolean' ? fx.indoor : !!fx.mount && fx.mount !== 'exterior') : false;
    const feed = feedOf(thing);
    return {
      indoor,
      privacy: isLive() && thing.freshness === 'fresh' && thing.privacy === true,
      feed: feed ? { simulated: feed.simulated === true, age: agoOrNow(derived.now, feed.at) } : null,
    };
  }

  function renderAttention() {
    const items = Array.isArray(derived.attention) ? derived.attention : [];
    const max = layout === 'tv' ? 3 : 4;
    const shown = items.slice(0, max);
    const more = items.length - shown.length;
    const rows = shown.map((it) => [it.id, it.severity, it.text, age(derived.now, it.since), it.severity === 'unknown' ? whyUnknown(derived.things[it.id], it) : '',
      it.severity === 'attention' || it.severity === 'info' ? thingIcon(derived.things[it.id], plan) : '']);
    const next = JSON.stringify([layout, rows, more, selected]);
    if (next === sig.attention) return;
    sig.attention = next;

    if (!items.length) {
      if (attentionEl) { attentionEl.remove(); attentionEl = null; }
      attentionIds = new Set();
      hv.classList.remove('has-attention');
      return;
    }

    const focusedId = attentionEl && attentionEl.contains(doc.activeElement) ? doc.activeElement.dataset.id : null;
    if (!attentionEl) {
      attentionEl = el('div', 'hv-attention');
      const title = el('h2', 'hv-attention-title', 'Needs attention');
      const list = el('ul', 'hv-attention-list');
      attentionEl.append(title, list);
      sheet.insertBefore(attentionEl, sheetPeople);
    }
    hv.classList.add('has-attention');
    const list = attentionEl.querySelector('.hv-attention-list');
    // 'info' items are notices (a print finished): listed, quieter, never the headline.
    const onlyInfo = items.every((it) => it.severity === 'info');
    attentionEl.querySelector('.hv-attention-title').textContent = onlyInfo ? 'Notices' : 'Needs attention';
    attentionEl.dataset.tone = onlyInfo ? 'info' : 'attention';
    let seenLoud = false;
    const bold = layout === 'tv';
    const fresh = [];
    list.replaceChildren();
    for (const it of shown) {
      const thing = derived.things[it.id];
      const li = el('li', 'hv-attention-item');
      const row = button('hv-row');
      row.dataset.id = it.id;
      row.dataset.severity = it.severity;
      if (it.id === selected) row.setAttribute('aria-current', 'true');
      let mark;
      if (it.severity === 'info') {
        // No state shape at all: the plain outline icon of the thing, one text level down.
        mark = glyph('none', thingIcon(thing, plan), { bold });
        if (seenLoud) { li.classList.add('hv-attention-item--first-info'); seenLoud = false; }
      } else if (it.severity === 'alert') mark = glyph('alert', null);
      else if (it.severity === 'unknown') {
        mark = glyph('unknown', unknownIcon(whyUnknown(thing, it)), { bold });
        mark.dataset.tone = 'attention';
      } else mark = glyph('attention', thingIcon(thing, plan), { bold });
      if (it.severity !== 'info') seenLoud = true;
      const text = el('span', 'hv-row-text', it.text);
      const when = el('span', 'hv-row-age');
      when.append(rich(age(derived.now, it.since)));
      row.append(mark, text, when, el('span', 'hv-row-caret'));
      row.lastChild.append(icon('caret-right'));
      row.addEventListener('click', () => userSelect(it.id));
      li.append(row);
      list.append(li);
      if (firstUpdateDone && !attentionIds.has(it.id)) fresh.push(li);
      if (focusedId && focusedId === it.id) row.focus({ preventScroll: true });
    }
    if (more > 0) list.append(el('li', 'hv-more', `+${more} more`));
    attentionIds = new Set(shown.map((it) => it.id));

    // Row enter: opacity + 8px, 240 ms. Reduced motion: opacity only.
    for (const li of fresh) {
      if (typeof li.animate !== 'function') continue;
      const reduced = mq.reduced.matches;
      li.animate(
        reduced ? [{ opacity: 0 }, { opacity: 1 }]
          : [{ opacity: 0, transform: 'translate3d(0, 8px, 0)' }, { opacity: 1, transform: 'translate3d(0, 0, 0)' }],
        { duration: reduced ? 150 : 240, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
      );
    }
  }

  // The honest sentence for each way of not knowing (brief section 8).
  function cardCopy(thing) {
    const now = derived.now;
    if (thing.kind === 'person' && isLive()) {
      // Home or away is the claim; where the phone is comes below, in its own words.
      if (thing.freshness === 'unsensed') {
        return { value: 'No phone or presence sensor yet', quiet: true, since: '', note: 'Nothing reports on this person, so the view makes no claim.' };
      }
      if (thing.person.home === null) {
        return { value: 'No data', quiet: true, since: '', note: 'Nothing recent says whether this person is home or away.' };
      }
      return { value: thing.text, quiet: false, since: age(now, thing.since), note: '' };
    }
    if (thing.kind === 'camera' && thing.privacy === true && thing.freshness === 'fresh' && isLive()) {
      // Shut on purpose: a known state, not a fault, and there is no picture to show.
      return { value: 'Privacy', quiet: false, since: age(now, thing.since), note: 'The lens is shut on purpose. No picture is shown or projected.' };
    }
    if (thing.freshness === 'unsensed') {
      const noun = kindNoun(thing);

      const value = thing.kind === 'room' ? 'No sensors in this room'
        : thing.kind === 'house' ? 'No sensors yet'
        : thing.kind === 'camera' ? 'Camera not connected'
        : thing.kind === 'object' ? `No sensor on the ${noun}` : `No sensor on this ${noun}`;
      return { value, quiet: true, since: '', note: 'Nothing reports on it, so the view makes no claim about its state.' };
    }
    if (thing.freshness === 'offline' && thing.status !== 'attention' && thing.status !== 'alert') {
      const at = typeof derived.snapshotAt === 'number' ? ` Last heard from the hub at ${formatClock(derived.snapshotAt)}.` : '';
      return { value: 'Not connected', quiet: true, since: '', note: `The view cannot reach the hub, so it makes no claim.${at}` };
    }
    if (thing.status === 'unknown' || (thing.freshness !== 'fresh' && !thing.text)) {
      const heard = ago(now, thing.reportedAt);
      const d = age(now, thing.reportedAt);
      const value = thing.text || 'No data';
      let note;
      if (thing.freshness === 'stale') {
        note = `${heard ? `Last heard from ${heard}.` : 'It has gone quiet.'} What it said before then may no longer be true.`;
      } else if (/offline/i.test(value)) {
        note = `The device is unreachable${heard ? `; last heard from ${heard}` : ''}.`;
      } else if (derived.connection === 'connecting') {
        note = 'Waiting for the first report.';
      } else {
        note = heard ? `Last heard from ${heard}.` : 'It has not reported anything yet.';
      }
      return { value, quiet: true, since: d && d !== 'just now' ? d : '', note };
    }
    const d = age(now, thing.since);
    const note = thing.freshness === 'fresh' ? '' : 'Part of this has gone quiet. See below for what is still reported.';
    return { value: thing.text || '', quiet: false, since: d, note };
  }

  // What a kind adds to its card beyond the generic facts: what is playing, print progress,
  // last motion, where the phone is. Plain data, so it can be part of the card's signature.
  // Every item is a claim and is only made from a fresh thing while live.
  function cardExtras(thing, copy) {
    const x = { media: '', progress: null, phone: null, rows: [], drop: [], low: false };
    if (!isLive() || (thing.freshness !== 'fresh' && thing.kind !== 'person')) return x;
    const now = derived.now;
    const facts = Array.isArray(thing.facts) ? thing.facts : [];
    const has = (re) => facts.some((f) => f && re.test(String(f.label || '')));
    // A fact row the card says better in its own words is dropped (by index), unless it is a
    // last-known or no-data row: those say something the claim cannot.
    const live = (f) => f && !f.lastKnown && !f.unknown;
    const drop = (test) => facts.forEach((f, i) => { if (live(f) && test(f, String(f.label || ''))) x.drop.push(i); });
    if (thing.kind === 'object') {
      const title = typeof thing.title === 'string' ? thing.title.trim() : '';
      if (title) {
        // "Playing Hades": the verb stays the value, the title gets a line that can wrap.
        const v = String(copy.value || '');
        if (v.length > title.length && v.endsWith(title)) copy.value = v.slice(0, -title.length).trim();
        if (copy.value !== title) { x.media = title; drop((f) => String(f.value) === title); }
      }
      if ((thing.phase === 'running' || thing.phase === 'paused' || thing.phase === 'error') && finite(thing.progress)) {
        const p = clamp01(thing.progress);
        const left = thing.phase === 'running' ? formatRemaining(thing.remainingMin) : '';
        x.progress = { percent: Math.round(p * 100), tone: thing.phase === 'running' ? 'on' : 'held', left: left ? `${left} left` : '' };
        drop((f, label) => /^progress$/i.test(label) || (left && /^time left$/i.test(label)));
      }
    }
    if (thing.kind === 'camera' || thing.kind === 'room') {
      // "Last motion 52 min ago" says it straighter than "Motion: Clear, for 52 min".
      if (thing.motion === true || finite(thing.lastMotionAt)) {
        drop((f, label) => /^motion$/i.test(label));
        if (thing.motion === true) x.rows.push(['Motion', 'Now', '', '', '']);
        else x.rows.push(['Last motion', agoOrNow(now, thing.lastMotionAt), '', '', '']);
      }
    }
    if (thing.kind === 'camera') {
      // "Privacy" is the card's headline; the row that repeats it is dropped.
      if (thing.privacy === true) drop((f) => /^privacy$/i.test(String(f.value)));
      if (thing.person === true || finite(thing.lastPersonAt)) {
        drop((f, label) => /^person$/i.test(label));
        if (thing.person === true) x.rows.push(['Person', 'In view now', '', '', '']);
        else x.rows.push(['Last person', agoOrNow(now, thing.lastPersonAt), '', '', '']);
      }
      if (thing.recording === true && !has(/record/i)) x.rows.push(['Recording', 'Yes', '', '', '']);
    }
    if (thing.kind === 'person') {
      const p = thing.person;
      if (p.roomName) {
        // The reading's age: when the phone's room was last heard, from the room fact if there is one.
        const isRoomFact = (r, label) => /room|phone/i.test(label) && !/batter|charg/i.test(label);
        const f = facts.find((r) => live(r) && isRoomFact(r, String(r.label || '')));
        const at = f ? (finite(f.checkedAt) ? f.checkedAt : f.at) : null;
        const seen = agoOrNow(now, at);
        x.phone = { text: `Phone in ${p.roomName}`, level: p.levelName ? p.levelName.toLowerCase() : '', seen: seen ? `Seen ${seen.toLowerCase()}` : '' };
        drop(isRoomFact);       // the line above already says it
      }
      // Home / Away is the card's headline.
      drop((f, label) => /^presence$/i.test(label) || String(f.value) === String(copy.value || '0000'));
      x.low = p.batteryLow && p.charging !== true;
      if (p.battery != null && !has(/batter/i)) {
        const pct = `${Math.round(p.battery * 100)}%`;
        const sub = p.charging === true ? 'Charging' : p.batteryLow ? 'Low, not charging' : p.charging === false ? 'Not charging' : '';
        x.rows.push(['Phone battery', pct, sub, p.batteryLow && p.charging !== true ? 'low' : '', '']);
      }
    }
    return x;
  }

  function whereLine(thing) {
    if (thing.kind === 'person') return '';   // a person has no fixed place; the phone line says where the phone is

    // Storey: ThingState.levelId, else the plan's own record. Never thing.level, which on a
    // light is its brightness.
    const planRef = (plan.things && plan.things[thing.id]) || {};
    const ref = {
      room: thing.room != null ? thing.room : planRef.room,
      level: typeof thing.levelId === 'string' ? thing.levelId : planRef.level,
    };
    const room = ref.room && ref.room !== thing.id && Array.isArray(plan.rooms) ? plan.rooms.find((r) => r.id === ref.room) : null;
    const lv = typeof ref.level === 'string' ? plan.levels.find((l) => l.id === ref.level) : null;
    const parts = [];
    if (room && room.name) parts.push(room.name);
    if (lv && lv.name) parts.push(parts.length ? lv.name.toLowerCase() : lv.name);
    return parts.join(', ');
  }

  // Wall tablet only: a card nobody touches closes itself after 30 s. Any interaction with the
  // card cancels that for as long as this card stays open.
  const cardIdleMs = Number.isFinite(options.cardIdleMs) ? options.cardIdleMs : CARD_IDLE_MS;
  let idleTimer = 0;
  let idleFor = null;
  function clearIdle() { if (idleTimer) { win.clearTimeout(idleTimer); idleTimer = 0; } }
  function syncIdle(open) {
    if (!open) { clearIdle(); idleFor = null; return; }
    if (idleFor === selected) return;            // already armed (or cancelled) for this card
    idleFor = selected;
    clearIdle();
    if (layout !== 'tablet') return;
    idleTimer = win.setTimeout(() => {
      idleTimer = 0;
      if (!destroyed && layout === 'tablet' && cardIsOpen()) userSelect(null);
    }, cardIdleMs);
  }
  for (const type of ['pointerdown', 'keydown', 'focusin', 'wheel', 'touchstart', 'scroll']) {
    card.addEventListener(type, clearIdle, { passive: true });
  }

  function cardIsOpen() {
    return !!subject() && layout !== 'tv';
  }

  function renderCard() {
    const open = cardIsOpen();
    const was = hv.dataset.card === 'open';
    hv.dataset.card = open ? 'open' : 'closed';
    card.setAttribute('aria-hidden', open ? 'false' : 'true');
    card.inert = !open;
    syncIdle(open);
    if (!open) {
      sig.card = '';                      // content stays in place while the card fades out
      syncFeed(null);
      if (was && card.contains(doc.activeElement)) doc.activeElement.blur();
      return;
    }
    const thing = subject();
    const copy = cardCopy(thing);
    const extra = cardExtras(thing, copy);
    const where = whereLine(thing);
    const cam = cameraInfo(thing);
    syncFeed(cam && cam.feed && getFeedCanvas ? thing.id : null);
    const facts = (thing.facts || []).map((f, i) => {
      if (!f || extra.drop.includes(i)) return null;
      const kind = f.unknown ? 'unknown' : f.lastKnown ? 'last' : '';
      // A live fact's age is how long it has been unchanged ("for 6 d"). When it was last
      // confirmed is said only if that was a while ago; a recent check adds nothing.
      const d = age(derived.now, f.at);
      const when = kind ? ago(derived.now, f.at) : d && d !== 'just now' ? `for ${d}` : '';
      const stale = typeof f.checkedAt === 'number' && Number.isFinite(f.checkedAt) && derived.now - f.checkedAt > 60000;
      const checked = !kind && stale ? `checked ${ago(derived.now, f.checkedAt)}` : '';
      // A low phone battery carries its mark on the battery row.
      const low = !kind && extra.low && /batter/i.test(String(f.label || ''));
      return [f.label, f.value, when, low ? 'low' : kind, checked];
    }).filter(Boolean).concat(extra.rows);
    const actions = thing.freshness === 'fresh' && Array.isArray(thing.actions) ? thing.actions : [];
    const tone = thing.status === 'unknown' ? `${securityUnknowns().get(thing.id) || ''}/${thing.reason || ''}` : '';
    const next = JSON.stringify([layout, thing.id, thing.name, thing.status, thing.freshness, tone, copy, where, cam, facts, extra, actions.map((a) => [a.id, a.label])]);
    if (next === sig.card) return;
    const sameThing = card.dataset.id === thing.id;
    const focusedAction = sameThing && card.contains(doc.activeElement) ? doc.activeElement.dataset.action || doc.activeElement.dataset.role : null;
    sig.card = next;
    card.dataset.id = thing.id;
    card.dataset.status = thing.status;
    card.dataset.freshness = thing.freshness;
    card.dataset.kind = thing.kind;
    card.setAttribute('aria-label', thing.name || 'Details');

    const head = el('header', 'hv-card-head');
    const mark = glyphFor(thing, {});
    mark.classList.add('hv-glyph--head');
    const titles = el('div', 'hv-card-titles');
    titles.append(el('h2', 'hv-card-title', thing.name || thing.id));
    if (where || (cam && cam.indoor)) {
      const line = el('p', 'hv-card-where');
      if (where) line.append(el('span', 'hv-card-where-text', where));
      if (cam && cam.indoor) line.append(el('span', 'hv-tag', 'Indoor'));
      titles.append(line);
    }
    const close = button('hv-close', 'Close');
    close.dataset.role = 'close';
    close.append(icon('x'));
    close.addEventListener('click', () => userSelect(null));
    head.append(mark, titles, close);

    const body = el('div', 'hv-card-body');
    if (copy.value) {
      const value = el('p', copy.quiet ? 'hv-card-value hv-card-value--quiet' : 'hv-card-value');
      const word = el('span', 'hv-card-word');
      word.append(rich(copy.value));
      value.append(word);
      if (copy.since) {
        const since = el('span', 'hv-card-since');
        since.append(rich(copy.since));
        value.append(' ', since);
      }
      body.append(value);
    }
    if (cam && cam.feed) {
      // The raw frame, so the projection in the model can always be checked against it.
      const fig = el('figure', 'hv-feed');
      if (getFeedCanvas) {
        const frame = el('div', 'hv-feed-frame');
        if (feedReady) frame.dataset.ready = '1';
        feedCanvas.setAttribute('aria-label', `Picture from ${thing.name || 'the camera'}`);
        frame.append(feedCanvas, el('span', 'hv-feed-wait', 'Waiting for the picture'));
        fig.append(frame);
      }
      const cap = el('figcaption', 'hv-feed-caption');
      const tag = el('span', 'hv-tag', cam.feed.simulated ? 'Simulated feed' : 'Live');
      tag.dataset.tone = cam.feed.simulated ? 'simulated' : 'live';
      cap.append(tag);
      if (cam.feed.age) {
        const when = el('span', 'hv-feed-age');
        when.append(rich(cam.feed.age));
        cap.append(when);
      }
      fig.append(cap);
      body.append(fig);
    }
    if (extra.media) body.append(el('p', 'hv-card-media', extra.media));
    if (extra.progress) {
      const wrap = el('div', 'hv-progress');
      wrap.dataset.tone = extra.progress.tone;
      const track = el('div', 'hv-progress-track');
      track.setAttribute('role', 'progressbar');
      track.setAttribute('aria-valuemin', '0');
      track.setAttribute('aria-valuemax', '100');
      track.setAttribute('aria-valuenow', String(extra.progress.percent));
      track.setAttribute('aria-label', 'Progress');
      const fill = el('div', 'hv-progress-fill');
      fill.style.width = `${extra.progress.percent}%`;
      track.append(fill);
      wrap.append(track);
      if (extra.progress.left) {
        const left = el('p', 'hv-progress-left');
        left.append(rich(extra.progress.left));
        wrap.append(left);
      }
      body.append(wrap);
    }
    if (extra.phone) {
      const line = el('p', 'hv-card-phone');
      const words = el('span', 'hv-card-phone-text', extra.phone.text);
      if (extra.phone.level) words.append(el('span', 'hv-card-phone-level', `, ${extra.phone.level}`));
      const lines = el('span', 'hv-card-phone-lines');
      lines.append(words);
      if (extra.phone.seen) {
        const seen = el('span', 'hv-card-phone-seen');
        seen.append(rich(extra.phone.seen));
        lines.append(seen);
      }
      line.append(icon('phone'), lines);
      body.append(line);
    }
    if (copy.note) body.append(el('p', 'hv-card-note', copy.note));

    if (facts.length) {
      const dl = el('dl', 'hv-facts');
      for (const [label, value, when, kind, checked] of facts) {
        const lastKnown = kind === 'last';
        const low = kind === 'low';
        // unknown: there is no value at all; lastKnown: an old value that may no longer be true.
        const row = el('div', lastKnown ? 'hv-fact hv-fact--last-known' : kind === 'unknown' ? 'hv-fact hv-fact--unknown' : 'hv-fact');
        const dt = el('dt', 'hv-fact-label', label);
        const dd = el('dd', 'hv-fact-value');
        const v = el('span', 'hv-fact-text');
        if (lastKnown) v.append('Last known: ');
        v.append(rich(value == null || value === '' ? 'No data' : value));
        dd.append(v);
        if (low) {
          const mark = el('span', 'hv-fact-mark');
          mark.append(icon('battery-low'));
          dd.prepend(mark);
        }
        if (when) {
          const a = el('span', 'hv-fact-age');
          a.append(rich(when));
          dd.append(a);
        }
        if (checked) {
          const c = el('span', 'hv-fact-age hv-fact-checked');
          c.append(rich(checked));
          dd.append(c);
        }
        row.append(dt, dd);
        dl.append(row);
      }
      body.append(dl);
    }

    card.replaceChildren(head, body);

    if (actions.length) {
      const bar = el('div', 'hv-actions');
      actions.forEach((a, i) => {
        const b = button(i === 0 ? 'hv-btn hv-btn--primary' : 'hv-btn');
        b.dataset.action = a.id;
        b.textContent = a.label;
        b.addEventListener('click', () => emit('action', a.call));
        bar.append(b);
      });
      card.append(bar);
    }

    if (focusedAction) {
      const target = card.querySelector(`[data-action="${CSS.escape(focusedAction)}"], [data-role="${CSS.escape(focusedAction)}"]`);
      if (target) target.focus({ preventScroll: true });
    }
  }

  // ---- markers ---------------------------------------------------------------
  /** @type {Map<string, { el: HTMLElement, key: string, x: number, y: number, visible: boolean|null, leaving: number }>} */
  const markers = new Map();
  let markerPx = 0;          // drawn size of a full marker; measured lazily, reset on layout change

  function markerWanted(thing) {
    if (!thing || thing.kind === 'house' || !MARKER_STATUSES.has(thing.status)) return false;
    // A camera that merely sees motion is a calm cue in the model (its view wedge), not a marker
    // that would blink on and off with every passer-by.
    return !(thing.kind === 'camera' && thing.status === 'on');
  }
  // Reality view: every camera with a picture gets a small steady mark, so its raw frame is one
  // tap away. It does not come and go with motion, so it does not blink.
  function feedMarkerWanted(thing) {
    return view === 'reality' && !!feedOf(thing) && layout !== 'tv';
  }

  function renderMarkers() {
    // Offline and connecting: no markers. The banner and the frozen model say it once.
    const wanted = new Map();
    if (isLive()) {
      for (const thing of Object.values(derived.things)) if (markerWanted(thing) || feedMarkerWanted(thing)) wanted.set(thing.id, thing);
    }
    for (const [id, m] of markers) {
      if (!wanted.has(id)) removeMarker(id, m);
    }
    const bold = true;   // markers always use the Bold weight (brief section 7)
    const sec = securityUnknowns();
    for (const [id, thing] of wanted) {
      const isSelected = id === selected;
      const stateful = markerWanted(thing);          // else it is here only for its picture
      const hasFeed = !!feedOf(thing);
      const key = [thing.status, thing.freshness, thing.kind === 'door' ? `${thing.open}/${thing.locked}` : '', thing.alert || '', layout,
        thing.status === 'unknown' ? `${sec.get(id) || ''}/${thing.reason || ''}` : '', stateful ? '' : 'feed-only', hasFeed ? 'feed' : ''].join('|');
      let m = markers.get(id);
      if (m && m.leaving) { clearTimeout(m.leaving); m.el.remove(); markers.delete(id); m = null; }
      if (!m) {
        const b = button('hv-marker');
        b.dataset.id = id;
        b.addEventListener('click', () => userSelect(id));
        b.classList.add('is-hidden');
        markersLayer.append(b);
        m = { el: b, key: '', x: NaN, y: NaN, visible: null, leaving: 0, full: true };
        markers.set(id, m);
        if (firstUpdateDone && thing.status === 'alert') b.classList.add('is-arriving');
        // Appear: opacity 0 → 1, scale 0.9 → 1 over 240 ms.
        win.requestAnimationFrame(() => b.classList.add('is-in'));
      }
      if (m.key !== key) {
        m.key = key;
        m.el.dataset.status = stateful ? thing.status : 'feed';
        m.el.dataset.kind = thing.kind;
        if (hasFeed) m.el.dataset.feed = 'live'; else delete m.el.dataset.feed;
        // Anything merely "on" (a lamp, a running washer, a charging car) is a small quiet dot and
        // not a tab stop; only attention, alert and unknown get a full marker.
        m.full = stateful && thing.status !== 'on';
        m.el.tabIndex = m.full ? 0 : -1;
        m.el.style.zIndex = String((stateful && MARKER_Z[thing.status]) || 1);
        const body = el('span', 'hv-marker-body');
        if (stateful) {
          body.append(glyphFor(thing, { bold, plate: thing.status !== 'on' }));
          if (hasFeed) {
            // A full marker keeps its state shape; the picture mark rides on its corner.
            const badge = el('span', 'hv-marker-feed');
            badge.append(icon('live-picture', 'bold'));
            body.append(badge);
          }
        } else {
          body.append(glyph('feed', 'live-picture', { bold, plate: true }));
        }
        m.el.replaceChildren(body);
      }
      m.el.setAttribute('aria-label', `${thing.name}: ${thing.text || thing.status}${hasFeed ? ', live picture' : ''}`);
      m.el.classList.toggle('is-selected', isSelected);
    }
  }

  function removeMarker(id, m) {
    if (m.leaving) return;
    m.el.classList.remove('is-in');     // opacity only, 160 ms
    m.el.disabled = true;
    m.leaving = win.setTimeout(() => {
      m.el.remove();
      if (markers.get(id) === m) markers.delete(id);
    }, 180);
  }

  function placeMarkers(project) {
    if (destroyed || typeof project !== 'function') return;
    const full = [];
    for (const [id, m] of markers) {
      if (m.leaving) continue;
      const p = project(id);
      m.p = p && p.visible && Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null;
      m.fan = 0;
      if (m.p && m.full) full.push(m);
    }
    // Full markers that land on the same spot are fanned apart sideways so each stays readable.
    if (full.length > 1) {
      if (!markerPx) {
        const g = full[0].el.querySelector('.hv-glyph');
        markerPx = (g && g.offsetWidth) || 32;
      }
      const step = markerPx + 4;
      const seen = new Set();
      for (const a of full) {
        if (seen.has(a)) continue;
        const group = full.filter((b) => !seen.has(b) && Math.hypot(b.p.x - a.p.x, b.p.y - a.p.y) < FAN_NEAR);
        for (const b of group) seen.add(b);
        if (group.length < 2) continue;
        group.sort((b, c) => (b.p.x - c.p.x) || (b.el.dataset.id < c.el.dataset.id ? -1 : 1));
        const cx = group.reduce((s, b) => s + b.p.x, 0) / group.length;
        group.forEach((b, i) => { b.fan = cx + (i - (group.length - 1) / 2) * step - b.p.x; });
      }
    }
    for (const m of markers.values()) {
      if (m.leaving) continue;
      const p = m.p;
      const visible = !!p;
      if (visible) {
        // Half-pixel snapping keeps thin strokes crisp without visible stepping.
        const x = Math.round((p.x + m.fan) * 2) / 2;
        const y = Math.round(p.y * 2) / 2;
        if (x !== m.x || y !== m.y) {
          m.x = x; m.y = y;
          m.el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        }
      }
      if (visible !== m.visible) {
        m.visible = visible;
        m.el.classList.toggle('is-hidden', !visible);
      }
    }
    placeLabels(project);
  }

  // ---- room labels: quiet annotation on the drawing --------------------------------
  /** @type {Map<string, { el: HTMLElement, room: any, sig: string, x: number, y: number, shown: boolean|null }>} */
  const labels = new Map();
  for (const r of Array.isArray(plan.rooms) ? plan.rooms : []) {
    const node = el('span', 'hv-room-label is-hidden');
    node.dataset.room = r.id;
    labelsLayer.append(node);
    labels.set(r.id, { el: node, room: r, sig: '', x: NaN, y: NaN, shown: null });
  }
  // Bigger rooms are labelled first; a small room's name gives way rather than overprint a neighbour's.
  const labelOrder = [...labels.values()].sort((a, b) => (b.room.area || 0) - (a.room.area || 0));

  function renderLabels() {
    for (const [id, l] of labels) {
      const t = derived.things[id];
      const name = (t && t.name) || l.room.name || '';
      // A temperature is a claim: only while live, only when the room reports a number, never outdoors.
      const temp = isLive() && t && !l.room.outdoor && typeof t.temperature === 'number' && Number.isFinite(t.temperature)
        ? formatTemp(t.temperature, t.temperatureUnit || undefined) : '';
      const next = `${name}|${temp}`;
      if (next === l.sig) continue;
      l.sig = next;
      l.half = null;
      l.el.replaceChildren(el('span', 'hv-room-name', name));
      if (temp) {
        const v = el('span', 'hv-room-temp');
        v.append(rich(temp));
        l.el.append(v);
      }
    }
  }

  function carParkedIn(roomId) {
    if (!derived || !Array.isArray(plan.objects)) return false;
    return plan.objects.some((o) => o.role === 'vehicle' && o.room === roomId && derived.things[o.id] && derived.things[o.id].present === true);
  }

  function labelsWanted() {
    if (!derived) return false;
    // Phone: dropped. On the real model at 390 px the rooms are too small; even with the sheet
    // collapsed the labels ran into each other and into the lamps.
    return layout !== 'phone';
  }

  function placeLabels(project) {
    const wanted = labelsWanted();
    const small = hv.dataset.tier === 'compact';
    // Full markers that are on screen: a label never sits under one.
    const busy = [];
    const dots = [];
    if (wanted) for (const m of markers.values()) if (m.visible && !m.leaving) (m.full ? busy : dots).push(m);
    const placed = [];
    for (const l of labelOrder) {
      // A parked car fills its room on the drawing: the name would sit on the car.
      let show = wanted && l.room.level === level && !(small && l.room.area < 8) && !carParkedIn(l.room.id);
      if (show) {
        const p = project(l.room.id);
        show = !!(p && p.visible && Number.isFinite(p.x) && Number.isFinite(p.y));
        if (show) {
          const x = Math.round(p.x);
          let y = Math.round(p.y);
          // Measured once per text change: half the label's drawn width.
          if (l.half == null) {
            // Name and temperature are stacked, so the label is as wide as its widest line.
            let w = 0;
            let h = 0;
            for (const c of l.el.children) { w = Math.max(w, c.offsetWidth); h += c.offsetHeight; }
            l.half = w ? w / 2 : 36;
            // Half the drawn height (it grows with the type size: tablet, TV).
            l.tall = h ? Math.max(9, h / 2 + 1) : l.el.children.length > 1 ? 16 : 9;
          }
          for (const m of busy) {
            const dx = Math.abs(m.x - x);
            const dy = Math.abs(m.y - y);
            // Within about 40 px of the anchor, or anywhere under the text itself.
            if (Math.hypot(dx, dy) < LABEL_CLEAR) { show = false; break; }
          }
          // Slide the label to the nearest spot where its text box is clear of every dot and
          // every full marker, or leave it out rather than overprint.
          if (show) {
            const r = (markerPx || 32) / 2;
            const clear = (yy) => dots.every((d) => Math.abs(d.x - x) > l.half + 10 || Math.abs(d.y - yy) > l.tall + 8)
              && busy.every((m) => Math.abs(m.x - x) > l.half + r + 4 || Math.abs(m.y - yy) > l.tall + r + 4)
              && placed.every((q) => Math.abs(q.x - x) > q.half + l.half + 6 || Math.abs(q.y - yy) > q.tall + l.tall + 2);
            const spot = [0, 20, -20, 36, -36].find((dy) => clear(y + dy));
            if (spot === undefined) show = false; else y += spot;
          }
          if (show) placed.push({ x, y, half: l.half, tall: l.tall });
          if (show && (x !== l.x || y !== l.y)) {
            l.x = x; l.y = y;
            l.el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
          }
        }
      }
      if (show !== l.shown) {
        l.shown = show;
        l.el.classList.toggle('is-hidden', !show);
      }
    }
  }

  // ---- floors -----------------------------------------------------------------
  function syncFloors() {
    for (const [id, b] of floorButtons) b.setAttribute('aria-pressed', id === level ? 'true' : 'false');
  }

  floors.addEventListener('keydown', (e) => {
    const up = e.key === 'ArrowUp' || e.key === 'ArrowRight';
    const down = e.key === 'ArrowDown' || e.key === 'ArrowLeft';
    if (!up && !down) return;
    const i = plan.levels.findIndex((l) => l.id === level);
    const next = plan.levels[i + (up ? 1 : -1)];
    if (!next) return;
    e.preventDefault();
    userLevel(next.id);
    floorButtons.get(next.id).focus({ preventScroll: true });
  });

  // ---- theme button -------------------------------------------------------------
  function syncThemeButton() {
    const target = theme === 'night' ? 'day' : 'night';
    if (themeBtn.dataset.target === target) return;
    themeBtn.dataset.target = target;
    themeBtn.setAttribute('aria-label', `Switch to ${target} theme`);
    themeBtn.title = `Switch to ${target} theme`;
    themeBtn.replaceChildren(icon(target === 'day' ? 'sun' : 'moon'));
  }
  themeBtn.addEventListener('click', () => {
    const next = theme === 'night' ? 'day' : 'night';
    setTheme(next);
    emit('theme', next);
  });

  // ---- phone sheet --------------------------------------------------------------
  grabber.addEventListener('click', () => {
    collapsed = !collapsed;
    syncGeometry();
  });

  // ---- geometry: what the panels cover -------------------------------------------
  function px(v) { return Math.max(0, Math.round(v)); }

  function measureInsets() {
    const W = hv.clientWidth;
    const H = hv.clientHeight;
    if (!hv.isConnected || !W || !H) return { ...ZERO };
    const open = cardIsOpen();
    const bannerBottom = banner.hidden ? 0 : banner.offsetTop + banner.offsetHeight;
    if (layout === 'phone') {
      const top = Math.max(strip.offsetTop + strip.offsetHeight, bannerBottom);
      const bottom = open ? card.offsetHeight : sheetVisibleHeight();
      return { top: px(top), right: 0, bottom: px(bottom), left: 0 };
    }
    if (layout === 'tv') {
      // Overscan on three sides; the clock block (and the attention block beside it) below.
      const blockTop = Math.min(strip.offsetTop, attentionEl ? attentionEl.offsetTop : H);
      return { top: px(Math.max(H * 0.05, bannerBottom)), right: px(W * 0.05), bottom: px(H - blockTop), left: px(W * 0.05) };
    }
    if (layout === 'tablet') {
      // The clock block (top-left) and the attention list (bottom-left) are real covered edges:
      // a cut-open house seen from above is wider than tall, so giving up height costs it the
      // least, and the thing that needs attention is never hidden behind its own list.
      const margin = strip.offsetLeft;
      const dockW = dock.hidden ? 0 : dock.offsetWidth;
      const switcher = dockW ? margin * 2 + dockW : margin;
      const right = open ? margin + card.offsetWidth + (dockW ? 16 + dockW : 0) : switcher;
      const top = Math.max(strip.offsetTop + strip.offsetHeight, bannerBottom);
      const bottom = attentionEl ? H - attentionEl.offsetTop : 0;
      return { top: px(top), right: px(right), bottom: px(bottom), left: px(margin) };
    }
    // desktop
    const top = Math.max(strip.offsetTop + strip.offsetHeight, bannerBottom);
    // The strip above; the attention list as a covered left edge whenever it is shown; the card
    // as a covered right edge when open. The floor switcher (bottom centre) just floats.
    const right = open ? W - card.offsetLeft : 0;
    const left = attentionEl ? attentionEl.offsetLeft + attentionEl.offsetWidth : 0;
    return { top: px(top), right: px(right), bottom: 0, left: px(left) };
  }

  function sheetVisibleHeight() {
    return sheet.offsetHeight;   // the collapsed sheet is simply shorter
  }

  function syncGeometry() {
    if (destroyed) return;
    if (layout === 'phone' && hv.isConnected) {
      const canCollapse = !!attentionEl;
      if (!canCollapse) collapsed = false;
      // Collapsed: the list is not drawn, leaving the grabber and the one summary line.
      hv.classList.toggle('is-collapsed', collapsed);
      // An open card is the sheet's detail state: one surface. The list sheet is not drawn at all.
      sheet.hidden = cardIsOpen();
      grabber.setAttribute('aria-label', collapsed ? 'Expand list' : 'Collapse list');
      grabber.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      grabber.disabled = !canCollapse;
    } else {
      sheet.hidden = false;
      hv.classList.remove('is-collapsed');
    }
    // Tablet: the card hangs below the glance block (temperatures, date, who is home).
    if (layout === 'tablet' && hv.isConnected) {
      hv.style.setProperty('--card-top', `${Math.round(strip.offsetTop + aside.offsetTop + aside.offsetHeight + 16)}px`);
    } else {
      hv.style.removeProperty('--card-top');
    }
    const next = measureInsets();
    hv.style.setProperty('--covered-bottom', `${next.bottom}px`);
    hv.style.setProperty('--covered-right', `${next.right}px`);
    if (next.top !== insets.top || next.right !== insets.right || next.bottom !== insets.bottom || next.left !== insets.left) {
      insets = next;
      emit('insets');
    }
  }

  function getInsets() {
    insets = measureInsets();
    return { ...insets };
  }

  // ---- global listeners ------------------------------------------------------------
  function onKey(e) {
    if (e.key === 'Escape' && cardIsOpen()) {
      e.preventDefault();
      userSelect(null);
    }
  }
  function onResize() {
    if (destroyed) return;
    if (applyLayout()) {
      sig.headline = sig.attention = sig.card = sig.strip = sig.people = '';
      banner.dataset.text = '';
      for (const m of markers.values()) m.key = '';
      markerPx = 0;
      if (derived) render();
    }
    syncGeometry();
  }
  doc.addEventListener('keydown', onKey);
  win.addEventListener('resize', onResize);
  for (const q of [mq.narrow, mq.landscapePhone, mq.tv, mq.fine]) q.addEventListener('change', onResize);
  // The font changes every measurement; re-measure once it has loaded.
  if (doc.fonts && doc.fonts.ready) doc.fonts.ready.then(() => { if (!destroyed) syncGeometry(); });

  function destroy() {
    destroyed = true;
    doc.removeEventListener('keydown', onKey);
    win.removeEventListener('resize', onResize);
    for (const q of [mq.narrow, mq.landscapePhone, mq.tv, mq.fine]) q.removeEventListener('change', onResize);
    for (const m of markers.values()) if (m.leaving) clearTimeout(m.leaving);
    markers.clear();
    clearIdle();
    syncFeed(null);
    hv.remove();
    listeners.clear();
  }

  // ---- first paint -------------------------------------------------------------------
  applyLayout();
  doc.documentElement.dataset.theme = theme;
  syncThemeButton();
  syncFloors();
  syncView();
  preloadIcons(ICONS_USED);

  return { update, setSelected, setLevel, setTheme, setView, getInsets, placeMarkers, on, destroy };
}
