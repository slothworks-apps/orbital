---
id: 2026-09-15-orbital-web
title: 2026-09-15-orbital-web
status: done
type: plan
---
# Orbital Web UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Orbital web UI — a React app rendering Claude Code sessions as a 2D space map (planets = sessions, moons = subagents) with a sidebar, a chat detail panel, tags/rules management, and settings — driven live by the existing server's REST + WS API.

**Architecture:** Vite + React 18 + TypeScript + Tailwind v4 in `web/`. A thin typed API client and a refcounted WS client feed one zustand store; the react-three-fiber scene (orthographic top-down, pan/zoom only) and all panels render from the store. Visual design follows the exported Claude Design canvas (`design/`): dark glass HUD, Manrope + JetBrains Mono, tag hue = `oklch(80% .13 <hue>)`, state carried by motion/core only.

**Tech Stack:** React 18, Vite, TypeScript strict, Tailwind v4, @react-three/fiber + @react-three/drei, zustand, react-markdown + remark-gfm, shiki, anser, Vitest + @testing-library/react + jsdom.

**Spec:** `docs/superpowers/specs/2026-09-15-orbital-design.md` (UI sections + design-language section are binding)

## Global Constraints

- **Component reusability (binding, user-mandated):** variants/states via props (`<Planet state="working" hue={210}>`), never cloned components, never external `className` patches of a component's internals. Before adding a component, check an existing one + a new prop covers it.
- **Design language (binding):** fonts Manrope (UI) / JetBrains Mono (paths, counts, labels); background `#05070d`; glass panels (translucent dark fill, border `rgba(150,205,255,.14)`); text `#e8eef8` bright / `rgba(160,190,225,.7)` muted; tag color always `oklch(80% .13 <hue>)`; planet/moon state expressed ONLY by motion + core (rotation, pulse, white ripple), never by hue.
- Statuses everywhere: `working | needs_input | idle | ended`.
- Server API shapes are the contract (camelCase session rows from `toApi`; snake_case tag/tag_rule rows; flat string settings). Never remap silently.
- Transcript history comes from REST; the WS tail only delivers NEW messages (server starts tails at EOF). Client dedupes messages by `message.id` anyway.
- Web runs on Vite dev server :5173 proxying `/api` and `/ws` to `127.0.0.1:4737` (server's WS Origin allowlist already admits :5173).
- Node 20+, ESM, strict TypeScript. Commit after every task (conventional commits).
- Server-side changes in this plan are limited to Task 1 (WS payload unification + revive/collision guard — final-review rulings).

## File Structure

```
web/
├── package.json, tsconfig.json, vite.config.ts, vitest.config.ts, index.html
├── src/
│   ├── main.tsx, App.tsx
│   ├── theme.css                 # tailwind v4 @theme tokens
│   ├── lib/api.ts                # typed REST client
│   ├── lib/ws.ts                 # WS client (refcount, reconnect, resubscribe)
│   ├── lib/types.ts              # shared API types
│   ├── store/store.ts            # zustand store (sessions, tags, transcripts, subagents, ui)
│   ├── ui/                       # design-system primitives (props-driven)
│   │   ├── Panel.tsx, Chip.tsx, Badge.tsx, Button.tsx, StatusDot.tsx, Dialog.tsx, Input.tsx
│   ├── map/
│   │   ├── SpaceMap.tsx          # R3F canvas, camera, pan/zoom, starfield
│   │   ├── layout.ts             # pure cluster/position math
│   │   ├── Planet.tsx, Moon.tsx  # parametric body components
│   │   └── visuals.ts            # pure state→motion/appearance params
│   ├── panels/
│   │   ├── Sidebar.tsx
│   │   ├── DetailPanel.tsx
│   │   ├── Transcript.tsx, MessageView.tsx, ToolRow.tsx
│   │   ├── NewSessionDialog.tsx, ClearDialog.tsx, StopDialog.tsx
│   │   ├── TagsRules.tsx, Settings.tsx
│   └── test/ (mirrors src)
server/src/... (Task 1 only)
```

---

### Task 1: Server contract fixes (WS payload unification + revive with collision guard)

**Files:**
- Modify: `server/src/index.ts` (registry upsert handler), `server/src/runner/runner.ts` (resume guard), `server/src/api/routes.ts` (`POST /sessions/:id/messages` revive)
- Test: `server/test/routes.test.ts`, `server/test/runner.test.ts`

**Interfaces:**
- Consumes: existing `toApi`-shaped rows, `Runner.start`, `SessionRegistry` events.
- Produces (the WS contract the web client consumes):
  - `sessions` topic: `{event:'upsert', session: ApiSession}` where `ApiSession` is the REST shape `{id, cwd, title, firstAt, lastAt, messageCount, source, permissionMode, parentId, tagIds, status}` — for BOTH terminal-registry upserts and web-session creation; `{event:'status', sessionId, status}`; `{event:'remove', sessionId}`.
  - `POST /api/sessions/:id/messages` on an inactive session **revives** it: calls `runner.start({cwd, permissionMode, prompt: text, resume: id})` using the row's stored cwd/permission_mode (fallback `default_permission_mode`), returns `{ok:true, revived:true}`. 404 if unknown id, 409 only if the session is live in a TERMINAL (registry hit — cannot take over).
  - `Runner.start` throws `resume collision: session <id> already active` when `opts.resume` names a currently active session (final-review ruling).

- [ ] **Step 1: Write failing tests**

Append to `server/test/runner.test.ts`:

```ts
it('start() with resume of an active session throws (collision guard)', async () => {
  const hub = new Hub();
  const { fn } = fakeQueryFn();
  const runner = new Runner({ hub, queryFn: fn as any });
  await runner.start({ cwd: '/p', prompt: 'x', permissionMode: 'plan' });
  await expect(
    runner.start({ cwd: '/p', prompt: 'y', permissionMode: 'plan', resume: 'web-1' }),
  ).rejects.toThrow(/collision/);
});
```

Append to `server/test/routes.test.ts` (extend the runner fake in `makeApp` with a `startCalls` capture array if not already present):

```ts
it('POST /sessions/:id/messages revives an ended session via resume', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/sessions/s2/messages', payload: { text: 'wake up' },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ ok: true, revived: true });
  expect(startCalls.at(-1)).toMatchObject({ resume: 's2', prompt: 'wake up', cwd: '/w/y' });
});

it('POST /sessions/:id/messages 409s for a live terminal session', async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/sessions/s1/messages', payload: { text: 'hi' },
  });
  expect(res.statusCode).toBe(409); // s1 is live in the registry fake
});

it('registry upsert publishes REST-shaped session on the sessions topic', async () => {
  // subscribe fake socket to 'sessions', then trigger the registry handler
  // via the exported wiring (see implementation: extract publishLiveSession(ctx, live))
  // and assert the payload has {event:'upsert', session:{id, status, tagIds}}
});
```

- [ ] **Step 2: Run tests to verify they fail** (`npm test -w server -- runner routes`)

- [ ] **Step 3: Implement**

`runner.ts` — at the top of `start()`:

```ts
if (opts.resume && this.sessions.has(opts.resume)) {
  throw new Error(`resume collision: session ${opts.resume} already active`);
}
```

`routes.ts` — replace the 409-only branch of `POST /sessions/:id/messages`:

```ts
app.post('/api/sessions/:id/messages', async (req, reply) => {
  const { id } = req.params as { id: string };
  const { text } = req.body as { text: string };
  try {
    ctx.runner.send(id, text);
    return { ok: true };
  } catch {
    // inactive in runner — try revive
    const row = /* select session by id via drizzle */;
    if (!row) return reply.code(404).send({ error: 'not found' });
    if (ctx.registry.get(id)) {
      return reply.code(409).send({ error: 'session is live in a terminal' });
    }
    const permissionMode = (row.permission_mode ??
      ctx.settings.get('default_permission_mode')) as PermissionMode;
    await ctx.runner.start({ cwd: row.cwd, prompt: text, permissionMode, resume: id });
    return { ok: true, revived: true };
  }
});
```

`index.ts` — extract and use a helper so registry upserts publish REST shape:

```ts
function publishLiveSession(hub, db, registry, runner, live: LiveSession) {
  const row = /* select by live.sessionId */;
  const session = row
    ? toApiShape(row, /* status from live */)   // reuse routes' toApi via a small export
    : { id: live.sessionId, cwd: live.cwd, title: live.name, firstAt: null,
        lastAt: live.updatedAt, messageCount: 0, source: 'terminal',
        permissionMode: null, parentId: null, tagIds: [], status: live.status };
  hub.publish('sessions', { event: 'upsert', session });
}
```

Export `toApi` from routes.ts (rename export `toApiSession(ctx, row)`) or move it to a small shared module `server/src/api/shape.ts` consumed by both — pick the shared-module option to avoid a routes→index import cycle.

- [ ] **Step 4: Run tests to verify they pass**; full suite + typecheck.
- [ ] **Step 5: Commit** — `feat(server): REST-shaped sessions topic, revive endpoint, resume collision guard`

---

### Task 2: Web scaffold (Vite + Tailwind v4 + theme tokens + test rig)

**Files:**
- Create: `web/package.json`, `web/tsconfig.json`, `web/vite.config.ts`, `web/vitest.config.ts`, `web/index.html`, `web/src/main.tsx`, `web/src/App.tsx`, `web/src/theme.css`
- Test: `web/src/test/smoke.test.tsx`

**Interfaces:**
- Produces: running dev app (`npm run dev -w web` on :5173, proxied `/api`+`/ws`); Tailwind theme tokens (`--color-space`, `--color-panel-border`, `--color-text-bright`, `--color-text-muted`, `--font-sans: Manrope`, `--font-mono: "JetBrains Mono"`); test rig (vitest + jsdom + Testing Library).

- [ ] **Step 1:** `npm create vite@latest web -- --template react-ts` adjusted to workspace layout (name `@orbital/web`, private). Add deps: `tailwindcss @tailwindcss/vite zustand @react-three/fiber @react-three/drei three react-markdown remark-gfm shiki anser @fontsource/manrope @fontsource/jetbrains-mono`; devDeps: `vitest @testing-library/react @testing-library/user-event jsdom @types/three`.
- [ ] **Step 2:** `vite.config.ts` with `@tailwindcss/vite` plugin and proxy:

```ts
server: {
  proxy: {
    '/api': 'http://127.0.0.1:4737',
    '/ws': { target: 'ws://127.0.0.1:4737', ws: true },
  },
},
```

`web/src/theme.css`:

```css
@import 'tailwindcss';
@theme {
  --color-space: #05070d;
  --color-space-deep: #03111a;
  --color-panel: rgb(10 16 28 / 0.72);
  --color-panel-border: rgb(150 205 255 / 0.14);
  --color-text-bright: #e8eef8;
  --color-text-soft: #cfe6ff;
  --color-text-muted: rgb(160 190 225 / 0.7);
  --font-sans: 'Manrope', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, monospace;
}
body { background: var(--color-space); color: var(--color-text-bright); font-family: var(--font-sans); }
```

`main.tsx` imports `@fontsource/manrope/latin-400.css`, `latin-600.css`, `@fontsource/jetbrains-mono/latin-400.css`, `./theme.css`.

- [ ] **Step 3:** Smoke test renders `<App />` (placeholder "ORBITAL" wordmark) via Testing Library; `npm test -w web` green; `npm run build -w web` succeeds.
- [ ] **Step 4: Commit** — `feat(web): vite scaffold, tailwind theme tokens, test rig`

---

### Task 3: Types + REST API client

**Files:**
- Create: `web/src/lib/types.ts`, `web/src/lib/api.ts`
- Test: `web/src/test/api.test.ts`

**Interfaces:**
- Produces `web/src/lib/types.ts`:

```ts
export type SessionStatus = 'working' | 'needs_input' | 'idle' | 'ended';
export type SessionSource = 'terminal' | 'web';
export type PermissionMode = 'plan' | 'acceptEdits' | 'bypassPermissions';
export interface ApiSession {
  id: string; cwd: string; title: string;
  firstAt: number | null; lastAt: number | null; messageCount: number;
  source: SessionSource; permissionMode: PermissionMode | null;
  parentId: string | null; tagIds: number[]; status: SessionStatus;
}
export interface ChatMessage {
  id: string; role: 'user' | 'assistant' | 'tool_use' | 'tool_result';
  text?: string; toolName?: string; toolInput?: unknown; toolUseId?: string; timestamp?: string;
}
export interface Tag { id: number; name: string; hue: number; is_default: 0 | 1 }
export interface TagRule {
  id: number; tag_id: number; position: number; enabled: 0 | 1;
  condition: 'path_matches' | 'title_contains' | 'permission_is'; pattern: string;
}
export interface Subagent { id: string; name: string; state: 'materializing'|'working'|'idle'|'needs_input'|'ended' }
export const tagColor = (hue: number) => `oklch(80% 0.13 ${hue})`;
```

- Produces `api.ts`: `api.listSessions(params)`, `getSession(id)`, `getMessages(id, opts)`, `createSession(body)`, `sendMessage(id, text)` (returns `{ok, revived?}`; throws `ApiError` with `.status` on non-2xx), `interrupt(id)`, `clearSession(id, startNew)`, `renameSession(id, title)`, `setSessionTags(id, tagIds)`, tags/rules CRUD + `previewRule(body)`, `listProjects()`, `getSettings()`, `patchSettings(partial)`. One `request<T>(method, url, body?)` helper.

- [ ] Steps: failing tests with `vi.stubGlobal('fetch', ...)` asserting URL/method/body/error mapping (incl. 409 → ApiError.status===409) → implement → green → commit `feat(web): typed api client`.

---

### Task 4: WS client

**Files:**
- Create: `web/src/lib/ws.ts`
- Test: `web/src/test/ws.test.ts`

**Interfaces:**
- Produces `class OrbitalSocket`:
  - `constructor(url = '/ws', opts?: { WebSocketImpl?: typeof WebSocket, reconnectDelayMs?: number })` (injectable for tests)
  - `subscribe(topic: string, handler: (msg: any) => void): () => void` — refcounted: first handler for a topic sends `{type:'subscribe',topic}`, returned unsubscribe fn sends `{type:'unsubscribe',topic}` when the last handler leaves.
  - Auto-reconnect with delay; on reopen re-sends subscribe for every active topic.
  - `status: 'connecting'|'open'|'closed'` + `onStatusChange(cb)` (for the UI banner).
  - Incoming messages routed by `msg.topic` to that topic's handlers; malformed JSON ignored.

- [ ] Steps: failing tests with a scripted `FakeWebSocket` (capture sent frames; simulate open/message/close; assert refcount subscribe/unsubscribe, resubscribe-after-reconnect, handler routing, malformed ignored) → implement → green → commit `feat(web): refcounted ws client with reconnect`.

---

### Task 5: zustand store

**Files:**
- Create: `web/src/store/store.ts`
- Test: `web/src/test/store.test.ts`

**Interfaces:**
- Produces `useOrbital` store (vanilla-testable via `useOrbital.getState()`):
  - state: `sessions: Record<string, ApiSession>`, `order: string[]` (by lastAt desc), `tags: Tag[]`, `rules: TagRule[]`, `settings: Record<string,string>`, `transcripts: Record<string, ChatMessage[]>`, `subagents: Record<string, Subagent[]>`, `usage: Record<string, unknown>`, `ui: { selectedId: string|null; filterTagId: number|'all'; search: string; sourceFilter: 'all'|SessionSource; wsStatus: string; dialog: null|'new'|'clear'|'stop' }`
  - actions: `loadInitial()` (sessions+tags+rules+settings via api), `applySessionsEvent(msg)` (upsert/status/remove — status event merges into existing row; unknown id triggers a refetch of that session), `applySessionEvent(sessionId, msg)` (message → append with `id` dedupe; subagent → upsert by id; status → merge; turn_result → store usage), `select(id)` (+ lazy `api.getMessages` fill of transcript, prepend, dedupe), `sendPrompt(id, text)` (optimistic user message append + api.sendMessage; on ApiError 409 → surface error toast state), plus setters for filters/search/dialog.
  - selector helpers (pure, exported for tests + map): `visibleSessions(state)` (filter by tag/search/source, order), `statusCounts(state)` → `{working, idle, needs_input, ended}`.

- [ ] Steps: failing tests (pure reducers via getState actions with fixture events; dedupe by message id asserted; visibleSessions filtering asserted) → implement → green → commit `feat(web): zustand store with ws event reducers`.

---

### Task 6: Design-system primitives

**Files:**
- Create: `web/src/ui/Panel.tsx`, `Chip.tsx`, `Badge.tsx`, `Button.tsx`, `StatusDot.tsx`, `Dialog.tsx`, `Input.tsx`
- Test: `web/src/test/ui.test.tsx`

**Interfaces (props-driven, per the binding reusability rule):**
- `<Panel side?: 'left'|'right'|'float'` `collapsed?: boolean>` — glass container (panel bg, 1px panel-border, backdrop-blur, rounded); side controls width/position classes internally.
- `<Chip label active?: boolean hue?: number onClick? onRemove?>` — tag chips; when `hue` given, dot + border tint via `tagColor(hue)` inline style.
- `<Badge variant: 'status'|'mode'|'count' value ...>` — status badge maps `SessionStatus` → label + styling (working pulses via CSS animation; needs_input white accent).
- `<Button variant: 'primary'|'ghost'|'danger' size?: 'sm'|'md'>`.
- `<StatusDot status: SessionStatus hue?: number>` — the sidebar dot (working = pulse animation, ended = dim outline).
- `<Dialog open title footer onClose>` — HUD-style modal with corner brackets (design 1d/1g), esc closes.
- `<Input>` / `<TextArea>` mono-styled variants via `font?: 'sans'|'mono'` prop.

- [ ] Steps: failing render tests per component (variant → expected class/attr/label; Dialog esc; Chip hue style) → implement → green → commit `feat(web): props-driven design system primitives`.

---

### Task 7: Map layout math (pure)

**Files:**
- Create: `web/src/map/layout.ts`
- Test: `web/src/test/layout.test.ts`

**Interfaces:**
- Produces pure functions (no React/three imports):
  - `clusterSessions(sessions: ApiSession[], tags: Tag[]): Cluster[]` — group by primary tag (first tagId; default tag last); `Cluster = { tagId, hue, label, sessions }`.
  - `layoutClusters(clusters, opts?): Map<string, {x:number,y:number,scale:number}>` — clusters placed on a large circle around origin (deterministic by tagId order); inside a cluster, sessions on a golden-angle spiral (`i * 2.39996` rad, radius `∝ √i`), spacing by planet scale; scale: active 1.0, ended 0.45; stable for stable input (pure, no randomness — positions must not jump between renders).
  - `clusterLabelPos(cluster, positions)` → label anchor.

- [ ] Steps: failing tests (determinism: same input → identical output; ended scale; no two planets closer than min distance for N=30 fixture; cluster separation) → implement → green → commit `feat(web): deterministic map layout`.

---

### Task 8: Planet & Moon visual params + components

**Files:**
- Create: `web/src/map/visuals.ts`, `web/src/map/Planet.tsx`, `web/src/map/Moon.tsx`
- Test: `web/src/test/visuals.test.ts`

**Interfaces:**
- `visuals.ts` (pure, tested): `planetVisuals(state: SessionStatus, selected: boolean): { tickSpin: number; corePulse: number; haloOpacity: number; rippleActive: boolean; dimmed: boolean; reticle: boolean }` per the state sheet — working `{tickSpin:0.4, corePulse:1, haloOpacity:.5, ...}`, idle `{tickSpin:0, corePulse:0, haloOpacity:.25}`, needs_input `{rippleActive:true, white core}`, ended `{dimmed:true, haloOpacity:0, tickSpin:0}`; `moonVisuals(state: Subagent['state'])` similarly (materializing = dashed shell fade-in).
- `<Planet session x y scale selected onClick>` — flat 2D meshes (circleGeometry core, ringGeometry atmosphere tinted `tagColor(hue)`, instanced tick marks around, halo sprite); `useFrame` drives rotation/pulse/ripple from `planetVisuals`; ended rendered dimmed+small; selection reticle = slow-rotating dashed ring + corner brackets; label (session title, mono, muted) as `<Html>` from drei under the planet.
- `<Moon subagent parentX parentY orbitRadius phase>` — small disc orbiting via `useFrame` clock, luminous dashed orbit ring; state via `moonVisuals`.
- Colors: core/atmosphere from `tagColor(hue)`; state NEVER changes hue (only white ripple/core for needs_input) — assert in tests that `planetVisuals` output contains no hue field.

- [ ] Steps: failing tests for `planetVisuals`/`moonVisuals` (full state table, selected flag, no-hue invariant) → implement visuals.ts → green → implement components (rendered smoke-tested in Task 9's scene test, not pixel-tested here) → commit `feat(web): planet and moon parametric components`.

---

### Task 9: SpaceMap scene

**Files:**
- Create: `web/src/map/SpaceMap.tsx`
- Test: `web/src/test/spacemap.test.tsx`

**Interfaces:**
- `<SpaceMap />` — R3F `<Canvas orthographic camera={{ zoom: 60, position: [0,0,100] }}>`; starfield (drei `<Stars>` tuned subtle + a faint nebula gradient plane); renders from store via `visibleSessions` + `layoutClusters`; cluster labels (`WORK · 3` style, mono uppercase) via `<Html>`; moons for `subagents[selectedId]` and for any session with live subagents; pan = pointer drag moving camera position, zoom = wheel/pinch clamping zoom 20–200 (custom `MapControls`-like handler on the ortho camera — no rotation); click planet → `select(id)`; bottom-left readout `zoom% · x y` and bottom-right `+ / − / fit` controls (fit = bounding box of positions); floating `+ New session ⌘N` button; top-right aggregate `2 WORKING · 3 IDLE · 4 ENDED` from `statusCounts`; sloth easter egg: `design/.../assets/sloth.svg` copied to `web/public/sloth.svg`, drifting slowly via `<Html>` with CSS animation.
- Scene logic split so tests don't need WebGL: derived render-model builder `buildSceneModel(state): { planets: [...], moons: [...], labels: [...], counts }` exported and unit-tested; `SpaceMap` maps model → components.

- [ ] Steps: failing tests for `buildSceneModel` (fixture store state → expected planets with x/y/scale/state, labels, counts; selected flag propagation) → implement → green → manual smoke vs running server (`npm run dev` both, planets for your real history render, statuses tick) → commit `feat(web): space map scene with pan/zoom`.

---

### Task 10: Sidebar

**Files:**
- Create: `web/src/panels/Sidebar.tsx`
- Test: `web/src/test/sidebar.test.tsx`

**Interfaces:**
- `<Sidebar />` per artboard 1a: Orbital wordmark + collapse toggle («); search input (⌘K focuses); tag filter chips (All + each tag w/ hue + count) wired to `ui.filterTagId`; source toggle (all/terminal/web); ACTIVE section (status label WORKING/IDLE/NEEDS INPUT right-aligned mono) listing non-ended sessions; HISTORY (relative time — `timeAgo(ts)` helper exported + tested) with infinite scroll (IntersectionObserver sentinel → `api.listSessions offset` append); rows: title, cwd shortened (`~/…/last-two/segments` helper, tested), tag dots, StatusDot; click → `select(id)`; footer `N sessions · tags & rules ›` (opens TagsRules) .

- [ ] Steps: failing Testing Library tests (filtering by chip click, search typing narrows list, active vs history split, row click selects, timeAgo/shortenPath units) → implement → green → commit `feat(web): sidebar with filters and history`.

---

### Task 11: Transcript renderer

**Files:**
- Create: `web/src/panels/Transcript.tsx`, `MessageView.tsx`, `ToolRow.tsx`, `web/src/lib/highlight.ts`
- Test: `web/src/test/transcript.test.tsx`

**Interfaces:**
- `highlight.ts`: lazy singleton shiki highlighter (`getHighlighter({theme:'github-dark-default'})` via dynamic import, langs on demand, plain-text fallback on unknown lang) exported as `highlightCode(code, lang): Promise<string>`.
- `<MessageView message>` — role user/assistant: markdown via react-markdown + remark-gfm, code blocks async-highlighted (accessible fallback `<pre>` until resolved); role tool_use/tool_result handled by ToolRow pairing.
- `<ToolRow toolUse toolResult?>` — collapsed one-liner `⚙ Bash: npm test` (tool name + salient input: `command` for Bash, `file_path` for Read/Edit/Write, `description` for Task, else first input value); expand → full input JSON + result; Bash results rendered through `anser` (ANSI→HTML, `ansiToHtml(text)` helper exported + tested with a `[32m✓[0m` fixture); running state (no result yet) shows a pulsing dot.
- `<Transcript sessionId>` — virtualless list (windowing deferred; render last 200, "load older" button prepends via store), pairs tool_use with its tool_result by `toolUseId`, auto-scroll to bottom on append when already at bottom.

- [ ] Steps: failing tests (markdown renders, gfm table, tool pairing by toolUseId, ANSI colors present in output HTML, collapsed label extraction per tool, running state) → implement → green → commit `feat(web): transcript renderer with tool rows`.

---

### Task 12: Detail panel + session dialogs

**Files:**
- Create: `web/src/panels/DetailPanel.tsx`, `StopDialog.tsx`, `ClearDialog.tsx`
- Test: `web/src/test/detail.test.tsx`

**Interfaces:**
- `<DetailPanel />` (right Panel, open when `ui.selectedId`): header — editable title (blur/enter → `api.renameSession`), cwd (mono, muted), tag chips (click toggles via `setSessionTags` w/ optimistic update), permission-mode Badge, status Badge, token usage row from `usage[id]` + context bar; body — `<Transcript>` + live subagents strip (name + state, from store) when any; footer by session kind:
  - web/ended: prompt textarea + Send (`sendPrompt`; on `revived` just proceed — store will get WS events) + Stop button while `working` (opens StopDialog per artboard 1b: shows current tool row, Keep running / Stop turn → `api.interrupt`).
  - live terminal: read-only bar "runs in terminal — read-only"; take-over blocked (button disabled with tooltip; server 409 is the backstop).
  - Clear button in header (web sessions) → ClearDialog per artboard 1g: lineage preview (`#N → #N+1`, inherits line), "Don't ask again" (patches `confirm_before_clear`), Cancel / Clear only / Clear & start new → `api.clearSession`; on `{sessionId}` select the new one. Skips dialog entirely when `confirm_before_clear==='false'`.
  - Lineage chain (from `getSession(id).lineage`) rendered as small linked dots in header when non-empty.

- [ ] Steps: failing tests (title rename fires PATCH; send appends optimistic message + POSTs; 409 shows terminal-live error; Stop flow calls interrupt only after confirm; Clear only vs Clear&start new both wired; confirm_before_clear=false bypasses dialog) → implement → green → commit `feat(web): detail panel, stop and clear flows`.

---

### Task 13: New session dialog, Tags & rules, Settings

**Files:**
- Create: `web/src/panels/NewSessionDialog.tsx`, `TagsRules.tsx`, `Settings.tsx`
- Test: `web/src/test/newsession.test.tsx`, `web/src/test/tagsrules.test.tsx`, `web/src/test/settings.test.tsx`

**Interfaces:**
- `<NewSessionDialog />` (artboard 1d): cwd input + recent chips (`listProjects`), Browse omitted v1 (text input suffices — note in dialog); permission mode cards (plan/acceptEdits/bypassPermissions with the design's one-line descriptions, default from settings); tag row auto-selected via `previewRule({cwd, title:'', permissionMode})` with caption `auto-matched by rule …`, overridable; first prompt textarea; footer `spawns a new planet in <TAG>`; Launch (⌘↵) → `createSession({cwd, prompt, permissionMode, tagId})` → select new id.
- `<TagsRules />` (artboard 1e, opened from sidebar footer; rendered as overlay Panel): left tag list (name inline-edit, session+rule counts, 8 hue swatches from the design [210,225,270,330,10,60,90,150], delete disabled for default); right AUTO-TAG RULES table ordered by position — reorder via up/down buttons (drag deferred, note in code comment), condition select, pattern input (debounced PATCH), target tag select, enable toggle, delete, + Add rule; caption `evaluated top → bottom, first match wins`; PREVIEW row: sample path input → `previewRule` → matched tag + rule index; footer note about hue + default fallback.
- `<Settings />` (artboard 1h, Sessions section only): default permission mode cards, default project dir input, lineage depth segmented control (1–5/∞ maps to `'Infinity'` string), confirm-before-clear toggle, inherit checkboxes (tags, permission mode), ended-after idle select (15/30/60 min); every control PATCHes `/api/settings` debounced; footer shows orbital version (package.json import) + `claude-code <version>` read from a new tiny endpoint? — NO (YAGNI): show orbital version only.
- Left-nav within the overlay: General/Permissions/Appearance/Shortcuts listed but disabled with "soon" caption (spec defers them).

- [ ] Steps: failing tests per panel (launch payload correct incl. previewed tag; rule reorder swaps positions via PATCH; hue swatch PATCHes; settings PATCH debounce; lineage-depth ∞) → implement → green → commit `feat(web): new session, tags-rules, settings panels`.

---

### Task 14: App shell, WS lifecycle, error states, README

**Files:**
- Modify: `web/src/App.tsx`, `web/src/main.tsx`
- Create: `web/src/test/app.test.tsx`, `README.md` (repo root)
- Test: `web/src/test/app.test.tsx`

**Interfaces:**
- `App`: on mount `loadInitial()` + one `OrbitalSocket`; subscribe `sessions` for the store; subscribe `session:<id>` while selected (unsubscribe on change — refcounted client makes this cheap); keyboard: ⌘K search focus, ⌘N new session, Esc closes dialogs/panel; layout: `<SpaceMap>` full-bleed, `<Sidebar>` left, `<DetailPanel>` right, dialogs portal; WS status ≠ open → top banner `reconnecting…` (auto via `onStatusChange`); ApiError toasts (single `<Toasts>` in ui store).
- Error states per spec: WS disconnect banner + auto-resubscribe (client from Task 4 handles it — assert wiring); session `ended` + error message row when a `status:'ended'` arrives mid-`working` without turn_result (store flag → Transcript renders an error line).
- README: what Orbital is, prerequisites, `npm install`, run server + web, screenshot placeholder, ports, billing guard note, undocumented-internals disclaimer.

- [ ] Steps: failing tests (mount subscribes sessions; selecting subscribes session:<id> and unsubscribes previous; ⌘N opens dialog; banner on ws closed) → implement → green → full monorepo check (`npm test -w server && npm test -w web`, both typechecks, `npm run build -w web`) → manual smoke: server + web running, real map renders, open a terminal session detail, watch live tail → commit `feat(web): app shell, ws lifecycle, error states, readme`.

---

## Self-review notes

- Spec coverage: design language ✓ (T2 tokens, T6 primitives, T8 visuals per state sheet), space map ✓ (T7-9 incl. cluster labels, aggregate counts, zoom readout, sloth), sidebar ✓ (T10), detail panel + stop/clear/lineage ✓ (T12), new session ✓ (T13), tags & rules incl. first-match preview ✓ (T13), settings Sessions section ✓ (T13, others deferred per spec), message rendering ✓ (T11: react-markdown+gfm, shiki, anser, tool rows), error states ✓ (T14), component reusability rule ✓ (Global Constraints + T6/T8 parametric design), WS contract fixes + revive/collision rulings ✓ (T1).
- Deviations from artboards, deliberate: Browse button → text input (v1), rule drag-reorder → up/down buttons (v1), claude-code version in settings footer dropped (YAGNI). Each noted in its task.
- Type consistency: `ApiSession`/`ChatMessage`/`Tag`/`TagRule` in T3 match the server's actual wire shapes (camelCase sessions, snake_case tags/rules) — verified against `server/src/api/routes.ts` + `shape.ts` introduced in T1.
