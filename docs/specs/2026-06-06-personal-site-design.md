# Personal Site — Design Spec

**Date:** 2026-06-06
**Owner:** Josh
**Status:** Approved (design); implementation plan pending

---

> **Governing document:** [`../FOUNDER-PROFILE.md`](../FOUNDER-PROFILE.md) is the source of
> truth for *who the site represents* (voice, positioning, hard rules, taste). This spec
> defines *how it's built*. When they disagree about tone or message, the profile wins.

## 1. Purpose & positioning (the north star)

A personal, deliberately non-business website whose **single overarching message** is
Josh's trajectory: **a director-track game-studio leader** — capable of building and leading
a 15–20-person studio now, on the way to founding an elite, autonomous one (a cell that
operates at a high level on its own, inside a larger org or standalone) that makes games which
move people to purpose. Every section is evidence for that arc. See FOUNDER-PROFILE §2
for the two-layer positioning and §6 for the hard rules (notably: **the personal origin of
the mission is private fuel and never appears on the site**).

- **Game maker** — proven by the portfolio (Zipix front and center) and the presentations.
- **Team builder** — surfaced through how Josh thinks about people, equity, and building a
  studio, not just shipping code.
- **Studio-bound** — the framing that ties projects, garden, and resume together: this is
  someone assembling the craft, range, and judgment to lead a studio.

It does this in two modes, equally weighted:

- A **polished front door** — best work + an "interesting" interactive resume that lands
  the *game-maker-becoming-studio-founder* story with a recruiter, collaborator, or
  investor in ~30 seconds.
- A **living garden** — frequent, low-friction posts (side projects, experiments,
  interests) that demonstrate range and curiosity. For fun, and as proof of a restless maker.

It also serves existing **HTML presentations** as first-class artifacts.

## 2. Design motif (supporting texture, NOT the message)

The site *feels alive* as a craft signal, not as its subject. The interactivity is the
subtext — "this person sweats the small stuff" — and must never upstage the studio-builder
story.

> An editorial, restrained base where small things quietly respond to touch/hover, the way
> an exploration game rewards you for poking at the scenery. The point is *more is alive
> than you expected*, felt in passing — never announced.

Consequences this motif forces on the architecture:

- The base must be **quiet and fast** — interactivity is opt-in, never the default load.
- Micro-interactions are **systematic, not hand-rolled per page** — a shared primitives
  layer so the quality is consistent (cursor companion, magnetic elements, card tilt,
  hover lifts, a few hidden easter eggs).
- The motif **recedes**: copy and layout lead with the narrative; the page never
  instructs the visitor to "go poke things." Discovery is incidental, not the call to
  action.

## 2a. System-aware theming (requirement)

The site **follows the visitor's system dark/light preference** (`prefers-color-scheme`),
with a matched editorial palette in each mode. Both palettes are defined as the same
semantic token set (one source of truth), so the motif and every component render
correctly in either mode without per-component overrides. A manual toggle is optional and
deferred; automatic system-following is the day-one requirement.

## 3. Autonomy goal (the reason this project exists in this form)

The site must be **maximally drivable by an LLM in a normal Claude Code session.** When
Josh says "add my new project X" or "post this to the garden," the agent edits one or two
files, commits, and pushes — and the site is live. This biases every choice toward:

- **File-based content** (no CMS, no database, no admin UI).
- **A static build** (no server to operate, no runtime tokens for the common path).
- **Convention over configuration** so adding content is a single predictable file op.

## 4. Stack — Astro (chosen)

Astro is a content-first static-site generator. It was chosen over (B) hand-rolled
HTML/CSS and (C) Next.js/React because it is the only option where the *autonomy goal*
and the *design thesis* point the same direction:

| Need | How Astro serves it |
|------|--------------------|
| Quiet, fast editorial base | Ships **zero JS by default**; interactivity is opt-in per "island" |
| Surprising, alive interactions | Islands let any component progressively enhance without bloating the base |
| Existing HTML presentations drop in | Files in `public/` are served **untouched** |
| One-file-per-post autonomy | **Content Collections** = typed, file-based content; add an `.mdx` file = new entry |
| Known deploy muscle | First-class **Cloudflare Pages** target, one-command deploy |

Rejected:
- **Hand-rolled** — garden authoring becomes manual toil; the delight layer must be
  hand-maintained everywhere; scales badly for the exact thing we care about.
- **Next.js/React SPA** — heavier JS on every page (fights editorial calm), more
  maintenance surface, slower first paint; the SSG sweet spot is better served by Astro.

## 5. Information architecture

| Route | Purpose | Content model |
|-------|---------|---------------|
| `/` (Home) | Editorial front door leading with the **studio-builder narrative**: who Josh is (game maker + team builder), where he's headed (his own studio), then curated proof | Single page |
| `/projects` + `/projects/[slug]` | Portfolio — the **maker** evidence. Zipix front and center; others as supplied | One file per project (Content Collection) |
| `/resume` | The "interesting" interactive resume, built from Josh's real resume; clean printable/PDF fallback for recruiters | Single page + downloadable PDF |
| `/garden` + `/garden/[slug]` | The living feed: side projects, experiments, interests. Range + curiosity. Chronological + tag-browsable | One `.mdx` file per entry (Content Collection) |
| `/presentations` | Gallery indexing the raw HTML decks | Index page + decks in `public/presentations/` |
| `/about` *(optional, phase 2)* | The **team-builder** thread — how Josh thinks about people, equity, and what kind of studio he's building. Can start as a home-page section and graduate to its own page | Single page |

