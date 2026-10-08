---
id: 2026-10-08-landing-site-design
title: The Orbital website at orbital.slothworks.io
type: spec
status: done
domain: site
related:
  - the-landing-site-is-astro-in-this-repository
tags:
  - site
  - seo
  - demo
---

# The Orbital website at orbital.slothworks.io

## The goal

A public page that gets a Claude Code user to download the Mac app. It says
what Orbital is, shows it working, and links to the DMG. The phone apps are
shown and linked, but the Mac download is the one action the page is built
around.

The page is English only and lives at `orbital.slothworks.io`.

## The design

The design is a canvas maintained outside this repository: the landing page
and the privacy page, each at 1440 and 390 wide.

The canvas owns layout, ink, type and copy. This spec does not restate them.
Where the canvas and this spec disagree on behaviour, this spec wins and the
canvas is corrected.

Copy is taken from the canvas word for word. It was fact-checked against the
app on 2026-10-08 and the corrections were made in the canvas; until
they land, the build uses the corrected canvas, not an older copy.

The privacy page's text is a placeholder in the canvas; the real text is in
`site/content/privacy.md` (see The privacy text).

## Pages

| path | what |
|---|---|
| `/` | the landing page |
| `/privacy/` | the privacy policy |
| `/demo/map/`, `/demo/session/`, `/demo/phone/` | the live demos, framed by `/`; `noindex`, not in the sitemap |

Real paths, not hash routes. The privacy link in the footer goes to
`/privacy/`, the "Back to Orbital" link to `/`.

## Links

- Every "download for Mac" action goes to the GitHub releases list,
  `https://github.com/slothworks-apps/orbital/releases`, not to a specific
  release or asset. Release assets carry the version in their name, and the
  list is always right.
- The GitHub links in the header, the privacy section and the footer go to
  `https://github.com/slothworks-apps/orbital`.
- The iPhone and Android buttons in the hero scroll to the "Get Orbital"
  section.
- Whether the phone apps are invite-only or public is one build-time constant,
  `PHONE_RELEASE` (`'testers' | 'public'`). It switches the texts and buttons
  the canvas switches with its `release` tweak. Going public is a one-line
  change plus the store URLs.

## Stack and placement

- A seventh npm workspace, `site/`, in this repository
  ([[the-landing-site-is-astro-in-this-repository]]).
- Astro with `@astrojs/react`, static output only. Pages are Astro
  components; React is used only inside the demos.
- Fonts (Manrope, JetBrains Mono) are self-hosted from the site's own assets.
  The site makes no request to a third party: no Google Fonts, no analytics,
  no cookies. The privacy section says "No analytics, in the app or on this
  site", and this keeps it true.
- The favicon is the app's own.

## SEO

- All copy is static HTML. A crawler that runs no JavaScript sees the whole
  page.
- Each page has its own `<title>`, meta description, `canonical`, Open Graph
  and Twitter card tags. The Open Graph image is a static 1200×630 PNG in the
  repository.
- `sitemap.xml` (the two real pages only) and `robots.txt`.
- JSON-LD `SoftwareApplication` on `/`: name, description, operating system
  macOS, category DeveloperApplication, price 0, download URL as above.
- The largest contentful paint is the hero heading, not a demo. Demos never
  block the first render.
- Target: Lighthouse 100 for SEO, accessibility and best practices on `/`,
  measured on the built site.

## The demos

The canvas's media placeholders are not screenshots or videos. They are the
app's real components running on demo data:

| where | demo | what it shows |
|---|---|---|
| hero | map | the Planets map, demo sessions moving through their states |
| 01 · The map | map | the same map, framed to show the four states of the legend |
| 02 · Driving a session | session | the session panel: chat, a permission card, a diff |
| 03 · The phone | phone | two phone screens in a device outline: answering a session that needs input, starting a new session |

Only the Planets theme is shown. Archipelago is experimental and not
presented.

### Each demo is a page in an iframe

Each demo is a small app of its own at `/demo/<name>/`, embedded with
`<iframe loading="lazy">`.

- **Isolation.** The desktop app and the phone app each bring global CSS
  (`theme.css`, `mobile.css`) and their own zustand store. In an iframe they
  cannot collide with each other or with the landing page.
- **Load order.** The iframe loads only when it nears the viewport, so neither
  three.js nor React is fetched for the first render.
- **Poster.** Each demo frame shows a still image of the demo until the iframe
  has loaded, and in place of it when JavaScript is off.

The demo pages are built with a Vite config that extends `web/`'s, so the
components behave exactly as they do in the app.

### Demo data goes through a fake server

The components are not changed for the demo. They get their data the way they
do in the app:

- `configureApi({ fetch })` (`web/src/lib/api.ts`), the hook the phone uses to
  carry `/api` over the relay, is given a fake `fetch` that answers from a
  fixed set of demo sessions.
- The WebSocket is replaced the same way, by a fake that emits the events the
  scenario calls for.
