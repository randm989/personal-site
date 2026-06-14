/*
 * motion.js — the single home for GSAP-driven motion on the site.
 *
 * Why GSAP: framework-agnostic (fits Astro's static/islands model), now 100% free
 * including ScrollTrigger + SplitText (Webflow made it free, Apr 2025). This file is
 * the foundation you grow every scroll/timeline effect from — add new effects in the
 * "YOUR EFFECTS" section near the bottom.
 *
 * What it does today: (1) drives the site-wide `.reveal` entrance (elements fade + rise
 * as they enter the viewport), replacing the old hand-rolled IntersectionObserver; and
 * (2) owns the momentum cursor-light on `.panel`s. One motion system, so everything
 * tunes in one place.
 */
import gsap from 'gsap';
import ScrollTrigger from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

const prefersReduced = () =>
  typeof matchMedia === 'function' &&
  matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Entrance choreography for every `.reveal` element.
 * - In view on load (e.g. the hero) → animates immediately with a stagger.
 * - Below the fold → animates when scrolled into view.
 * `ScrollTrigger.batch` groups elements that cross the trigger line in the same frame
 * so their stagger reads as one motion instead of N independent tweens.
 */
function revealOnScroll() {
  const els = gsap.utils.toArray('.reveal');
  if (!els.length) return;

  // Reduced motion: show everything, no movement, no scroll triggers.
  if (prefersReduced()) {
    gsap.set(els, { opacity: 1, y: 0 });
    return;
  }

  ScrollTrigger.batch('.reveal', {
    start: 'top 88%',            // fire when the element's top reaches 88% down the viewport
    once: true,                  // entrance plays a single time
    onEnter: (batch) =>
      gsap.fromTo(
        batch,
        { opacity: 0, y: 12 },
        {
          opacity: 1,
          y: 0,
          duration: 0.55,
          ease: 'power2.out',
          stagger: 0.08,
          overwrite: true,
        }
      ),
  });
}

/**
 * Cursor-light with momentum (MOTION.md, LOCKED). Each `.panel`'s radial green
 * highlight follows the pointer through a per-frame lerp — never bound straight to the
 * mouse — and springs in from the panel centre on enter (no corner jump). Pointer-only,
 * dropped under reduced-motion. This is the "lit by your attention" motif.
 */
function cursorLight() {
  if (prefersReduced()) return;
  if (typeof matchMedia !== 'function') return;
  if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;

  document.querySelectorAll('.panel').forEach((panel) => {
    if (panel.dataset.lit) return;        // idempotent across re-inits (View Transitions)
    panel.dataset.lit = '1';

    let tx = 0, ty = 0, cx = 0, cy = 0, raf = null, alive = false;
    const apply = () => {
      panel.style.setProperty('--mx', cx + 'px');
      panel.style.setProperty('--my', cy + 'px');
    };
    const loop = () => {
      cx += (tx - cx) * 0.16;             // lerp — the locked momentum constant
      cy += (ty - cy) * 0.16;
      apply();
      if (alive || Math.abs(tx - cx) > 0.4 || Math.abs(ty - cy) > 0.4) {
        raf = requestAnimationFrame(loop);
      } else {
        raf = null;                        // release so the next enter restarts cleanly
      }
    };
    panel.addEventListener('pointerenter', (e) => {
      const r = panel.getBoundingClientRect();
      if (!alive) { cx = r.width / 2; cy = r.height / 2; }   // spring in from centre
      tx = e.clientX - r.left; ty = e.clientY - r.top; alive = true;
      if (!raf) loop();
    });
    panel.addEventListener('pointermove', (e) => {
      const r = panel.getBoundingClientRect();
      tx = e.clientX - r.left; ty = e.clientY - r.top;
      if (!raf) loop();
    });
    panel.addEventListener('pointerleave', () => { alive = false; });
  });
}

// ──────────────────────────────────────────────────────────────────────────
// YOUR EFFECTS — add new scroll/timeline animations below.
//
// Example: a gentle parallax drift on the hero headline as you scroll.
// Uncomment to try it, then tweak the numbers to feel it out. This is the core
// ScrollTrigger pattern (scrub = tie progress directly to scroll position):
//
//   function heroParallax() {
//     if (prefersReduced()) return;
//     gsap.to('.hero h1', {
//       yPercent: 18,            // how far it drifts
//       ease: 'none',
//       scrollTrigger: {
//         trigger: '.hero',
//         start: 'top top',
//         end: 'bottom top',
//         scrub: true,           // 1:1 with scroll; try `scrub: 0.5` for a little lag
//       },
//     });
//   }
//
// Then call it inside init() below.
// ──────────────────────────────────────────────────────────────────────────

/** Run all effects. Safe to call more than once. */
function init() {
  try {
    revealOnScroll();
    cursorLight();
    // heroParallax();   // ← enable your effects here
  } catch (err) {
    // Never leave content invisible if an animation throws — reveal everything.
    gsap.set('.reveal', { opacity: 1, y: 0 });
    console.error('[motion] init failed, revealed all content as fallback:', err);
  }
}

init();

// Future-proofing for Astro View Transitions (ClientRouter): if you ever enable soft
// client-side navigation, inline scripts don't re-run on page swaps. These listeners
// re-init on each navigation and clean up stale triggers so animations keep working.
if (typeof document !== 'undefined') {
  document.addEventListener('astro:after-swap', init);
  document.addEventListener('astro:before-swap', () => {
    ScrollTrigger.getAll().forEach((t) => t.kill());
  });
}
