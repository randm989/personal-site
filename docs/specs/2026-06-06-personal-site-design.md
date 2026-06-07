# Personal Site — Design Spec

**Date:** 2026-06-06
**Owner:** Josh
**Status:** Approved (design); implementation plan pending

---

## 1. Purpose

A personal, deliberately non-business website that:

- Acts as a **polished front door** — a portfolio of the best work and an "interesting" interactive resume that lands with a recruiter, collaborator, or investor in ~30 seconds.
- Hosts a **living garden** — frequent, low-friction posts: side projects, experiments, and things that interest Josh, for fun.
- Serves existing **HTML presentations** as first-class artifacts.

Equal weight on both modes: a calm front door with an alive, exploratory garden behind it.

## 2. Design thesis (first-class requirement, not decoration)

> An editorial, restrained base where the joy is **discovery**. Everything responds to
> touch/hover in small, surprising ways — the way an exploration game rewards you for
> poking at the scenery. The delight is not loud; it is that *more is alive than you
> expected.*

Consequences this thesis forces on the architecture:

- The base must be **quiet and fast** — interactivity is opt-in, never the default load.
- Micro-interactions must be **systematic, not hand-rolled per page** — a shared
  primitives layer so the "surprising that it's alive" quality is consistent.
- A few **hidden easter eggs** reward exploration without being required to use the site.

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
| `/` (Home) | Editorial front door: short confident intro, curated best work, quiet-but-pokeable | Single page |
| `/projects` + `/projects/[slug]` | Portfolio. Zipix front and center; others as supplied | One file per project (Content Collection) |
| `/resume` | The "interesting" interactive resume, built from Josh's real resume; clean printable/PDF fallback for recruiters | Single page + downloadable PDF |
| `/garden` + `/garden/[slug]` | The living feed: side projects, experiments, interests. Chronological + tag-browsable | One `.mdx` file per entry (Content Collection) |
| `/presentations` | Gallery indexing the raw HTML decks | Index page + decks in `public/presentations/` |

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
- Exact delight-primitive set and intensity (decided against the clickable mockup).
- Typography and color tokens for the editorial base.
- Whether the resume PDF is hand-exported or generated from the page.
