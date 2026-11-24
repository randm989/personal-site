// The brain seam, reading side: what the view currently shows, as data (describeJSON) and as words (describe).
// Both read only Derived and the compiled plan, so they cannot say anything the view does not show, and
// they are honest in the same way: what is unknown, stale or unsensed is listed apart and never given a value.
// No entity ids appear anywhere in the output.

import { formatDuration, formatClock, formatTemp, formatPercent, formatRemaining } from '../state/format.js';

/**
 * @param {object} derived  Derived (CONTRACTS §2)
 * @param {object} plan     CompiledPlan
 * @returns {object} structured digest
 */
export function describeJSON(derived, plan) {
  if (!derived || !derived.things) throw new Error('describe: no derived state yet');
  const now = derived.now;
  const things = Object.values(derived.things);
  const live = derived.connection === 'live';
  const age = (since) => (since == null ? null : formatDuration(now - since));
  const roomFor = roomResolver(plan);

  const attention = derived.attention.map((a) => ({ id: a.id, severity: a.severity, text: a.text, age: age(a.since), room: a.room, level: a.level }));

  /** room id → entry */
  const roomEntries = new Map();
  const levels = (plan.levels || []).map((l) => ({ id: l.id, name: l.name || l.id, rooms: [], other: [] }));
  const levelById = new Map(levels.map((l) => [l.id, l]));
  for (const t of things) {
    if (t.kind !== 'room') continue;
    const entry = {
      id: t.id, name: t.name,
      temperature: t.temperature == null ? null : formatTemp(t.temperature, t.temperatureUnit || '°C'),
      humidity: t.humidity == null ? null : `${Math.round(t.humidity)}%`,
      occupied: t.occupied, motion: t.motion == null ? null : t.motion, hvac: t.hvac, alert: t.alert,
      lightsOn: [], items: [],
    };
    roomEntries.set(t.id, entry);
    const level = levelById.get(t.levelId);
    if (level) level.rooms.push(entry);
  }

  const unknown = [];
  const unsensed = [];
  const cameras = [];
  const roomNames = new Map(things.filter((t) => t.kind === 'room').map((t) => [t.id, t.name]));
  // People: where each phone is (it is the phone's location, and is worded that way), and low batteries.
  const people = (derived.people || []).map((p) => ({
    id: p.id, name: p.name, home: p.home,
    room: p.room, roomName: p.room ? (p.roomName || roomNames.get(p.room) || p.room) : null,
    level: p.levelId == null ? null : p.levelId,
    levelName: p.levelId != null && levelById.get(p.levelId) ? levelById.get(p.levelId).name : null,
    battery: p.battery == null ? null : formatPercent(p.battery),
    charging: p.charging == null ? null : p.charging,
    batteryLow: !!p.batteryLow,
    since: p.home == null ? null : age(p.since),
    freshness: p.freshness,
    roomTracked: (p.facts || []).some((f) => f.label === 'Phone'),     // a room sensor exists for this phone
  }));
  for (const t of things) {
    if (t.kind === 'house') continue;
    if (t.freshness === 'unsensed') { unsensed.push({ id: t.id, kind: t.kind, name: t.name }); continue; }
    if (t.freshness !== 'fresh') unknown.push(unknownEntry(t, now));
    if (t.kind === 'room') continue;
    // A claim is repeated only when the view itself makes it: the thing is fresh, or one of its roles
    // still makes a live attention claim (an open door whose lock has gone quiet is still open).
    const claims = t.freshness === 'fresh' || t.status === 'attention' || t.status === 'alert';
    if (!claims) continue;
    const room = roomEntries.get(roomFor(t));
    const level = levelById.get(t.levelId);
    if (t.kind === 'light') {
      if (t.on === true && room) room.lightsOn.push({ id: t.id, name: t.name, level: t.brightness == null ? null : formatPercent(t.brightness) });
      else if (t.on === true && level) level.other.push(item(t, age, true));
      continue;
    }
    if (t.kind === 'camera') {
      cameras.push({
        id: t.id, name: t.name, text: t.text, status: t.status,
        motion: t.motion, person: t.person, recording: t.recording,
        age: t.status === 'on' || t.status === 'attention' ? age(t.since) : null,
        lastMotion: t.motion === false ? age(t.lastMotionAt) : null,
        // Whether it has a picture, never where the picture is: feed addresses carry tokens and stay out of here.
        indoor: !!t.indoor,
        privacy: t.privacy === true,
        picture: t.privacy === true ? 'privacy' : !t.feed ? 'none' : t.feed.simulated ? 'simulated' : 'live',
      });
      continue;
    }
    // An idle appliance is not news; one that is running, paused, finished or failed is.
    if (t.kind === 'object' && t.running !== true && t.present == null && t.charging == null && (t.phase == null || t.phase === 'idle')) continue;
    const it = item(t, age, false);
    if (room) room.items.push(it);
    else if (level) level.other.push(it);
  }

  const kindTotals = {};
  for (const t of things) if (t.kind !== 'house') kindTotals[t.kind] = (kindTotals[t.kind] || 0) + 1;

  return {
    house: plan.name || 'House',
    time: formatClock(now),
    connection: derived.connection,
    showing: derived.snapshotAt == null ? null : formatClock(derived.snapshotAt),
    headline: derived.summary.headline,
    headlineStatus: derived.summary.headlineStatus,
    // Exterior doors and windows with no security sensor: why the headline may stop short of 'All secure'.
    unsensedExterior: (derived.summary.unsensedExteriorIds || []).map((id) => ({ id, name: derived.things[id] ? derived.things[id].name : id })),
    summary: live ? {
      lightsOn: derived.summary.lightsOn,
      openCount: derived.summary.openCount,
      people: derived.summary.people.map((p) => ({ name: p.name, home: p.home == null ? null : p.home })),
      alarm: derived.summary.alarm,
      outdoor: derived.summary.outdoor ? formatTemp(derived.summary.outdoor.value, derived.summary.outdoor.unit) : null,
      indoor: derived.summary.indoor ? formatTemp(derived.summary.indoor.value, derived.summary.indoor.unit) : null,
    } : null,
    attention,
    // Nothing about people or cameras is known while the link is down.
    people: live ? people : [],
    cameras: live ? cameras : [],
    levels: levels.map((l) => ({
      id: l.id, name: l.name,
      rooms: l.rooms.filter((r) => r.temperature || r.humidity || r.occupied === true || r.motion === true || (r.hvac && r.hvac !== "idle") || r.alert || r.lightsOn.length || r.items.length),
      other: l.other,
    })),
    unknown,
    unsensed,
    totals: kindTotals,
  };
}

