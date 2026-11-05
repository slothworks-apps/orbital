# Browser extension

The browser bridge's extension for Chromium browsers (Chrome, Arc, Dia,
Vivaldi, Edge, Brave), Manifest V3. It sends the end of a selection and the
user's screenshots to Orbital, and answers the agent's `browser_screenshot`
by capturing the active tab. Spec: `docs/superpowers/specs/2026-11-05-browser-bridge-design.md`.

## Version

The extension ships inside the desktop app, so a change here reaches the
**desktop** version (`version` in `desktop/package.json`) and its line goes
in `desktop/CHANGELOG.md`. The build writes the desktop's version into
`dist/manifest.json`; `version` in this workspace's `package.json` is only
there for npm and never changes.

## The protocol

`src/protocol.ts` mirrors the socket half of `server/src/browser/protocol.ts`,
which is the source of truth. A change to a frame or a close code changes
both files in the same change.

## Layout

- `src/worker.ts` — the service worker: the one WebSocket to
  `ws://127.0.0.1:<port>/ws/browser`, pairing, the ping that keeps MV3 from
  stopping it, screenshot outcomes and the badge, screenshots.
- `src/content.ts` — on every page except Orbital's own: the end of a
  selection, sent to the worker.
- `src/popup.ts`, `static/popup.html`, `static/popup.css` — the popup,
  canvas 64g: one state at a time, Deep Field or Infrared by
  `prefers-color-scheme`. Manrope and JetBrains Mono are bundled in
  `static/fonts` (latin subset, OFL); an extension loads nothing remote.
- `src/icon.ts` — the toolbar icon, canvas 64h, drawn from the app icon's
  A · front mark. `scripts/render-icons.mjs` renders `static/icons/*.png`
  from it (run it after changing the drawing and commit the PNGs); the
  worker draws the outcome badge's frames with the same code into
  `chrome.action.setIcon`. The badge is only for screenshots the user
  takes, never a number, never red; there is no `setBadgeText`.
- `src/selection.ts`, `src/connection.ts`, `src/browserName.ts`,
  `src/pairingCode.ts`, `src/badge.ts`, `src/popupText.ts` — the pure
  decisions, which the tests exercise without a browser.
- `static/manifest.json` — its `key` fixes the extension's ID, and so the
  `chrome-extension://` origin the server accepts (`BROWSER_EXTENSION_ID`).
  Changing the key changes the ID and breaks every install.
- `scripts/build.mjs` — bundles into `dist/` with esbuild and copies the
  popup, the icons and the fonts.

## Working on it

```bash
npm run build -w @orbital/browser-extension   # → browser-extension/dist/
npm test -w @orbital/browser-extension
npm run typecheck -w @orbital/browser-extension
```

1. `npm run dev` at the root: the dev server listens on 4838.
2. Turn on *Browser bridge* in the dev web app's Settings → Labs.
3. `chrome://extensions` → *Developer mode* → *Load unpacked* →
   `browser-extension/dist`.
4. In the extension's popup, *Advanced* → port `4838` (it saves on Enter),
   then type the pairing code Settings shows.

After a rebuild, press the extension's reload button in
`chrome://extensions`; pages already open keep the old content script
until they are reloaded.

The screenshot shortcut is suggested as ⌘⇧S (Ctrl+Shift+S elsewhere), not
an ⌥ chord: on a Czech keyboard ⌥+letter types a character. The browser
assigns it only when nothing else holds it, and the user changes it at
`chrome://extensions/shortcuts`; the popup's key cap shows what
`chrome.commands` reports, and no key cap when none is assigned.
