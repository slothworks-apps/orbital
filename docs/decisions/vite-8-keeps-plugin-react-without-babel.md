---
id: vite-8-keeps-plugin-react-without-babel
title: On Vite 8 the web app uses @vitejs/plugin-react 6, with no Babel
status: in-force
type: adr
domain: web
related:
  - restoreallmocks-strips-the-api-mock-defaults
tags:
  - tooling
  - build
---

# On Vite 8 the web app uses @vitejs/plugin-react 6, with no Babel

Moving `web/` to Vite 8 left `@vitejs/plugin-react` 4 behind: it accepts
Vite up to 7 only, and on Vite 8 it ran through Babel and printed three
warnings — an `esbuild` option it should pass as `oxc`, an
`optimizeDeps.rollupOptions` that is now `rolldownOptions`, and a
recommendation to switch to `@vitejs/plugin-react-oxc`.

## plugin-react 6, not plugin-react-oxc

`@vitejs/plugin-react-oxc` was the bridge for rolldown-vite. It is
deprecated in favour of `@vitejs/plugin-react`, and its peer range ends at
Vite 7. `@vitejs/plugin-react` 6 requires Vite 8 and does JSX and Fast
Refresh with Oxc inside Vite, without Babel. The warning that names `-oxc` comes from the
old plugin and is answered by upgrading the plugin, not by replacing it.

Babel stays available in plugin-react 6 through the optional
`@rolldown/plugin-babel` peer, for Babel plugins such as the React Compiler.
`web/` passes no Babel options and uses no Babel plugin, so it does not
install that peer.

## The Babel and react-refresh pins are gone

`@babel/core`, `@babel/plugin-transform-react-jsx-self`,
`@babel/plugin-transform-react-jsx-source` and `react-refresh` were in
`web/package.json` only to put back transitive dependencies of
plugin-react 4 that the lockfile had dropped. Nothing in `web/` imports
them, and plugin-react 6 does not need them, so they are removed.

## Adding the React Compiler later

That would mean installing `@rolldown/plugin-babel` and
`babel-plugin-react-compiler` and passing the compiler to `react()`; the
choice above does not rule it out.
