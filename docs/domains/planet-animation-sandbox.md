---
id: planet-animation-sandbox
title: Planet animation sandbox
type: domain
status: in-force
domain: space-map
---

# Planet animation sandbox

`/sandbox` swaps the whole app for a workbench page that renders one
`<Planet>` and drives its props by hand. It can be a real path (unlike
`?session=`, see `lib/sessionUrl.ts`) because the web app is only ever
served by vite, whose default SPA fallback rewrites unknown paths to
`index.html` in both `dev` and `preview` — any future non-vite host needs
the same fallback for a refresh on `/sandbox` to work. The controls:

- **STATE** select — the four `SessionStatus` values, so a state crossfade
  (`transition.ts`) can be replayed on demand.
- **TAG HUE** select — a handful of tag hues, replaying the retag hue tween.
- **selected** checkbox — the selection reticle's enter/exit.
- **hidden** checkbox — the ended-suppression fade.
- **scale follows state** checkbox (on by default) — maps the state through
  the layout's tier scales (`scaleFor`: working 1.0 / idle .71 / ended .44)
  so the transition includes the size change the map performs; off gives
  the pure material crossfade.

The page lives in `web/src/sandbox/SandboxPage.tsx` and is branched in
`main.tsx`, *instead of* `<App>` rather than inside it, so it opens no
WebSocket and touches no store — a broken server never gets between you and
an animation you are tuning. Both branches are `lazy()` imports because
`App.tsx` calls `getSocket()` at module scope; an eager import would open
the app's socket underneath the sandbox.

The camera zoom is fixed at `50 / BODY_RADIUS`, which draws the body at the
design canvas's own 100px, so the screen can be compared against artboard 1f
one to one.