function item(t, age, isLight) {
  let text = isLight ? (t.text || 'On') : t.text;
  if (t.kind === 'window' && t.blind != null && t.blind < 1 && !/^Blind/.test(text)) {
    text += `, blind ${t.blind <= 0 ? 'lowered' : `${formatPercent(t.blind)} raised`}`;
  }
  if (t.kind === 'object' && t.remainingMin != null && (t.phase === 'running' || t.phase === 'paused')) {
    text += `, about ${formatRemaining(t.remainingMin)} left`;
  }
  const notable = t.status === 'attention' || t.status === 'alert';
  const out = { id: t.id, kind: t.kind, name: t.name, text, status: t.status, age: notable ? age(t.since) : null };
  if (t.kind === 'object' && t.phase != null) {
    out.phase = t.phase;
    out.progress = t.progress == null ? null : formatPercent(t.progress);
    out.remaining = t.remainingMin == null ? null : formatRemaining(t.remainingMin);
    out.title = t.title == null ? null : t.title;
  }
  return out;
}

function unknownEntry(t, now) {
  const parts = [];
  const known = [];
  for (const f of t.facts) {
    if (f.lastKnown) parts.push(`${f.label.toLowerCase()} not heard from${f.checkedAt == null ? '' : ` for ${formatDuration(now - f.checkedAt)}`}`);
    else if (f.unknown) parts.push(`${f.label.toLowerCase()} ${f.value.toLowerCase()}${f.value === 'Offline' && f.at != null ? ` for ${formatDuration(now - f.at)}` : ''}`);
    else if (t.freshness !== 'offline' && f.value && f.label !== 'Lights') known.push(`${f.label.toLowerCase()} ${f.value.toLowerCase()}`);
  }
  return {
    id: t.id, kind: t.kind, name: t.name, freshness: t.freshness,
    reason: parts.join('; ') || t.text.toLowerCase(),
    stillKnown: known,            // readings from sibling sensors on the same thing that are still fresh
  };
}

