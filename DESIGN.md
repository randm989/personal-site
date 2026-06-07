# DESIGN.md — Josh's personal site

> **Status: LOCKED (2026-06-07).** Direction, type, palette, color strategy, theme, and the
> motion/lighting language are decided. Changes from here are deliberate, not exploratory.

register: brand

## Direction — "Tempered"

Grounded, warm, substantial. Bold and declarative without going cold or trendy. Carries the
weight of Josh's responsibility thesis and his game heroes (11 bit). Confident, human, like a
well-made tool.

## Design language — clean baseline, with motion + lighting + interaction

### Clean is the baseline (non-negotiable)

**No texture.** No grain, noise, paper texture, or busy patterns; visual noise reads as clumsy.
Crisp geometric forms, flat fills, pure-CSS precision. Josh's *clean* references:
uiverse `Codewithvinay/orange-earwig-38`, `Shoh2008/ugly-elephant-80`, and a layered-gradient
"matrix" spinner (three crisp bars from stacked `linear-gradient`s + a precise
`background-position` keyframe, monochrome, zero texture). These show the **baseline aesthetic**,
not the lighting. Clean *motion* is welcome: simple, geometric, exact, elegant.

```css
/* the spinner Josh cited — clean motion as a reference, not for use as-is */
.loader{width:45px;height:40px;
  background:linear-gradient(#0000 calc(1*100%/6),#fff 0 calc(3*100%/6),#0000 0),
             linear-gradient(#0000 calc(2*100%/6),#fff 0 calc(4*100%/6),#0000 0),
             linear-gradient(#0000 calc(3*100%/6),#fff 0 calc(5*100%/6),#0000 0);
  background-size:10px 400%;background-repeat:no-repeat;animation:matrix 1s infinite linear}
@keyframes matrix{0%{background-position:0% 100%,50% 100%,100% 100%}
  100%{background-position:0% 0%,50% 0%,100% 0%}}
```

### Layered on the clean base — three emphases (Josh's direction)

These are what the site *emphasizes*; they are tuned in detail at the `emil` step.

- **Motion.** Smooth, earned, geometric. Lifts, scale, parallax tilt, clean keyframed forms.
  Ease-out (quart / expo), no bounce, no elastic. Never animate layout properties.
- **Lighting.** Elevation is *light*, not borders or texture: soft low-chroma shadows tinted
  warm. Interactive things *light up* with a soft deep-green glow on hover/focus (restrained,
  never neon). A soft highlight can follow the cursor across interactive surfaces ("lit by your
  attention"). Gradients are illumination only, never gradient text (banned).
- **Interaction.** Things respond. The motif from the first mockup, recast as light and clean
  motion rather than wobble. Craft, not comedy.

### Elevation / panels — soft light, generous rounding (Josh reference)

Josh cited a neumorphic card: flat fill, big radius, soft dual-tone shadow (light top-left,
shadow bottom-right), no texture. That is the panel language: **depth from light.** Translate
the cold gray to the warm Tempered palette, and keep rounding generous.

```css
/* Josh's reference (cold) */
.card{border-radius:50px;background:#e0e0e0;
  box-shadow:20px 20px 60px #bebebe,-20px -20px 60px #ffffff}

/* warm Tempered translation — light mode */
.panel{border-radius:24px;background:var(--paper);
  box-shadow:18px 18px 44px oklch(0.90 0.012 75 / .8), -14px -14px 36px oklch(0.99 0.006 80 / .9)}
/* dark mode */
[data-theme="dark"] .panel{
  box-shadow:16px 16px 40px oklch(0.15 0.01 55 / .7), -14px -14px 34px oklch(0.27 0.014 55 / .6)}
```

**Guardrail:** soft-shadow elevation is for *surfaces* (panels, cards). Never push text,
labels, or controls into low-contrast neumorphic insets. Readability and the restrained-green
accent stay crisp on top of the soft surfaces.

## Theme — system-driven, with a manual switch (decided)

Default follows `prefers-color-scheme`. A visible toggle lets the visitor override. Both modes
share one semantic token set (below), so every component and the lighting render correctly in
either. Light text on dark: add 0.05 to line-height.

## Typography (locked)

- **Display:** Bricolage Grotesque (Google Fonts) — weights 500/600/700, tracking -0.015em.
  A confident grotesque with character. Not on any reflex-reject list.
- **Body:** Hanken Grotesk (Google Fonts) — 400/500/600.
- **Scale** (modular, ~1.3 ratio, fluid where it matters):
  | Role | Size | Notes |
  |---|---|---|
  | h1 | `clamp(36px, 6.4vw, 58px)` | display, 1.04 line-height |
  | h2 / big | `clamp(22px, 3.4vw, 30px)` | display, 1.3 |
  | h3 | 21px | display |
  | lede | 19–20px | body, 1.55 |
  | body | 17px | body, 1.6, max 62ch |
  | label / small | 12.5–14px | 0.06em tracking, uppercase for kickers |
- Body line length capped 62–72ch.

## Color — Restrained accent (locked strategy)

Tinted warm neutrals carry the site. The **deep-green accent (Josh's favorite, doubles as the
garden green) appears sparingly**: section kickers, links, focus rings, the lighting glow, and
the single key CTA. Headlines stay ink. Never `#000`/`#fff`; every neutral tinted warm. OKLCH.

### Light mode
| Token | OKLCH | Role |
|---|---|---|
| `--paper` | `oklch(0.972 0.004 80)` | near-neutral warm off-white |
| `--paper-2` | `oklch(0.946 0.005 80)` | raised surface |
| `--ink` | `oklch(0.23 0.016 55)` | primary text |
| `--ink-soft` | `oklch(0.46 0.016 55)` | body text |
| `--ink-faint` | `oklch(0.63 0.012 60)` | metadata |
| `--line` | `oklch(0.89 0.006 80)` | hairlines |
| `--accent` | `oklch(0.45 0.11 152)` | deep forest green |
| `--accent-ink` | `oklch(0.98 0.01 150)` | text on green |
| `--glow` | `oklch(0.55 0.13 152 / 0.35)` | hover/focus halo |

### Dark mode
| Token | OKLCH | Role |
|---|---|---|
| `--paper` | `oklch(0.205 0.006 60)` | near-neutral warm near-black |
| `--paper-2` | `oklch(0.255 0.008 60)` | raised surface |
| `--ink` | `oklch(0.93 0.008 78)` | primary text |
| `--ink-soft` | `oklch(0.75 0.012 72)` | body text |
| `--ink-faint` | `oklch(0.56 0.012 65)` | metadata |
| `--line` | `oklch(0.32 0.01 60)` | hairlines |
| `--accent` | `oklch(0.66 0.13 155)` | brightened green |
| `--accent-ink` | `oklch(0.16 0.02 150)` | text on green |
| `--glow` | `oklch(0.70 0.14 155 / 0.40)` | hover/focus halo |

## Reference artifacts

- Locked look + lighting/motion demo: [`docs/specs/2026-06-07-tempered-locked.html`](docs/specs/2026-06-07-tempered-locked.html)
- Three-direction comparison (history): [`docs/specs/2026-06-07-aesthetic-lock.html`](docs/specs/2026-06-07-aesthetic-lock.html)
- Original motion motif: [`docs/specs/2026-06-06-personal-site-mockup.html`](docs/specs/2026-06-06-personal-site-mockup.html)
