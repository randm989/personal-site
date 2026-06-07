# MOTION.md — motion system (Emil pass)

> **Status: LOCKED (2026-06-07).** The motion language for the site, derived from Emil
> Kowalski's design-engineering principles. Pairs with [`../DESIGN.md`](../DESIGN.md) (look)
> and the motion/lighting language there. Reference build: the locked demo
> [`specs/2026-06-07-tempered-locked.html`](specs/2026-06-07-tempered-locked.html).

## Principle

Clean surfaces, alive through motion and light. Motion is **craft, not decoration**: every
animation has a purpose (feedback, entrance, light-tracking), stays under 300ms for UI, uses
strong custom easing, and never loops forever where it's seen constantly.

## Easing tokens

```css
--ease-out: cubic-bezier(0.23, 1, 0.32, 1);    /* enter, hover, feedback — the default */
--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1); /* on-screen movement / morphs */
```

Never `ease-in` on UI (feels sluggish). Color/theme transitions may use plain `ease`.

## Durations

| Element | Duration |
|---|---|
| Button press / feedback | ~120–180ms |
| Hover lifts, word lifts | 180–250ms |
| Panel hover (lift + glow) | 300–400ms |
| Entrance reveal | 550ms (staggered) |
| Theme switch (color crossfade) | 400ms `ease` |
| Switch knob | 350ms `--ease-out` |

## The motion set

- **Press feedback (global):** pressable things get `transform: translateY(-1px) scale(0.97)`
  on `:active`. Works on touch too.
- **Hover lifts (pointer only):** `.live` words, buttons, and panels lift on hover. All
  wrapped in `@media (hover:hover) and (pointer:fine)` so touch taps don't stick.
- **Unified button hover:** every button lifts and lights with a green glow; baselines differ
  by role (solid ink / outline / green), interaction is identical.
- **Cursor-light with momentum:** the panel's radial green highlight follows the pointer
  through a per-frame **lerp** (`+= (target - current) * 0.16`), never bound directly to the
  mouse. Springs in from center on enter (no corner jump). This is the "lit by your attention"
  motif, with life instead of stiffness.
- **Entrance choreography:** elements carry `.reveal` (opacity 0 + `translateY(12px)`), gain
  `.in` via `IntersectionObserver`. The hero staggers on load (70ms steps); sections rise as
  they enter the viewport. Stagger stays short; never blocks interaction.
- **Nav mark:** three geometric bars (a nod to the clean spinner reference). **Static by
  default** — it's seen on every page, so it does not loop. It bumps on `.brand:hover` with a
  small per-bar stagger.

## Rules (the bans)

- Only animate `transform` and `opacity` for movement (GPU; skips layout/paint).
- No `transition: all` — name the properties.
- Never animate from `scale(0)` — start `scale(0.95)` + opacity.
- No looping animation on anything seen constantly (nav, persistent UI).
- No bounce/elastic on UI. Springs (lerp) are for the decorative cursor-light only.
- `transform-origin` matches the trigger for any future popovers (modals stay centered).

## Accessibility

`@media (prefers-reduced-motion: reduce)`: drop movement (no transforms, no cursor-light),
keep fades, set `scroll-behavior: auto`, collapse transition durations. Motion is enhancement,
never required to use the site.
