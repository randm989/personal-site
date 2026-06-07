# DESIGN.md — Josh's personal site (provisional)

> **Status: provisional.** The full aesthetic lock (type scale, palettes, the motif's tuned
> values) is its own step *after* the narrative pass. This captures only what's already decided
> so design work doesn't drift. Do not treat the type/color sections as final.

register: brand

## Theme — system dark/light (decided)

Physical scene: *someone who could hire or back Josh reads this on a laptop or phone, in
whatever light they happen to be in, deciding in 30 seconds whether he's the real thing.*

That sentence forces the answer: **follow the visitor's system preference** (`prefers-color-scheme`),
meet them where they are. Editorial calm palette in both modes, defined as one semantic token
set (one source of truth) so every component and the motif render correctly in either mode.

## The motif — alive as craft (decided)

The site feels quietly alive: cursor companion, magnetic elements, card tilt toward cursor,
hover lifts, a few hidden discoveries. **Craft, not comedy** — it signals "he sweats the
details," never winks. The base renders fully with no JS; the motif is pure progressive
enhancement. Tuned intensity/spring values come from the mockup at lock time.

Reference: [`docs/specs/2026-06-06-personal-site-mockup.html`](docs/specs/2026-06-06-personal-site-mockup.html).

## Typography — PENDING aesthetic lock

Not chosen yet. Hard constraint when chosen: **avoid the editorial-typographic reflex lane**
(display serif italic + small mono labels + ruled separators) despite the "editorial" framing,
and avoid the reflex-reject font list (Fraunces, Newsreader, Cormorant, Inter, DM Sans, etc.).
The base is *editorial calm*, which is a stance, not that specific saturated look.

## Color — PENDING aesthetic lock

Not chosen yet. Strategy likely Restrained-to-Committed editorial neutrals tinted toward a
brand hue, with one accent for the motif (the mockup used a warm rust + a garden green as
placeholders). Decide against a named reference at lock time, per the brand playbook.
