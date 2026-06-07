# STICKMAN — the running stick figure (reusable character)

Josh's first character (sophomore project): an all-one-color stick figure with a hollow circle
head, vector-animated. He runs along a line, chases the cursor slowly, and waves when clicked.
This documents him as a **reusable, renderer-agnostic asset** so he can live anywhere on the
site and be ported into **Zipix** (Phaser/canvas).

## Files (single source of truth)

| File | Role |
|---|---|
| [`../lib/stickman.js`](../lib/stickman.js) | Canonical model + SVG renderer + DOM driver. `window.Stickman`. |
| [`../lib/stickman.config.json`](../lib/stickman.config.json) | Josh's tuned config (data of record; mirrors `Stickman.CONFIG`). |
| [`specs/2026-06-07-stickman-prototype.html`](specs/2026-06-07-stickman-prototype.html) | Tuning playground (consumes the module; live sliders). |

**The reusable core is the *model*, not the SVG:** `SKELETON` (proportions), `computePose`
(the animation math), and `CONFIG` (tuning). Any renderer can draw the line segments
`computePose` returns. The SVG renderer is just the website's consumer.

## Skeleton (local units; `viewBox 0 0 46 54`)

Centerline `CX=23`. Hip `y=30`, shoulders `y=18`, head center `y=11` r`5` (hollow). Segment
lengths: thigh `8`, shin `9`, upper-arm `7`, fore-arm `7`. Planted foot at `FEET_Y=47` — align
that y to the ground line. Stroke `2.2`, round caps, one color (`currentColor` by default so it
flips with the theme; an all-black figure would vanish in dark mode).

## Animation model

- **Run cycle:** procedural, sine-driven limbs (no keyframes). Phase advances at a **constant
  tempo** while running (not tied to translation speed). The cycle is the approved pose
  **mirrored across the vertical axis** so the limbs face the run direction; the **lean is a
  positional offset that is not mirrored**.
- **Legs:** forward swing uses `lift` (front leg rotates farther forward), backswing uses
  `stride`. Knee bend is split: `knee` (recovery/back leg) + `kneeF` (planting/front leg).
- **Arms:** pump opposite the legs, asymmetric `arm` (forward) vs `armBack` (back); forearms
  bend forward by `elbow`.
- **Per-step variance (`rnd`):** each stride gets a fresh small random multiplier, regenerated
  per leg at each step boundary, so left and right steps aren't identical.
- **Bob/lean/head:** `bob` (vertical), `lean` (forward torso offset, scales with run), `headTilt`
  (head forward offset = `lean * headTilt`).
- **Chase:** **slow, linear, no spring** — moves toward the target x at `speed` px/s and idles
  when caught up. **Frozen entirely while waving** (he plants and does not slide).
- **Wave:** on click, plant a stance and raise one arm (`waveArm` = upper-arm angle from the
  shoulder), forearm oscillating (`waveAmp` size, `waveSpd` speed) toward the viewer for
  ~2.4s, then resume.
- **Dust:** a small puff kicks off the back foot on each stride beat while running.

## Config reference

| Key | Meaning | Josh's value |
|---|---|---|
| `size` | overall scale | 1.29 |
| `stride` | leg backswing amplitude | 1.25 |
| `lift` | forward leg raise amplitude | 1.6 |
| `knee` | back (recovery) knee bend | 1.25 |
| `kneeF` | forward (planting) knee bend | 1.09 |
| `arm` | arm forward-swing amplitude | 1.15 |
| `armBack` | arm backswing amplitude | 1.6 |
| `elbow` | forearm forward bend | 0.95 |
| `lean` | forward torso lean | 5.7 |
| `headTilt` | head forward offset (× lean) | 1.73 |
| `bob` | vertical bob | 1.75 |
| `speed` | catch-up speed, px/s (slow) | 77 |
| `tempo` | run cycle speed, rad/s | 10.6 |
| `rnd` | per-step L/R variance | 0.06 |
| `waveArm` | raised-arm angle from shoulder (rad) | 4.28 |
| `waveAmp` | wave oscillation size | 0.45 |
| `waveSpd` | wave oscillation speed | 10 |

## Usage on the website (DOM/SVG)

```html
<script src="/lib/stickman.js"></script>
<script>
  // runner mounted into a positioned host; follows the pointer along a separator line.
  const runner = Stickman.createRunner({ mount: label, color: 'var(--ink)', dustColor: 'var(--ink-faint)' });
  Stickman.attachLineFollow(runner, { line: ruleEl });
  // runner.config is live (tune at runtime); runner.wave(); runner.setTarget(x); runner.destroy();
</script>
```

In Astro, import for side-effect (`import '/lib/stickman.js'`) and use `window.Stickman`, or
wrap the four exported functions in a thin ESM shim.

## Porting to Zipix (Phaser / canvas)

Reuse `SKELETON`, `computePose`, and `CONFIG` verbatim; replace only the renderer:

1. Each frame, build `state = { phase, run, dir, waving, t, rA, rB }` (same driver logic as
   `createRunner`: constant-tempo phase, linear chase frozen on wave, per-beat `rA`/`rB`).
2. `const pose = computePose(state, CONFIG)`.
3. Draw with a Phaser `Graphics`: `lineBetween` for each segment in `pose.lines`, a `strokeCircle`
   for `pose.head`, after applying the group transform (translateY `pose.bob`, scaleX `pose.dir`
   about `pose.center`) and the world transform (translate to x, `translateY(-FEET_Y)`, scale
   `size`). Stroke = a single game color.

The math is pure and dependency-free, so the character stays identical across the website and
the game.
