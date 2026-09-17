---
id: hmr-of-a-half-written-file-kills-the-open-ui
title: A hot-swapped half-written component unmounts the whole UI until a manual reload
status: done
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

## What was done

A render error now costs the panel it happened in, not the session view and
its live connection.

`ui/ErrorBoundary` renders a named "⚠ &lt;panel&gt; crashed / &lt;message&gt; /
Reload" in place of the subtree it wraps. `App` wraps each docked surface in
its own — space map, sidebar, detail panel — rather than putting one around
the shell, so a crash costs one panel and leaves the other two readable.
`main.tsx` adds an outermost one around `App` itself, for a throw in the
shell's own body.

The boundaries register a reset callback in a module-level set, and
`main.tsx` wires `import.meta.hot?.on('vite:afterUpdate', …)` to it. The
update after a broken one is almost always valid again, so the tab heals
itself instead of sitting on the fallback until someone presses ⌘R. The
fallback is plain markup, not `ui/Button` — it renders when rendering is
already going wrong, so the less of the component library it needs, the more
often it can actually appear.

Verified in a real browser, not only in jsdom: breaking `Sidebar.tsx` the way
the report describes leaves the sidebar on its fallback with the transcript
and composer still live, and restoring the file clears the fallback with no
reload.

Two things this deliberately does NOT do:

- The subscriptions live in `App`, above every boundary, so a crashed panel
  never takes the live connection with it. That is load-bearing — moving them
  into a panel would reintroduce the reported symptom in a smaller form.
- It does not stop the dev tab reading HMR from a tree agents are mid-write
  in. A built preview would remove the failure mode entirely, at the cost of
  the live reload that makes the workflow pleasant; not worth it now that a
  broken update is visible and self-healing.