The home page carries a short **"the studio I'm aiming to build"** narrative beat that names the
destination explicitly and frames everything below it as evidence.

## 6. The delight layer

A small shared **interaction-primitives module** — a set of progressive-enhancement
behaviors any element opts into via a `data-*` attribute or a thin wrapper component.
Built once, reused everywhere. Candidate primitives (final set decided at mockup time):

- Micro-reactions on hover/tap (scale/tilt/spring on otherwise-static elements).
- Cursor-aware elements (subtle parallax / magnetic pull on nearby interactive bits).
- A handful of hidden easter eggs (keyboard sequence, a pokeable logo, etc.).
- An optional, off-by-default sound toggle for interaction feedback.

Principle: the base renders fully and correctly with **no JS**; the delight layer is pure
enhancement on top. Mirrors Josh's Zipix instinct of shared systems over one-offs.

## 7. Infrastructure (recommended: fully separate, lightweight)

- **Repo:** new repo under Josh's **personal** GitHub account (separate from the Zipix org).
- **Hosting:** a **separate** Cloudflare Pages project, connected to the repo via Pages'
  native git integration. Push to `main` → Pages builds Astro → live. Preview deploys on
  branches, free.
- **Secrets:** a **personal Doppler project** *only if/when* a secret is actually needed.
  A pure static site needs **zero tokens day one** — Pages git integration deploys on push
  with no API token at all. Tokens are added later only for things like a contact-form
  handler or analytics ingestion.
- **Local home:** `/home/josh/Projects/personal-site` — sibling to Zipix, fully
  independent. Nothing in this project touches the Zipix repo.

### One-time authorizations (the human-only steps)

1. Create an empty repo under personal GitHub (e.g. `personal-site`).
2. In Cloudflare dashboard: create a Pages project, connect it to that repo, set build
   command `npm run build` and output dir `dist`.
3. (Deferred) Create a personal Doppler project if/when a secret is needed.

### Deferred: "get it onto GitHub" step (decided 2026-06-06)

The repo lives **locally only** for now (clean git history at `/home/josh/Projects/personal-site`).
Pushing to GitHub is its own later step, bundled with two decisions:

- **Account:** target is the genuinely-personal **`randm989`** account (business-separate),
  *not* `josh-rutz` (which is tied to the playzipix org). The agent is currently
  authenticated only as `josh-rutz` and has **no write access** to `randm989`.
- **Handle rename:** revisit renaming `randm989` to a cleaner public handle at the same time
  (the site's job is "be known and found"; the handle is part of the brand surface).
- **Access mechanism:** set up a **personal Doppler** project to hold a `randm989` PAT (the
  token-holding pattern Josh wanted), or `gh auth login` as `randm989` directly.

Until then, all work stays in local commits — losing nothing.

Everything else — scaffold, content, build config, the delight layer — the agent does.

## 8. Domain

Josh will pick/buy one. Shortlist to react to (availability checked on Cloudflare
Registrar before commitment): `joshrutz.com`, `joshrutz.dev`, `joshrutz.me`, `rutz.dev`,
or a preferred handle. The site can ship on the free `*.pages.dev` subdomain the same day
and attach the real domain whenever registered — domain is **not** on the launch critical
path.

## 9. Launch scope

**Real on day one:**
- Home (editorial front door).
- Presentations gallery (Josh's existing decks dropped into `public/presentations/`).
- Resume (built from Josh's real resume) + printable/PDF fallback.
- 2–3 project entries (Zipix + whatever blurbs exist).
- The delight layer, working, on at least the home page.

**Strong placeholders:**
- Garden seeded with one example post + the full structure, ready for Josh to feed entries.

## 10. Out of scope (YAGNI)

- No CMS / admin UI / database.
- No user accounts or auth.
- No server runtime for the common path (static only).
- No "talk to it from anywhere" remote trigger yet — the git+CI foundation is built so it
  *could* bolt on later, but it is not built now.

## 11. Open items to resolve at/after mockup

> **Clickable feel mockup:** [`2026-06-06-personal-site-mockup.html`](./2026-06-06-personal-site-mockup.html)
> — demonstrates the editorial base + delight layer, with live controls to tune interaction
> intensity and spring.


- Final domain choice + registration.
- Exact delight-primitive set and intensity/spring values (tuned against the clickable mockup).
- **Locked aesthetic direction + token system** (typography, light *and* dark palettes as
  one semantic token set) — see Design process below.
- The **studio-builder narrative copy** for the home page (the hero + "the studio I'm
  building" beat) — to be developed with the `impeccable` skill.
- Whether the resume PDF is hand-exported or generated from the page.

## 12. Design process (how we get from spec to a coherent site)

The site must stay visually and narratively in sync as it grows. The sequence:

1. **`impeccable`** — sharpen the studio-builder narrative and the strategic framing of
   each section (what story each page tells, in what order). The message work.
2. **Aesthetic direction lock** — decide and freeze the editorial token system:
   type scale, spacing, light + dark palettes (one semantic set), and the motif's
   intensity/spring values from the mockup. This becomes the single source of truth every
   component reads from, so nothing drifts.
3. **`emil-design-eng`** — polish the motion: the cursor companion, magnetic elements,
   card tilt, page/section transitions. Make the motif feel *right*, not just present.

These run after spec sign-off and feed the implementation plan; they are not blockers to
scaffolding the Astro project and standing up a preview deploy.