/** Which room a thing is listed under. Openings sit between rooms: prefer an indoor one. */
function roomResolver(plan) {
  const outdoor = new Set((plan.rooms || []).filter((r) => r.outdoor).map((r) => r.id));
  const byOpening = new Map();
  for (const o of plan.openings || []) {
    const rooms = (o.rooms || []).filter(Boolean);
    byOpening.set(o.id, rooms.find((r) => !outdoor.has(r)) || rooms[0] || null);
  }
  return (t) => t.room || byOpening.get(t.id) || null;
}

const KIND_PLURAL = { room: 'rooms', door: 'doors', window: 'windows', light: 'lights', camera: 'cameras', object: 'appliances and vehicles' };

/** 'Josh home (phone in Game room, upper floor; phone battery low 12%)'. The room is the phone's, and says so. */
function personText(p) {
  const where = p.home == null ? 'unknown' : p.home ? 'home' : 'away';
  const extra = [];
  if (p.roomName) extra.push(`phone in ${p.roomName}${p.levelName ? `, ${p.levelName.toLowerCase()}` : ''}`);
  else if (p.home === true && p.roomTracked) extra.push('room not known');
  if (p.batteryLow) extra.push(`phone battery low${p.battery ? ` ${p.battery}` : ''}`);
  return `${p.name} ${where}${extra.length ? ` (${extra.join('; ')})` : ''}`;
}

/**
 * Plain-text digest for an LLM context window.
 * @returns {string}
 */