- The map seeds the store directly, as `web/src/sandbox/ClusterSandboxPage.tsx`
  does today.

The demo data is typed with the app's own types (`ApiSession` and the rest),
so an API change breaks the site's typecheck rather than the live demo.

An endpoint the fake server does not know gets an empty, successful answer and
a console warning in a dev build. During implementation, every endpoint the
demoed components call is listed and answered.

### Scenarios

Two short scenarios loop:

- **Map.** One session is working and then needs input. One is done. One is
  waiting for its subagents, which circle it as moons. One is a terminal
  session.
- **Session.** A permission card arrives; once approved, the edit lands as a
  diff.

The first interaction stops the scenario: from then on the demo does only
what the visitor does. Under `prefers-reduced-motion` the scenario does not
advance on its own.

### What the visitor can do

- Click a planet: its real panel opens.
- Approve or Deny on a permission card: the session's state changes.
- Expand a diff or a tool call.
- On the map, start a session from New session: a working planet titled "New
  session" appears in the chosen directory's cluster and its panel opens.
  Settings and the error log open as in the app; pinning, ending a session on
  the trash (with its Undo), renaming, retagging and changing model or mode
  change the fake server's session.

The composer is disabled with the placeholder "In the app, you'd type here",
the new-session dialog's first prompt included. Claude's replies are not
simulated. The app's other pages (stats, plan limits) are not part of the
website: the map demo hides the sidebar's links to them and lets no link take
the frame off `/demo/`. The keymap is not installed, so shortcuts such as ⌘N do
nothing (a browser keeps ⌘N for a new window anyway).

### Scaling

The iframe is rendered at a fixed virtual viewport (per demo, e.g. 1440×900
for the map) and scaled down with `transform: scale()` to fit its frame. A
`ResizeObserver` recomputes the scale when the frame changes size. The app
inside lays out as on a desktop screen, so the frame shows more than its own
pixel size would. The map's canvas caps its device pixel ratio so the
downscaled render stays smooth. The virtual size of each demo is set during
the fidelity pass against the canvas.

### Narrow screens get images

Below a width set during the fidelity pass, no demo iframe is loaded at all
and three.js is never fetched. Each frame shows its static image instead. The
decision is made in the page, before any iframe is created, so a phone
visitor downloads none of the demo code.

### The images

The posters and the narrow-screen images are taken from the demos
themselves, by a script in `site/` that drives the built demos in a headless
browser. They are committed to the repository and regenerated when the app's
look changes; the build does not take screenshots.

## Build, CI and deploy

- `npm run build -w site` builds the demo pages and then the Astro site into
  `site/dist`.
- CI: a `site` job runs the build and the typecheck on every pull request that
  touches `site/`, `web/src` or `shared/`, the same way CI already runs what a
  change reaches.
- Tests, per the repository's rule: the fake server (every endpoint the demos
  call has an answer) and the scale computation. No tests of how the page
  looks.
- Deploy: a GitHub Action on `main`, for the same paths, runs `wrangler
  deploy` to Cloudflare Workers static assets, bound to
  `orbital.slothworks.io`. It needs the `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID` repository secrets, which the maintainer sets.

## Repository rules

- `CLAUDE.md` lists `site/` as the seventh workspace and adds a row to the
  Versions table: the website has no version and no changelog; it is deployed
  from `main`.
- A `site` label for pull requests that change the website (created after the
  maintainer agrees, as `CLAUDE.md` asks).
- `site/CLAUDE.md` says that the copy comes from the design canvas, that the demos
  render components from `web/`, so a change there can change the website,
  and that the privacy text is the maintainer's.
- A runbook in `docs/ops/` for deploying the site and regenerating the images.

## The phone

The phone app gets nothing from this change, on purpose: the website is not a
feature of Orbital, it is a page about it. The site shows the phone app in its
`phone` demo, which renders the real screens from `web/src/mobile` on demo
data, and links to TestFlight and Google Play. A change to those screens can
therefore change the website, which `site/CLAUDE.md` says.

The website itself must work on a phone's browser: the 390 artboards are part
of the design, and on narrow screens the demos are images.

## Out of scope

- Any other language.
- A blog, a changelog page or docs pages.
- Simulated Claude replies in the demos.
- The Archipelago and Desk themes in the demos.
- Analytics of any kind.

## Asking for an invite

"Ask for an invite" is a `mailto:orbital@slothworks.io` link with the subject
"Orbital invite" and a body that asks for the platform (iPhone or Android),
the e-mail of the Apple ID or Google account to invite, and whether the
tester runs their own relay or wants ours. Both stores invite testers by
e-mail, which must not be public, so a GitHub issue is ruled out; a form
would need a backend the static site does not have.

## The privacy text

The policy is `site/content/privacy.md`, drafted from the code on 2026-10-08
and checked claim by claim. It describes what any relay holds and leaves
out who runs one: the relay SlothWorks runs is not public and is not
mentioned.
