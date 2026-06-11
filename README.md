# CSE110 Project: MemeBro

MemeBro is a meme generation platform built on Cloudflare Workers.

## Project Links
- YouTube demo: https://youtu.be/yxKbU6RzruE
- Public Video: https://youtu.be/ox8PpIkMalA
- Private Video: https://youtu.be/gAWJT_3Tx5I
- Frontend: `/public/index.html`
- API Gateway: `/src/index.js`

---

## Architecture
```text
cse110-sp26-group17-MemeBro/
├── .github/                # GitHub setup files
│   └── PULL_REQUEST_TEMPLATE.md  # PR template
├── admin/                  # Team management files
│   ├── branding/           # Team branding
│   ├── feedback/           # Feedback notes
│   ├── images/             # Unrelated images and screenshots
│   ├── meetings/           # Meeting notes
│   ├── misc/               # Other files 
│   ├── videos/             # Demo videos
│   └── team.md             # Team page
├── docs/                   # Documentation
│   ├── ADRs/               # Architecture decisions
│   ├── design/             # Design diagrams and wireframes
│   └── research/           # Research notes
└── worker/                 # Main project code
    ├── hero/               # React scroll-morph hero (Vite sub-build)
    │   └── src/            # ScrollMorphHero, Button, lerp, memes
    ├── public/             # FRONTEND: HTML, CSS, client-side JS
    │   └── lib/            # Modular JS: state, render, events, etc.
    ├── scripts/            # Helper scripts
    ├── src/                # BACKEND: Cloudflare Worker API gateway
    │   └── openai/         # OpenAI caption, image, and AI-prompt handlers
    ├── test/               # TESTING: Vitest test suites
```

## Prerequisites
- Node.js (LTS recommended)
- npm

## Install
```bash
cd worker
npm install
```

This also sets up the MediaPipe browser files under `public/.generated/mediapipe/`. To recreate them manually, run `npm run build:assets`.

## Local Development
```bash
cd worker
npm run dev
```

Then open `http://localhost:8787/` (default Wrangler port). The upload app should load from `public/index.html`.

`npm run dev` runs `npm run build:assets` first so a clean checkout has the MediaPipe JS, WASM, and face model files before the browser imports `public/app.js`.


## Environment variables and API keys

- **Non-secret config** can go under `vars` in `wrangler.jsonc` (see commented example in that file).
- **Secrets (API keys)** must not be committed. For local dev, copy `.dev.vars.example` to `.dev.vars` and set values there. Wrangler loads `.dev.vars` automatically when you run `wrangler dev`.
- For deployed environments, use `wrangler secret put <VARIABLE_NAME>` and read from `env` in the Worker.
- The final Add Face submit calls `/api/process`, so local submit testing needs `OPENAI_API_KEY`, `FACE_SWAP_API_URL`, and any related upstream config in `.dev.vars`.
- The Worker now also exposes built-in OpenAI routes:
  - `POST /api/caption` (chat-completions caption generation)
  - `POST /api/image` (gpt-image-2 generation/edits)
- Optional model vars:
  - `OPENAI_MODEL` (default `gpt-4o-mini`)
  - `OPENAI_IMAGE_MODEL` (default `gpt-image-2`)
- If `IMAGE_GEN_API_URL` / `EXTRA_ROAST_API_URL` is not set, `/api/process` with `mode=extra_roast` automatically falls back to the built-in `/api/image` logic.

## Tests
```bash
npm test
```

## Deploy
```bash
npm run deploy
```

Requires a Cloudflare account and Wrangler login (`npx wrangler login`).

## Scroll-Morph Hero Animation

The landing page features an animated hero section built with React and Framer Motion (source: `worker/hero/src/`). The animation plays through three intro phases:

1. **Scatter** — meme thumbnail cards appear at random positions.
2. **Line** — cards slide into a horizontal line.
3. **Circle** — cards arrange into a circle; scrolling morphs the circle into a rotating arc that reveals the studio CTA.

The hero is compiled by Vite as a standalone bundle and mounted into `#scroll-morph-hero-root` in `public/index.html`. It dispatches a `memebro:start` CustomEvent to hand control to the vanilla-JS studio.

Key files:
- `ScrollMorphHero.jsx` — main component with scroll physics and card layout math
- `Button.jsx` — pill-style CTA button (primary gradient / secondary glass)
- `lerp.js` — linear interpolation utility
- `main.jsx` — React ↔ vanilla-JS bridge
- `memes.js` — static meme thumbnail catalog

The animation respects `prefers-reduced-motion`: when set, the intro skips straight to the circle phase and spring animations resolve near-instantly.

## Accessibility Improvements

- All interactive elements have accessible labels and meet WCAG contrast ratios.
- `aria-hidden` is applied to decorative elements (aurora glow, grid overlays).
- Focus-visible outlines are preserved on all interactive controls.
- The hero and studio honor `prefers-reduced-motion` to disable non-essential animations.
- Label-content-name mismatches on toolbar buttons have been resolved.

## Image Generation Model

The default image generation model is **gpt-image-2** (upgraded from gpt-image-1). This applies to:
- `POST /api/image` — image generation and edits
- `mode=extra_roast` via `POST /api/process` when no external `IMAGE_GEN_API_URL` is configured

The model can be overridden by setting `OPENAI_IMAGE_MODEL` in `.dev.vars` or via `wrangler secret put`.

## Architecture Decision Records (ADRs)
Located in `docs/ADRs/`:
- `0001-api-gateway-routing.md`
- `0002-editor-layout.md`
- `0003-face-swap-provider.md`
- `0004-template-editing.md`
- `0005-template-selection.md`
- `0006-upload-face-detection-ui.md`
- `0008-ai-only-meme-generation.md`
