---
id: hmr-of-a-half-written-file-kills-the-open-ui
title: A hot-swapped half-written component unmounts the whole UI until a manual reload
status: backlog
type: fix
domain: web
related:
  - first-turn-can-outrun-the-ws-subscription
tags:
  - web
  - dev
  - errors
---
# A hot-swapped half-written component unmounts the whole UI until a manual reload

Reported as "I replied in two sessions and nothing happened, and only after a
refresh do I see that the agent answered" — and, importantly, as something
that happens *regularly*. It looks exactly like a stuck WebSocket. It is not.

## What happens

Orbital is used to drive sessions that edit Orbital. The browser tab is served
by the `vite dev` server watching the very `web/src` tree those sessions are
writing to, so every intermediate state an agent's editor passes through is
hot-swapped into the running tab within milliseconds.

An agent rewriting a component lands, for a second or two, on a module that
parses but does not run — a binding renamed at its use site before its
declaration, a symbol removed ahead of its last reference. React renders it,
it throws, and with no error boundary anywhere above it React 18 unmounts the
entire tree. The tab is left blank (or frozen on its last paint, depending on
when the throw lands), the `session:<id>` subscription is gone with the tree,
and nothing repaints again no matter what the server publishes.

Reproduced on 2026-09-17, both in the reporter's tab and in a clean
Playwright one:

```
ReferenceError: sourceOptions is not defined
    at Sidebar (http://localhost:5173/src/panels/Sidebar.tsx?t=1789631584697)
```

`sourceOptions` no longer appears anywhere in `Sidebar.tsx` — by the time the
error was read, the session that caused it had finished the edit. That is the
whole trap: the state that broke the tab is gone before anyone can look for
it, so the evidence points at the transport instead.

Everything downstream was verified healthy at the same moment: both CLI
processes alive, `/api/sessions/:id` reporting the live runner status, and an
independent WS client subscribed to `session:<id>` receiving every message the
UI was missing. A reload always fixes it, because by then the file is valid
again.

## What it should do

A render error should cost the panel it happened in, not the session view and
its live connection.

- An error boundary around the app (and a tighter one around the detail panel)
  that renders a visible "this panel crashed — Reload" instead of nothing.
  This is worth having in production too, not only under `vite dev`.
- Under HMR, `import.meta.hot` can reset that boundary on the next accepted
  update, so the tab heals itself when the agent's next write lands rather
  than waiting for a human to press ⌘R.

Worth deciding at the same time whether the dev tab should be reading HMR from
a tree that agents are mid-write in at all — a built preview would not have
this failure mode, at the cost of the live reload that makes the workflow
pleasant.