export function describe(derived, plan) {
  const d = describeJSON(derived, plan);
  const lines = [];
  lines.push(`${d.house}, ${d.time}. ${d.headline}.`);

  if (d.connection === 'offline') {
    lines.push(`The view is not connected to the home hub${d.showing ? `; state was last known at ${d.showing}` : ''}. Nothing about the house is known right now, so no states are reported.`);
  } else if (d.connection === 'connecting') {
    lines.push('The view is still connecting to the home hub. No states are known yet.');
  } else {
    const s = d.summary;
    const bits = [];
    if (d.people.length) {
      bits.push(`People: ${d.people.map(personText).join(', ')}.`);
    }
    if (s.alarm) bits.push(`Alarm: ${s.alarm.replace(/_/g, ' ')}.`);
    if (s.outdoor) bits.push(`Outdoor ${s.outdoor}.`);
    if (s.indoor) bits.push(`Indoor ${s.indoor} (median).`);
    bits.push(`${s.lightsOn} ${s.lightsOn === 1 ? 'light' : 'lights'} on.`);
    lines.push(bits.join(' '));
    if (d.unsensedExterior.length) {
      const n = d.unsensedExterior.length;
      if (d.headline === 'No security sensors') {
        lines.push(`None of the ${n} exterior doors and windows has a sensor, so nothing is known about whether the house is secure.`);
      } else {
        lines.push(`${n} exterior ${n === 1 ? 'opening has' : 'openings have'} no sensor: ${d.unsensedExterior.map((u) => u.name).join(', ')}. ${d.headline === 'Secure where sensed' ? 'Everything that is sensed is secure; these are not known.' : 'Their state is not known.'}`);
      }
    }

    const needs = d.attention.filter((a) => a.severity !== 'info');
    const notes = d.attention.filter((a) => a.severity === 'info');
    if (needs.length) {
      lines.push('', 'Needs attention:');
      for (const a of needs) {
        const tag = a.severity === 'alert' ? 'ALERT: ' : '';
        const when = a.age == null ? '' : a.severity === 'unknown' ? ` (last heard from ${a.age === 'just now' ? a.age : `${a.age} ago`})` : ` (${a.age === 'just now' ? a.age : `for ${a.age}`})`;
        lines.push(`- ${tag}${a.text}${when}`);
      }
    }
    if (notes.length) {
      // Listed for information; these never count toward the headline.
      lines.push('', 'For information (not a problem):');
      for (const a of notes) lines.push(`- ${a.text}${a.age == null || a.age === 'just now' ? '' : ` (${a.age} ago)`}`);
    }

    if (d.cameras.length) {
      const busy = d.cameras.filter((c) => c.person === true || c.motion === true);
      const shut = d.cameras.filter((c) => c.privacy);
      const clear = d.cameras.filter((c) => !busy.includes(c) && !c.privacy);
      const parts = busy.map((c) => `${c.name} ${c.person === true ? 'sees a person' : 'sees motion'}${c.age && c.age !== 'just now' ? ` (for ${c.age})` : ''}`);
      if (clear.length) parts.push(busy.length || clear.length < 3 ? `${clear.map((c) => c.name).join(', ')} clear` : `all ${clear.length} clear`);
      if (shut.length) parts.push(`${shut.map((c) => c.name).join(', ')} in privacy (lens shut, no picture)`);
      // Which of them the view has a picture from right now (reality view projects only these).
      const open = d.cameras.filter((c) => !c.privacy);
      const seen = open.filter((c) => c.picture !== 'none');
      const kind = seen.length && seen.every((c) => c.picture === 'simulated') ? 'simulated picture' : 'live picture';
      let pictures = '';
      if (seen.length) pictures = ` ${kind.charAt(0).toUpperCase() + kind.slice(1)}: ${seen.map((c) => (kind === 'live picture' && c.picture === 'simulated' ? `${c.name} (simulated)` : c.name)).join(', ')}.`;
      if (open.length > seen.length) pictures += ` No picture: ${open.filter((c) => c.picture === 'none').map((c) => c.name).join(', ')}.`;
      lines.push('', `Cameras: ${parts.join('; ')}.${pictures}`);
    }

    for (const level of d.levels) {
      if (!level.rooms.length && !level.other.length) continue;
      lines.push('', `${level.name}:`);
      for (const r of level.rooms) {
        const facts = [];
        if (r.alert) facts.push(`${r.alert.toUpperCase()} DETECTED`);
        if (r.temperature) facts.push(r.temperature);
        if (r.humidity) facts.push(`humidity ${r.humidity}`);
        if (r.occupied === true) facts.push('occupied');
        else if (r.motion === true) facts.push('motion');
        if (r.hvac && r.hvac !== 'idle') facts.push(r.hvac);
        if (r.lightsOn.length) facts.push(`lights on: ${r.lightsOn.map((l) => (l.level ? `${l.name} ${l.level}` : l.name)).join(', ')}`);
        for (const it of r.items) facts.push(itemText(it));
        lines.push(`- ${r.name}: ${facts.join('; ')}.`);
      }
      for (const it of level.other) lines.push(`- ${itemText(it)}.`);
    }
    lines.push('', 'Lights not listed are off.');

    if (d.unknown.length) {
      lines.push('', 'Not known (a sensor exists but is not reporting; no state is claimed):');
      for (const u of d.unknown) {
        lines.push(`- ${u.name}: ${u.reason}${u.stillKnown.length ? ` (still reporting: ${u.stillKnown.join(', ')})` : ''}`);
      }
    }
  }

  if (d.unsensed.length) {
    const groups = [];
    // Exterior openings already named above are not named a second time.
    const named = new Set(d.connection === 'live' && d.headline !== 'No security sensors' ? d.unsensedExterior.map((u) => u.id) : []);
    for (const kind of ['door', 'window', 'light', 'camera', 'object', 'room']) {
      const list = d.unsensed.filter((u) => u.kind === kind);
      if (!list.length) continue;
      const label = KIND_PLURAL[kind];
      const rest = list.filter((u) => !named.has(u.id));
      const above = list.length - rest.length;
      if (list.length === d.totals[kind] && list.length > 3 && !above) groups.push(`all ${list.length} ${label}`);
      else if (!rest.length) groups.push(`${label}: the ${above} exterior ${above === 1 ? 'one' : 'ones'} above`);
      else groups.push(`${label}: ${rest.map((u) => u.name).join(', ')}${above ? `, and the ${above} exterior ${above === 1 ? 'one' : 'ones'} above` : ''}`);
    }
    lines.push('', `No sensor installed (state cannot be known): ${groups.join('; ')}.`);
  }
  return lines.join('\n');
}

function itemText(it) {
  const text = it.text ? it.text.charAt(0).toLowerCase() + it.text.slice(1) : '';
  return `${it.name} ${text}${it.age && it.age !== 'just now' ? ` for ${it.age}` : ''}`.trim();
}
