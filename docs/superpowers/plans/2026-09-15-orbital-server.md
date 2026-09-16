---
id: 2026-09-15-orbital-server
title: 2026-09-15-orbital-server
status: done
type: plan
---
# Orbital Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Orbital backend — a local Fastify server that indexes Claude Code session history into SQLite, watches live sessions, spawns/drives web sessions via the Claude Agent SDK, and exposes REST + WebSocket APIs.

**Architecture:** One Node process with four modules: `indexer` (incremental scan of `~/.claude/projects/**/*.jsonl` → SQLite), `watcher` (live-session registry from `~/.claude/sessions/` + transcript tailing), `runner` (Agent SDK sessions with streaming input, resume, clear/lineage), `api` (REST + topic-multiplexed WebSocket). All Claude Code file formats are undocumented — every parser fails soft.

**Tech Stack:** TypeScript, Fastify 5 + @fastify/websocket, better-sqlite3, chokidar, @anthropic-ai/claude-agent-sdk, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-15-orbital-design.md`

## Global Constraints

- Server binds to `127.0.0.1` only, no auth.
- DB file: `~/Library/Application Support/orbital/index.db` (overridable via `ORBITAL_DATA_DIR` for tests).
- Claude dir: `~/.claude` (overridable via `ORBITAL_CLAUDE_DIR` for tests).
- Parsers never throw on malformed input: skip the record, `console.warn`, continue.
- Session status enum everywhere: `working | needs_input | idle | ended`.
- Tag rule evaluation: ordered by `position`, top → bottom, first **enabled** match wins; manual tag rows are never touched by rule regeneration.
- Web sessions run the SDK with `systemPrompt: {type:'preset', preset:'claude_code'}`, `settingSources: ['user','project','local']`.
- Node 20+, ESM (`"type": "module"`), strict TypeScript.
- Commit after every task (conventional commits: `feat:`, `test:`, `chore:`).

---

## File Structure

```
orbital/
├── package.json                    # npm workspaces root
├── server/
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   ├── src/
│   │   ├── config.ts               # env-overridable paths
│   │   ├── types.ts                # shared domain types
│   │   ├── db/database.ts          # open DB + run migrations + settings defaults
│   │   ├── transcript/parser.ts    # jsonl → entries, meta, chat messages
│   │   ├── transcript/subagents.ts # Task tool call tracking → moon states
│   │   ├── tags/rules.ts           # rule engine + regeneration
│   │   ├── indexer/indexer.ts      # incremental scan → sessions table
│   │   ├── watcher/registry.ts     # live sessions from ~/.claude/sessions
│   │   ├── watcher/tail.ts         # transcript tailer (byte offset)
│   │   ├── api/hub.ts              # WS topic hub
│   │   ├── api/routes.ts           # REST routes
│   │   ├── runner/runner.ts        # Agent SDK session manager
│   │   └── index.ts                # boot: wire everything, listen
│   └── test/
│       ├── fixtures/transcript-basic.jsonl
│       ├── fixtures/transcript-subagents.jsonl
│       ├── database.test.ts
│       ├── parser.test.ts
│       ├── subagents.test.ts
│       ├── rules.test.ts
│       ├── indexer.test.ts
│       ├── registry.test.ts
│       ├── tail.test.ts
│       ├── hub.test.ts
│       ├── routes.test.ts
│       └── runner.test.ts
```

---

### Task 1: Workspace scaffold, config, database with migrations

**Files:**
- Create: `package.json`, `server/package.json`, `server/tsconfig.json`, `server/vitest.config.ts`
- Create: `server/src/config.ts`, `server/src/types.ts`, `server/src/db/database.ts`
- Test: `server/test/database.test.ts`

**Interfaces:**
- Produces: `openDb(dbPath?: string): Database.Database` — opens SQLite, runs idempotent migrations, seeds default settings and the default `personal` tag. `CONFIG` object with `claudeDir`, `projectsDir`, `sessionsDir`, `dataDir`, `dbPath`.

- [ ] **Step 1: Scaffold workspace**

```bash
cd ~/Projects/slothworks/orbital
```

Root `package.json`:

```json
{
  "name": "orbital",
  "private": true,
  "type": "module",
  "workspaces": ["server", "web"]
}
```

`server/package.json`:

```json
{
  "name": "@orbital/server",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.3.0",
    "@fastify/websocket": "^11.0.0",
    "better-sqlite3": "^11.8.0",
    "chokidar": "^4.0.0",
    "fastify": "^5.2.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

`server/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

`server/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
```

Run: `npm install`
Expected: installs cleanly (better-sqlite3 compiles a native module).

- [ ] **Step 2: Write config and types**

`server/src/config.ts`:

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';

const claudeDir = process.env.ORBITAL_CLAUDE_DIR ?? join(homedir(), '.claude');
const dataDir =
  process.env.ORBITAL_DATA_DIR ?? join(homedir(), 'Library', 'Application Support', 'orbital');

export const CONFIG = {
  claudeDir,
  projectsDir: join(claudeDir, 'projects'),
  sessionsDir: join(claudeDir, 'sessions'),
  dataDir,
  dbPath: join(dataDir, 'index.db'),
  port: Number(process.env.ORBITAL_PORT ?? 4737),
};
```

`server/src/types.ts`:

```ts
export type SessionSource = 'terminal' | 'web';
export type SessionStatus = 'working' | 'needs_input' | 'idle' | 'ended';
export type PermissionMode = 'plan' | 'acceptEdits' | 'bypassPermissions';
export type SubagentState = 'materializing' | 'working' | 'idle' | 'needs_input' | 'ended';

export interface SessionRow {
  id: string;
  project_dir: string;
  cwd: string;
  title: string;
  first_at: number | null;
  last_at: number | null;
  message_count: number;
  file_size: number;
  source: SessionSource;
  permission_mode: PermissionMode | null;
  parent_id: string | null;
  indexed_mtime: number;
  indexed_size: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool_use' | 'tool_result';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  timestamp?: string;
}

export interface TagRule {
  id: number;
  tag_id: number;
  position: number;
  enabled: 0 | 1;
  condition: 'path_matches' | 'title_contains' | 'permission_is';
  pattern: string;
}
```

- [ ] **Step 3: Write the failing test**

`server/test/database.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/database.js';

describe('openDb', () => {
  it('creates schema, seeds defaults, and is idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbital-db-'));
    const db = openDb(join(dir, 'index.db'));
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all()
      .map((r: any) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining(['sessions', 'session_tags', 'settings', 'tag_rules', 'tags']),
    );
    const def = db.prepare(`SELECT name, hue, is_default FROM tags WHERE is_default = 1`).get() as any;
    expect(def.name).toBe('personal');
    expect(def.hue).toBe(330);
    const mode = db.prepare(`SELECT value FROM settings WHERE key='default_permission_mode'`).get() as any;
    expect(mode.value).toBe('acceptEdits');
    db.close();
    const again = openDb(join(dir, 'index.db')); // must not throw on re-run
    expect(again.prepare(`SELECT COUNT(*) c FROM tags`).get()).toMatchObject({ c: 1 });
    again.close();
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test -w server -- database`
Expected: FAIL — `Cannot find module '../src/db/database.js'`

- [ ] **Step 5: Implement the database module**

`server/src/db/database.ts`:

```ts
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_dir TEXT NOT NULL,
  cwd TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  first_at INTEGER,
  last_at INTEGER,
  message_count INTEGER NOT NULL DEFAULT 0,
  file_size INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'terminal',
  permission_mode TEXT,
  parent_id TEXT,
  indexed_mtime INTEGER NOT NULL DEFAULT 0,
  indexed_size INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_last_at ON sessions(last_at DESC);
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  hue INTEGER NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS session_tags (
  session_id TEXT NOT NULL,
  tag_id INTEGER NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('rule','manual','manual_removed')),
  PRIMARY KEY (session_id, tag_id, origin)
);
CREATE TABLE IF NOT EXISTS tag_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  condition TEXT NOT NULL CHECK (condition IN ('path_matches','title_contains','permission_is')),
  pattern TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const DEFAULT_SETTINGS: Record<string, string> = {
  default_permission_mode: 'acceptEdits',
  default_project_dir: '',
  lineage_depth: '3',
  confirm_before_clear: 'true',
  inherit_tags: 'true',
  inherit_permission_mode: 'true',
  ended_after_idle_minutes: '30',
};

export function openDb(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  const insertSetting = db.prepare(
    `INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`,
  );
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);
  db.prepare(
    `INSERT OR IGNORE INTO tags (name, hue, is_default) VALUES ('personal', 330, 1)`,
  ).run();
  return db;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -w server -- database` → PASS.
Run: `npm run typecheck -w server` → no errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(server): scaffold workspace, config, sqlite schema with defaults"
```

---

### Task 2: Transcript parser

**Files:**
- Create: `server/src/transcript/parser.ts`, `server/test/fixtures/transcript-basic.jsonl`
- Test: `server/test/parser.test.ts`

**Interfaces:**
- Produces:
  - `parseTranscriptLine(line: string): TranscriptEntry | null` — one JSONL line, null on garbage.
  - `parseTranscript(text: string): TranscriptEntry[]`
  - `extractMeta(entries: TranscriptEntry[]): { cwd: string; title: string; firstAt: number | null; lastAt: number | null; messageCount: number }`
  - `entriesToMessages(entries: TranscriptEntry[]): ChatMessage[]` — flattens content blocks: text → one message, tool_use → one `tool_use` message, tool_result → one `tool_result` message.
  - `TranscriptEntry` type: `{ type: string; uuid?: string; timestamp?: string; cwd?: string; isSidechain?: boolean; message?: { role: string; content: string | Array<Record<string, unknown>> } }`

- [ ] **Step 1: Create the fixture**

`server/test/fixtures/transcript-basic.jsonl` (4 lines; line 3 is deliberately corrupt):

```jsonl
{"type":"user","uuid":"u1","timestamp":"2026-09-01T10:00:00.000Z","cwd":"/Users/tomin/Projects/slothworks/ergaily","message":{"role":"user","content":"Fix the login bug in the auth service please"}}
{"type":"assistant","uuid":"a1","timestamp":"2026-09-01T10:00:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Looking at it."},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"npm test"}}]}}
{this line is corrupt garbage
{"type":"user","uuid":"u2","timestamp":"2026-09-01T10:01:00.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"3 passing"}]}}
```

- [ ] **Step 2: Write the failing test**

`server/test/parser.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTranscript, extractMeta, entriesToMessages } from '../src/transcript/parser.js';

const text = readFileSync(join(import.meta.dirname, 'fixtures/transcript-basic.jsonl'), 'utf8');

describe('parseTranscript', () => {
  it('skips corrupt lines without throwing', () => {
    expect(parseTranscript(text)).toHaveLength(3);
  });
});

describe('extractMeta', () => {
  it('derives cwd, title, timestamps, count', () => {
    const meta = extractMeta(parseTranscript(text));
    expect(meta.cwd).toBe('/Users/tomin/Projects/slothworks/ergaily');
    expect(meta.title).toBe('Fix the login bug in the auth service please');
    expect(meta.firstAt).toBe(Date.parse('2026-09-01T10:00:00.000Z'));
    expect(meta.lastAt).toBe(Date.parse('2026-09-01T10:01:00.000Z'));
    expect(meta.messageCount).toBe(3);
  });
});

describe('entriesToMessages', () => {
  it('flattens content blocks to chat messages', () => {
    const msgs = entriesToMessages(parseTranscript(text));
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool_use', 'tool_result']);
    expect(msgs[2]).toMatchObject({ toolName: 'Bash', toolUseId: 't1' });
    expect(msgs[3]).toMatchObject({ toolUseId: 't1', text: '3 passing' });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -w server -- parser`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the parser**

`server/src/transcript/parser.ts`:

```ts
import type { ChatMessage } from '../types.js';

export interface TranscriptEntry {
  type: string;
  uuid?: string;
  timestamp?: string;
  cwd?: string;
  isSidechain?: boolean;
  message?: { role: string; content: string | Array<Record<string, unknown>> };
}

export function parseTranscriptLine(line: string): TranscriptEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (typeof obj !== 'object' || obj === null || typeof obj.type !== 'string') return null;
    return obj as TranscriptEntry;
  } catch {
    return null;
  }
}

export function parseTranscript(text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of text.split('\n')) {
    const e = parseTranscriptLine(line);
    if (e) entries.push(e);
  }
  return entries;
}

function textOf(content: string | Array<Record<string, unknown>>): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

export function extractMeta(entries: TranscriptEntry[]) {
  let cwd = '';
  let title = '';
  let firstAt: number | null = null;
  let lastAt: number | null = null;
  let messageCount = 0;
  for (const e of entries) {
    if (!cwd && typeof e.cwd === 'string') cwd = e.cwd;
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    if (e.isSidechain) continue;
    messageCount++;
    const t = e.timestamp ? Date.parse(e.timestamp) : NaN;
    if (!Number.isNaN(t)) {
      if (firstAt === null) firstAt = t;
      lastAt = t;
    }
    if (!title && e.type === 'user' && e.message) {
      const text = textOf(e.message.content).trim();
      if (text) title = text.slice(0, 120);
    }
  }
  return { cwd, title, firstAt, lastAt, messageCount };
}

export function entriesToMessages(entries: TranscriptEntry[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const e of entries) {
    if ((e.type !== 'user' && e.type !== 'assistant') || !e.message || e.isSidechain) continue;
    const base = { timestamp: e.timestamp };
    const content = e.message.content;
    if (typeof content === 'string') {
      out.push({ id: `${e.uuid}:0`, role: e.type, text: content, ...base });
      continue;
    }
    content.forEach((block, i) => {
      const id = `${e.uuid}:${i}`;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        out.push({ id, role: e.type as 'user' | 'assistant', text: block.text, ...base });
      } else if (block.type === 'tool_use') {
        out.push({
          id, role: 'tool_use', toolName: String(block.name ?? ''),
          toolInput: block.input, toolUseId: String(block.id ?? ''), ...base,
        });
      } else if (block.type === 'tool_result') {
        out.push({
          id, role: 'tool_result', toolUseId: String(block.tool_use_id ?? ''),
          text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
          ...base,
        });
      }
    });
  }
  return out;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -w server -- parser` → PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(server): fail-soft transcript parser with meta extraction"
```

---

### Task 3: Subagent tracker

**Files:**
- Create: `server/src/transcript/subagents.ts`, `server/test/fixtures/transcript-subagents.jsonl`
- Test: `server/test/subagents.test.ts`

**Interfaces:**
- Consumes: `TranscriptEntry` from Task 2.
- Produces: `trackSubagents(entries: TranscriptEntry[]): Array<{ id: string; name: string; state: 'working' | 'ended' }>` — one item per `Task` tool_use; `working` until a matching tool_result appears. `name` = the Task input's `description` (fallback `subagent_type`, fallback `'subagent'`). The richer moon states (`materializing`, `needs_input`) are runner/UI concerns, not derivable from transcripts.

- [ ] **Step 1: Create the fixture**

`server/test/fixtures/transcript-subagents.jsonl`:

```jsonl
{"type":"assistant","uuid":"a1","timestamp":"2026-09-01T11:00:00.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"task1","name":"Task","input":{"description":"test-runner","subagent_type":"general-purpose","prompt":"run tests"}},{"type":"tool_use","id":"task2","name":"Task","input":{"description":"docs-writer","subagent_type":"general-purpose","prompt":"write docs"}},{"type":"tool_use","id":"b1","name":"Bash","input":{"command":"ls"}}]}}
{"type":"user","uuid":"u1","timestamp":"2026-09-01T11:02:00.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"task1","content":"tests pass"}]}}
```

- [ ] **Step 2: Write the failing test**

`server/test/subagents.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTranscript } from '../src/transcript/parser.js';
import { trackSubagents } from '../src/transcript/subagents.js';

describe('trackSubagents', () => {
  it('marks resolved Task calls ended, open ones working; ignores non-Task tools', () => {
    const entries = parseTranscript(
      readFileSync(join(import.meta.dirname, 'fixtures/transcript-subagents.jsonl'), 'utf8'),
    );
    expect(trackSubagents(entries)).toEqual([
      { id: 'task1', name: 'test-runner', state: 'ended' },
      { id: 'task2', name: 'docs-writer', state: 'working' },
    ]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -w server -- subagents` → FAIL, module not found.

- [ ] **Step 4: Implement**

`server/src/transcript/subagents.ts`:

```ts
import type { TranscriptEntry } from './parser.js';

export interface SubagentInfo {
  id: string;
  name: string;
  state: 'working' | 'ended';
}

export function trackSubagents(entries: TranscriptEntry[]): SubagentInfo[] {
  const agents = new Map<string, SubagentInfo>();
  for (const e of entries) {
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === 'tool_use' && block.name === 'Task') {
        const input = (block.input ?? {}) as Record<string, unknown>;
        const name =
          (typeof input.description === 'string' && input.description) ||
          (typeof input.subagent_type === 'string' && input.subagent_type) ||
          'subagent';
        agents.set(String(block.id), { id: String(block.id), name, state: 'working' });
      } else if (block.type === 'tool_result') {
        const existing = agents.get(String(block.tool_use_id));
        if (existing) existing.state = 'ended';
      }
    }
  }
  return [...agents.values()];
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -w server -- subagents` → PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(server): subagent tracking from Task tool calls"
```

---

### Task 4: Tag rule engine

**Files:**
- Create: `server/src/tags/rules.ts`
- Test: `server/test/rules.test.ts`

**Interfaces:**
- Consumes: `openDb` (Task 1), `TagRule` type (Task 1).
- Produces:
  - `matchRule(rules: TagRule[], s: { cwd: string; title: string; permissionMode: string | null }): TagRule | null` — pure; ordered by `position`, first enabled match wins. `path_matches` supports `*` and `**` globs with `~` expanded to `$HOME`; `title_contains` is case-insensitive substring; `permission_is` is exact match.
  - `regenerateRuleTags(db: Database): void` — deletes all `origin='rule'` rows, re-inserts per `matchRule` for every session, skipping sessions that have a `manual_removed` row for the matched tag. Never touches `manual`/`manual_removed` rows.
  - `effectiveTagIds(db: Database, sessionId: string): number[]` — union of `rule` + `manual` rows; if empty, `[defaultTagId]`.

- [ ] **Step 1: Write the failing test**

`server/test/rules.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db/database.js';
import { matchRule, regenerateRuleTags, effectiveTagIds } from '../src/tags/rules.js';
import type { TagRule } from '../src/types.js';

const rules: TagRule[] = [
  { id: 1, tag_id: 10, position: 0, enabled: 1, condition: 'path_matches', pattern: '~/work/**' },
  { id: 2, tag_id: 11, position: 1, enabled: 1, condition: 'title_contains', pattern: 'exp-' },
  { id: 3, tag_id: 12, position: 2, enabled: 0, condition: 'permission_is', pattern: 'bypassPermissions' },
];

describe('matchRule', () => {
  it('first enabled match wins, in position order', () => {
    const s = { cwd: join(homedir(), 'work/platform'), title: 'exp-vector', permissionMode: null };
    expect(matchRule(rules, s)?.tag_id).toBe(10);
  });
  it('skips disabled rules', () => {
    const s = { cwd: '/elsewhere', title: 'x', permissionMode: 'bypassPermissions' };
    expect(matchRule(rules, s)).toBeNull();
  });
  it('title_contains is case-insensitive', () => {
    const s = { cwd: '/elsewhere', title: 'EXP-run', permissionMode: null };
    expect(matchRule(rules, s)?.tag_id).toBe(11);
  });
});

describe('regenerateRuleTags + effectiveTagIds', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb(join(mkdtempSync(join(tmpdir(), 'orbital-rules-')), 'index.db'));
    db.prepare(`INSERT INTO tags (id, name, hue) VALUES (10, 'work', 210)`).run();
    db.prepare(
      `INSERT INTO tag_rules (tag_id, position, enabled, condition, pattern)
       VALUES (10, 0, 1, 'title_contains', 'auth')`,
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, project_dir, cwd, title) VALUES
       ('s1', 'p', '/x', 'auth refactor'), ('s2', 'p', '/x', 'recipes')`,
    ).run();
  });
  it('assigns rule tags, respects manual_removed, falls back to default', () => {
    db.prepare(`INSERT INTO session_tags VALUES ('s2', 10, 'manual_removed')`).run();
    regenerateRuleTags(db);
    expect(effectiveTagIds(db, 's1')).toEqual([10]);
    const defaultId = (db.prepare(`SELECT id FROM tags WHERE is_default=1`).get() as any).id;
    expect(effectiveTagIds(db, 's2')).toEqual([defaultId]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- rules` → FAIL, module not found.

- [ ] **Step 3: Implement**

`server/src/tags/rules.ts`:

```ts
import type Database from 'better-sqlite3';
import { homedir } from 'node:os';
import type { TagRule } from '../types.js';

function globToRegExp(glob: string): RegExp {
  const expanded = glob.startsWith('~') ? homedir() + glob.slice(1) : glob;
  const escaped = expanded
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, ' ')
    .replace(/\*/g, '[^/]*')
    .replace(/ /g, '.*');
  return new RegExp(`^${escaped}$`);
}

export function matchRule(
  rules: TagRule[],
  s: { cwd: string; title: string; permissionMode: string | null },
): TagRule | null {
  const ordered = [...rules].sort((a, b) => a.position - b.position);
  for (const rule of ordered) {
    if (!rule.enabled) continue;
    switch (rule.condition) {
      case 'path_matches':
        if (globToRegExp(rule.pattern).test(s.cwd)) return rule;
        break;
      case 'title_contains':
        if (s.title.toLowerCase().includes(rule.pattern.toLowerCase())) return rule;
        break;
      case 'permission_is':
        if (s.permissionMode === rule.pattern) return rule;
        break;
    }
  }
  return null;
}

export function regenerateRuleTags(db: Database.Database): void {
  const rules = db.prepare(`SELECT * FROM tag_rules`).all() as TagRule[];
  const sessions = db
    .prepare(`SELECT id, cwd, title, permission_mode FROM sessions`)
    .all() as Array<{ id: string; cwd: string; title: string; permission_mode: string | null }>;
  const removed = db.prepare(
    `SELECT 1 FROM session_tags WHERE session_id=? AND tag_id=? AND origin='manual_removed'`,
  );
  const insert = db.prepare(`INSERT OR IGNORE INTO session_tags VALUES (?, ?, 'rule')`);
  db.transaction(() => {
    db.prepare(`DELETE FROM session_tags WHERE origin='rule'`).run();
    for (const s of sessions) {
      const rule = matchRule(rules, {
        cwd: s.cwd, title: s.title, permissionMode: s.permission_mode,
      });
      if (rule && !removed.get(s.id, rule.tag_id)) insert.run(s.id, rule.tag_id);
    }
  })();
}

export function effectiveTagIds(db: Database.Database, sessionId: string): number[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT tag_id FROM session_tags
       WHERE session_id=? AND origin IN ('rule','manual') ORDER BY tag_id`,
    )
    .all(sessionId) as Array<{ tag_id: number }>;
  if (rows.length > 0) return rows.map((r) => r.tag_id);
  const def = db.prepare(`SELECT id FROM tags WHERE is_default=1`).get() as { id: number };
  return [def.id];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- rules` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): ordered first-match-wins tag rule engine"
```

---

### Task 5: Indexer

**Files:**
- Create: `server/src/indexer/indexer.ts`
- Test: `server/test/indexer.test.ts`

**Interfaces:**
- Consumes: `parseTranscript`, `extractMeta` (Task 2); `regenerateRuleTags` (Task 4); `openDb` (Task 1).
- Produces: `indexProjects(db: Database, projectsDir: string): { scanned: number; indexed: number }` — walks `<projectsDir>/*/*.jsonl`; for each file whose `(mtimeMs, size)` differ from the stored row, parses and upserts the session (id = filename without `.jsonl`, `project_dir` = parent dir name). Preserves existing `source`, `permission_mode`, `parent_id`, and a manually renamed `title` (title only set when currently empty). Calls `regenerateRuleTags` once at the end if anything changed. Missing/removed dirs → returns zeros, never throws.

- [ ] **Step 1: Write the failing test**

`server/test/indexer.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/database.js';
import { indexProjects } from '../src/indexer/indexer.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'orbital-idx-'));
  const projects = join(dir, 'projects');
  const pdir = join(projects, '-Users-tomin-Projects-slothworks-ergaily');
  mkdirSync(pdir, { recursive: true });
  const fixture = readFileSync(
    join(import.meta.dirname, 'fixtures/transcript-basic.jsonl'), 'utf8',
  );
  writeFileSync(join(pdir, 'aaaa-bbbb.jsonl'), fixture);
  const db = openDb(join(dir, 'index.db'));
  return { db, projects, transcriptPath: join(pdir, 'aaaa-bbbb.jsonl') };
}

describe('indexProjects', () => {
  it('indexes new transcripts and extracts meta', () => {
    const { db, projects } = setup();
    const result = indexProjects(db, projects);
    expect(result).toEqual({ scanned: 1, indexed: 1 });
    const row = db.prepare(`SELECT * FROM sessions WHERE id='aaaa-bbbb'`).get() as any;
    expect(row.cwd).toBe('/Users/tomin/Projects/slothworks/ergaily');
    expect(row.title).toBe('Fix the login bug in the auth service please');
    expect(row.message_count).toBe(3);
  });
  it('is incremental: unchanged files are skipped, changed files re-indexed', () => {
    const { db, projects, transcriptPath } = setup();
    indexProjects(db, projects);
    expect(indexProjects(db, projects)).toEqual({ scanned: 1, indexed: 0 });
    appendFileSync(
      transcriptPath,
      '\n{"type":"user","uuid":"u9","timestamp":"2026-09-01T12:00:00.000Z","message":{"role":"user","content":"more"}}',
    );
    expect(indexProjects(db, projects)).toEqual({ scanned: 1, indexed: 1 });
    const row = db.prepare(`SELECT message_count FROM sessions WHERE id='aaaa-bbbb'`).get() as any;
    expect(row.message_count).toBe(4);
  });
  it('returns zeros for a missing dir', () => {
    const { db } = setup();
    expect(indexProjects(db, '/nonexistent-dir-xyz')).toEqual({ scanned: 0, indexed: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- indexer` → FAIL, module not found.

- [ ] **Step 3: Implement**

`server/src/indexer/indexer.ts`:

```ts
import type Database from 'better-sqlite3';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parseTranscript, extractMeta } from '../transcript/parser.js';
import { regenerateRuleTags } from '../tags/rules.js';

export function indexProjects(
  db: Database.Database,
  projectsDir: string,
): { scanned: number; indexed: number } {
  let scanned = 0;
  let indexed = 0;
  let dirs: string[] = [];
  try {
    dirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(projectsDir, d.name));
  } catch {
    return { scanned: 0, indexed: 0 };
  }
  const getExisting = db.prepare(
    `SELECT indexed_mtime, indexed_size, title FROM sessions WHERE id=?`,
  );
  const upsert = db.prepare(`
    INSERT INTO sessions (id, project_dir, cwd, title, first_at, last_at,
      message_count, file_size, indexed_mtime, indexed_size)
    VALUES (@id, @project_dir, @cwd, @title, @first_at, @last_at,
      @message_count, @file_size, @indexed_mtime, @indexed_size)
    ON CONFLICT(id) DO UPDATE SET
      cwd=excluded.cwd,
      title=CASE WHEN sessions.title='' THEN excluded.title ELSE sessions.title END,
      first_at=excluded.first_at, last_at=excluded.last_at,
      message_count=excluded.message_count, file_size=excluded.file_size,
      indexed_mtime=excluded.indexed_mtime, indexed_size=excluded.indexed_size
  `);
  for (const dir of dirs) {
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const file of files) {
      scanned++;
      const path = join(dir, file);
      try {
        const stat = statSync(path);
        const id = file.replace(/\.jsonl$/, '');
        const existing = getExisting.get(id) as
          | { indexed_mtime: number; indexed_size: number }
          | undefined;
        if (
          existing &&
          existing.indexed_mtime === Math.floor(stat.mtimeMs) &&
          existing.indexed_size === stat.size
        ) continue;
        const meta = extractMeta(parseTranscript(readFileSync(path, 'utf8')));
        upsert.run({
          id,
          project_dir: basename(dir),
          cwd: meta.cwd,
          title: meta.title,
          first_at: meta.firstAt,
          last_at: meta.lastAt,
          message_count: meta.messageCount,
          file_size: stat.size,
          indexed_mtime: Math.floor(stat.mtimeMs),
          indexed_size: stat.size,
        });
        indexed++;
      } catch (err) {
        console.warn(`orbital: failed to index ${path}:`, err);
      }
    }
  }
  if (indexed > 0) regenerateRuleTags(db);
  return { scanned, indexed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- indexer` → PASS. Then run the whole suite: `npm test -w server` → all green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): incremental transcript indexer"
```

---

### Task 6: Live session registry watcher

**Files:**
- Create: `server/src/watcher/registry.ts`
- Test: `server/test/registry.test.ts`

**Interfaces:**
- Consumes: nothing internal (reads `~/.claude/sessions/*.json` format).
- Produces: `class SessionRegistry extends EventEmitter`:
  - `constructor(sessionsDir: string, opts?: { isPidAlive?: (pid: number) => boolean })` — inject liveness for tests; default impl: `process.kill(pid, 0)` in try/catch.
  - `scan(): void` — reads all `<pid>.json` files, keeps entries whose PID is alive; diffs against previous state; emits `'upsert', LiveSession` and `'remove', sessionId`.
  - `watch(): void` / `close(): void` — chokidar on the dir, `scan()` on any change (debounced 200 ms).
  - `get(sessionId: string): LiveSession | undefined`, `all(): LiveSession[]`
  - `LiveSession`: `{ sessionId: string; pid: number; cwd: string; name: string; status: 'working' | 'idle'; kind: string; startedAt: number; updatedAt: number }` (registry file's `status` mapped: `working` → `working`, anything else → `idle`).

- [ ] **Step 1: Write the failing test**

`server/test/registry.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionRegistry } from '../src/watcher/registry.js';

function writeEntry(dir: string, pid: number, sessionId: string, status: string) {
  writeFileSync(
    join(dir, `${pid}.json`),
    JSON.stringify({
      pid, sessionId, cwd: '/p', name: `s-${pid}`, status,
      kind: 'interactive', startedAt: 1, updatedAt: 2,
    }),
  );
}

describe('SessionRegistry.scan', () => {
  it('emits upsert for live sessions and remove for vanished ones; drops dead pids', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbital-reg-'));
    writeEntry(dir, 100, 'sess-a', 'working');
    writeEntry(dir, 200, 'sess-b', 'idle');
    writeEntry(dir, 300, 'sess-dead', 'idle');
    const alive = new Set([100, 200]);
    const reg = new SessionRegistry(dir, { isPidAlive: (pid) => alive.has(pid) });
    const events: string[] = [];
    reg.on('upsert', (s) => events.push(`up:${s.sessionId}:${s.status}`));
    reg.on('remove', (id) => events.push(`rm:${id}`));
    reg.scan();
    expect(events.sort()).toEqual(['up:sess-a:working', 'up:sess-b:idle']);
    expect(reg.all()).toHaveLength(2);

    events.length = 0;
    rmSync(join(dir, '100.json'));
    writeEntry(dir, 200, 'sess-b', 'working');
    reg.scan();
    expect(events.sort()).toEqual(['rm:sess-a', 'up:sess-b:working']);
  });
  it('survives corrupt registry files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbital-reg2-'));
    writeFileSync(join(dir, '1.json'), 'not json');
    const reg = new SessionRegistry(dir, { isPidAlive: () => true });
    expect(() => reg.scan()).not.toThrow();
    expect(reg.all()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- registry` → FAIL, module not found.

- [ ] **Step 3: Implement**

`server/src/watcher/registry.ts`:

```ts
import { EventEmitter } from 'node:events';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';

export interface LiveSession {
  sessionId: string;
  pid: number;
  cwd: string;
  name: string;
  status: 'working' | 'idle';
  kind: string;
  startedAt: number;
  updatedAt: number;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class SessionRegistry extends EventEmitter {
  private sessions = new Map<string, LiveSession>();
  private watcher: FSWatcher | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private isPidAlive: (pid: number) => boolean;

  constructor(
    private sessionsDir: string,
    opts: { isPidAlive?: (pid: number) => boolean } = {},
  ) {
    super();
    this.isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
  }

  scan(): void {
    const next = new Map<string, LiveSession>();
    let files: string[] = [];
    try {
      files = readdirSync(this.sessionsDir).filter((f) => /^\d+\.json$/.test(f));
    } catch {
      files = [];
    }
    for (const file of files) {
      try {
        const raw = JSON.parse(readFileSync(join(this.sessionsDir, file), 'utf8'));
        if (typeof raw.pid !== 'number' || typeof raw.sessionId !== 'string') continue;
        if (!this.isPidAlive(raw.pid)) continue;
        next.set(raw.sessionId, {
          sessionId: raw.sessionId,
          pid: raw.pid,
          cwd: String(raw.cwd ?? ''),
          name: String(raw.name ?? ''),
          status: raw.status === 'working' ? 'working' : 'idle',
          kind: String(raw.kind ?? ''),
          startedAt: Number(raw.startedAt ?? 0),
          updatedAt: Number(raw.updatedAt ?? 0),
        });
      } catch (err) {
        console.warn(`orbital: bad registry file ${file}:`, err);
      }
    }
    for (const [id, session] of next) {
      const prev = this.sessions.get(id);
      if (!prev || JSON.stringify(prev) !== JSON.stringify(session)) {
        this.emit('upsert', session);
      }
    }
    for (const id of this.sessions.keys()) {
      if (!next.has(id)) this.emit('remove', id);
    }
    this.sessions = next;
  }

  watch(): void {
    this.watcher = chokidar.watch(this.sessionsDir, { ignoreInitial: true });
    this.watcher.on('all', () => {
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => this.scan(), 200);
    });
  }

  async close(): Promise<void> {
    if (this.debounce) clearTimeout(this.debounce);
    await this.watcher?.close();
  }

  get(sessionId: string): LiveSession | undefined {
    return this.sessions.get(sessionId);
  }

  all(): LiveSession[] {
    return [...this.sessions.values()];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- registry` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): live session registry watcher with pid liveness"
```

---

### Task 7: Transcript tailer

**Files:**
- Create: `server/src/watcher/tail.ts`
- Test: `server/test/tail.test.ts`

**Interfaces:**
- Consumes: `parseTranscriptLine` (Task 2).
- Produces: `class TranscriptTail extends EventEmitter`:
  - `constructor(filePath: string)`
  - `start(fromByte = 0): void` — reads from `fromByte` to EOF, emits `'entries', TranscriptEntry[]` for complete lines (a trailing partial line is kept in a buffer for the next read); then watches the file (`fs.watch` + 150 ms debounce) and emits again on growth.
  - `stop(): void`
  - `offset: number` — current byte offset (start of the buffered partial line, so a restart never skips data).

- [ ] **Step 1: Write the failing test**

`server/test/tail.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptTail } from '../src/watcher/tail.js';

const LINE1 = '{"type":"user","uuid":"u1","message":{"role":"user","content":"hi"}}\n';
const LINE2 = '{"type":"assistant","uuid":"a1","message":{"role":"assistant","content":"yo"}}\n';

function collect(tail: TranscriptTail) {
  const seen: string[] = [];
  tail.on('entries', (entries) => {
    for (const e of entries) seen.push(e.uuid);
  });
  return seen;
}

describe('TranscriptTail', () => {
  it('emits existing entries on start and new entries on append', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbital-tail-'));
    const file = join(dir, 't.jsonl');
    writeFileSync(file, LINE1);
    const tail = new TranscriptTail(file);
    const seen = collect(tail);
    tail.start();
    expect(seen).toEqual(['u1']);
    appendFileSync(file, LINE2);
    await new Promise((r) => setTimeout(r, 400));
    expect(seen).toEqual(['u1', 'a1']);
    tail.stop();
  });
  it('holds back a partial trailing line until completed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbital-tail2-'));
    const file = join(dir, 't.jsonl');
    writeFileSync(file, LINE1 + '{"type":"user","uu'); // partial second line
    const tail = new TranscriptTail(file);
    const seen = collect(tail);
    tail.start();
    expect(seen).toEqual(['u1']);
    expect(tail.offset).toBe(Buffer.byteLength(LINE1));
    tail.stop();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- tail` → FAIL, module not found.

- [ ] **Step 3: Implement**

`server/src/watcher/tail.ts`:

```ts
import { EventEmitter } from 'node:events';
import { openSync, readSync, closeSync, statSync, watch, type FSWatcher } from 'node:fs';
import { parseTranscriptLine, type TranscriptEntry } from '../transcript/parser.js';

export class TranscriptTail extends EventEmitter {
  offset = 0;
  private watcher: FSWatcher | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;

  constructor(private filePath: string) {
    super();
  }

  private readNew(): void {
    let size: number;
    try {
      size = statSync(this.filePath).size;
    } catch {
      return;
    }
    if (size <= this.offset) return;
    const length = size - this.offset;
    const buf = Buffer.alloc(length);
    let fd: number;
    try {
      fd = openSync(this.filePath, 'r');
    } catch {
      return;
    }
    try {
      readSync(fd, buf, 0, length, this.offset);
    } finally {
      closeSync(fd);
    }
    const text = buf.toString('utf8');
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline === -1) return; // only a partial line so far
    const complete = text.slice(0, lastNewline + 1);
    this.offset += Buffer.byteLength(complete);
    const entries: TranscriptEntry[] = [];
    for (const line of complete.split('\n')) {
      const e = parseTranscriptLine(line);
      if (e) entries.push(e);
    }
    if (entries.length) this.emit('entries', entries);
  }

  start(fromByte = 0): void {
    this.offset = fromByte;
    this.readNew();
    try {
      this.watcher = watch(this.filePath, () => {
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.readNew(), 150);
      });
    } catch (err) {
      console.warn(`orbital: cannot watch ${this.filePath}:`, err);
    }
  }

  stop(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.watcher?.close();
    this.watcher = null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- tail` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): byte-offset transcript tailer"
```

---

### Task 8: WebSocket hub

**Files:**
- Create: `server/src/api/hub.ts`
- Test: `server/test/hub.test.ts`

**Interfaces:**
- Produces: `class Hub`:
  - `handleSocket(socket: { send(data: string): void; on(ev: string, cb: (...a: any[]) => void): void }): void` — wires `message` (parse `{type:'subscribe'|'unsubscribe', topic}`) and `close` (drop all subscriptions). Malformed messages are ignored.
  - `publish(topic: string, payload: Record<string, unknown>): void` — sends `JSON.stringify({ topic, ...payload })` to every subscriber of `topic`.
  - `subscriberCount(topic: string): number`
  - `onFirstSubscriber(cb: (topic: string) => void)` / `onLastUnsubscriber(cb: (topic: string) => void)` — used by index.ts to start/stop transcript tails on demand.

- [ ] **Step 1: Write the failing test**

`server/test/hub.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Hub } from '../src/api/hub.js';

function fakeSocket() {
  const em = new EventEmitter() as any;
  em.send = vi.fn();
  return em;
}

describe('Hub', () => {
  it('routes published payloads to topic subscribers only', () => {
    const hub = new Hub();
    const a = fakeSocket();
    const b = fakeSocket();
    hub.handleSocket(a);
    hub.handleSocket(b);
    a.emit('message', JSON.stringify({ type: 'subscribe', topic: 'sessions' }));
    hub.publish('sessions', { event: 'upsert', session: { id: 's1' } });
    expect(a.send).toHaveBeenCalledWith(
      JSON.stringify({ topic: 'sessions', event: 'upsert', session: { id: 's1' } }),
    );
    expect(b.send).not.toHaveBeenCalled();
  });
  it('fires first/last subscriber callbacks and cleans up on close', () => {
    const hub = new Hub();
    const first = vi.fn();
    const last = vi.fn();
    hub.onFirstSubscriber(first);
    hub.onLastUnsubscriber(last);
    const a = fakeSocket();
    hub.handleSocket(a);
    a.emit('message', JSON.stringify({ type: 'subscribe', topic: 'session:x' }));
    expect(first).toHaveBeenCalledWith('session:x');
    a.emit('close');
    expect(last).toHaveBeenCalledWith('session:x');
    expect(hub.subscriberCount('session:x')).toBe(0);
  });
  it('ignores malformed messages', () => {
    const hub = new Hub();
    const a = fakeSocket();
    hub.handleSocket(a);
    expect(() => a.emit('message', 'not json')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- hub` → FAIL, module not found.

- [ ] **Step 3: Implement**

`server/src/api/hub.ts`:

```ts
type Socket = {
  send(data: string): void;
  on(ev: string, cb: (...args: any[]) => void): void;
};

export class Hub {
  private topics = new Map<string, Set<Socket>>();
  private firstCb: ((topic: string) => void) | null = null;
  private lastCb: ((topic: string) => void) | null = null;

  onFirstSubscriber(cb: (topic: string) => void): void {
    this.firstCb = cb;
  }

  onLastUnsubscriber(cb: (topic: string) => void): void {
    this.lastCb = cb;
  }

  private subscribe(socket: Socket, topic: string): void {
    let set = this.topics.get(topic);
    if (!set) {
      set = new Set();
      this.topics.set(topic, set);
    }
    const wasEmpty = set.size === 0;
    set.add(socket);
    if (wasEmpty) this.firstCb?.(topic);
  }

  private unsubscribe(socket: Socket, topic: string): void {
    const set = this.topics.get(topic);
    if (!set?.delete(socket)) return;
    if (set.size === 0) {
      this.topics.delete(topic);
      this.lastCb?.(topic);
    }
  }

  handleSocket(socket: Socket): void {
    const mine = new Set<string>();
    socket.on('message', (raw: unknown) => {
      try {
        const msg = JSON.parse(String(raw));
        if (typeof msg.topic !== 'string') return;
        if (msg.type === 'subscribe') {
          mine.add(msg.topic);
          this.subscribe(socket, msg.topic);
        } else if (msg.type === 'unsubscribe') {
          mine.delete(msg.topic);
          this.unsubscribe(socket, msg.topic);
        }
      } catch {
        /* ignore malformed */
      }
    });
    socket.on('close', () => {
      for (const topic of mine) this.unsubscribe(socket, topic);
    });
  }

  publish(topic: string, payload: Record<string, unknown>): void {
    const set = this.topics.get(topic);
    if (!set) return;
    const data = JSON.stringify({ topic, ...payload });
    for (const socket of set) {
      try {
        socket.send(data);
      } catch {
        /* dead socket; close handler will clean up */
      }
    }
  }

  subscriberCount(topic: string): number {
    return this.topics.get(topic)?.size ?? 0;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- hub` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): topic-multiplexed websocket hub"
```

---

### Task 9: Runner (Agent SDK session manager)

**Files:**
- Create: `server/src/runner/runner.ts`
- Test: `server/test/runner.test.ts`

**Interfaces:**
- Consumes: `Hub.publish` (Task 8); `PermissionMode`, `SessionStatus` types (Task 1).
- Produces: `class Runner`:
  - `constructor(deps: { hub: Hub; queryFn?: QueryFn; idleTimeoutMs?: number; onStatus?: (sessionId: string, status: SessionStatus) => void })` — `queryFn` defaults to the SDK's `query`; injected fake in tests. `idleTimeoutMs` default 30 min.
  - `async start(opts: { cwd: string; prompt: string; permissionMode: PermissionMode; resume?: string; model?: string }): Promise<string>` — builds the SDK options (`systemPrompt: {type:'preset',preset:'claude_code'}`, `settingSources: ['user','project','local']`, `cwd`, `permissionMode`, `resume`), starts the query with an async-generator input stream backed by a per-session queue, pumps SDK messages. Resolves with the session id from the SDK `system/init` message.
  - `send(sessionId: string, text: string): void` — enqueue next user message (status → `working`).
  - `async interrupt(sessionId: string): Promise<void>`
  - `async end(sessionId: string): Promise<void>` — close input stream, dispose (status → `ended`).
  - `status(sessionId: string): SessionStatus | undefined`, `active(): string[]`
  - Message pump behavior: `assistant`/`user` SDK messages → `hub.publish('session:<id>', {event:'message', message})` (converted with `entriesToMessages`-compatible shape via a small `sdkToChatMessages` helper exported for tests); `result` message → publish `{event:'turn_result', usage}` and status → `needs_input`; when a turn starts → status `working`. Status changes also publish `{event:'status', status}` and call `onStatus`.
  - `QueryFn` type: `(args: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => AsyncGenerator<any> & { interrupt?: () => Promise<void> }`

- [ ] **Step 1: Write the failing test**

`server/test/runner.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { Hub } from '../src/api/hub.js';
import { Runner } from '../src/runner/runner.js';

/** Fake SDK: echoes each user message, then emits a result. */
function fakeQueryFn() {
  const interrupt = vi.fn(async () => {});
  const fn = ({ prompt }: { prompt: AsyncIterable<any>; options: any }) => {
    async function* gen() {
      yield { type: 'system', subtype: 'init', session_id: 'web-1' };
      for await (const userMsg of prompt) {
        const text = userMsg.message.content[0].text;
        yield {
          type: 'assistant', session_id: 'web-1',
          message: { role: 'assistant', content: [{ type: 'text', text: `echo:${text}` }] },
        };
        yield { type: 'result', subtype: 'success', session_id: 'web-1', usage: { output_tokens: 5 } };
      }
    }
    const g = gen() as any;
    g.interrupt = interrupt;
    return g;
  };
  return { fn, interrupt };
}

function subscribed(hub: Hub, topic: string) {
  const received: any[] = [];
  const socket: any = {
    send: (d: string) => received.push(JSON.parse(d)),
    handlers: {} as Record<string, Function>,
    on(ev: string, cb: Function) { this.handlers[ev] = cb; },
  };
  hub.handleSocket(socket);
  socket.handlers['message'](JSON.stringify({ type: 'subscribe', topic }));
  return received;
}

describe('Runner', () => {
  it('starts a session, streams messages, and lands in needs_input after the turn', async () => {
    const hub = new Hub();
    const { fn } = fakeQueryFn();
    const runner = new Runner({ hub, queryFn: fn as any });
    const received = subscribed(hub, 'session:web-1');
    const id = await runner.start({ cwd: '/p', prompt: 'hello', permissionMode: 'acceptEdits' });
    expect(id).toBe('web-1');
    await vi.waitFor(() => expect(runner.status('web-1')).toBe('needs_input'));
    const events = received.map((r) => r.event);
    expect(events).toContain('message');
    expect(events).toContain('turn_result');
    const msg = received.find((r) => r.event === 'message');
    expect(msg.message.text).toBe('echo:hello');
  });

  it('send() runs another turn; end() closes the session', async () => {
    const hub = new Hub();
    const { fn } = fakeQueryFn();
    const runner = new Runner({ hub, queryFn: fn as any });
    const received = subscribed(hub, 'session:web-1');
    await runner.start({ cwd: '/p', prompt: 'one', permissionMode: 'plan' });
    await vi.waitFor(() => expect(runner.status('web-1')).toBe('needs_input'));
    runner.send('web-1', 'two');
    expect(runner.status('web-1')).toBe('working');
    await vi.waitFor(() =>
      expect(received.filter((r) => r.event === 'turn_result')).toHaveLength(2),
    );
    await runner.end('web-1');
    expect(runner.status('web-1')).toBe('ended');
    expect(runner.active()).toEqual([]);
  });

  it('interrupt() calls the SDK interrupt', async () => {
    const hub = new Hub();
    const { fn, interrupt } = fakeQueryFn();
    const runner = new Runner({ hub, queryFn: fn as any });
    await runner.start({ cwd: '/p', prompt: 'x', permissionMode: 'plan' });
    await runner.interrupt('web-1');
    expect(interrupt).toHaveBeenCalled();
  });

  it('passes the claude_code preset and setting sources to the SDK', async () => {
    const hub = new Hub();
    let captured: any;
    const fn = (args: any) => {
      captured = args.options;
      return fakeQueryFn().fn(args);
    };
    const runner = new Runner({ hub, queryFn: fn as any });
    await runner.start({ cwd: '/p', prompt: 'x', permissionMode: 'acceptEdits', resume: 'old-1' });
    expect(captured).toMatchObject({
      cwd: '/p',
      permissionMode: 'acceptEdits',
      resume: 'old-1',
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- runner` → FAIL, module not found.

- [ ] **Step 3: Implement**

`server/src/runner/runner.ts`:

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Hub } from '../api/hub.js';
import type { PermissionMode, SessionStatus, ChatMessage } from '../types.js';

export type QueryFn = (args: {
  prompt: AsyncIterable<unknown>;
  options: Record<string, unknown>;
}) => AsyncGenerator<any> & { interrupt?: () => Promise<void> };

interface ManagedSession {
  status: SessionStatus;
  queue: Array<(msg: unknown | null) => void>;
  pending: unknown[];
  generator: (AsyncGenerator<any> & { interrupt?: () => Promise<void> }) | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export function sdkToChatMessages(sdkMsg: any): ChatMessage[] {
  const content = sdkMsg.message?.content;
  if (!Array.isArray(content)) return [];
  const out: ChatMessage[] = [];
  content.forEach((block: any, i: number) => {
    const id = `${sdkMsg.session_id}:${Date.now()}:${i}`;
    if (block.type === 'text' && block.text?.trim()) {
      out.push({ id, role: sdkMsg.type === 'user' ? 'user' : 'assistant', text: block.text });
    } else if (block.type === 'tool_use') {
      out.push({ id, role: 'tool_use', toolName: block.name, toolInput: block.input, toolUseId: block.id });
    } else if (block.type === 'tool_result') {
      out.push({
        id, role: 'tool_result', toolUseId: block.tool_use_id,
        text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
      });
    }
  });
  return out;
}

export class Runner {
  private sessions = new Map<string, ManagedSession>();
  private hub: Hub;
  private queryFn: QueryFn;
  private idleTimeoutMs: number;
  private onStatus?: (sessionId: string, status: SessionStatus) => void;

  constructor(deps: {
    hub: Hub;
    queryFn?: QueryFn;
    idleTimeoutMs?: number;
    onStatus?: (sessionId: string, status: SessionStatus) => void;
  }) {
    this.hub = deps.hub;
    this.queryFn = deps.queryFn ?? (query as unknown as QueryFn);
    this.idleTimeoutMs = deps.idleTimeoutMs ?? 30 * 60_000;
    this.onStatus = deps.onStatus;
  }

  private setStatus(sessionId: string, status: SessionStatus): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.status === status) return;
    s.status = status;
    this.hub.publish(`session:${sessionId}`, { event: 'status', status });
    this.onStatus?.(sessionId, status);
  }

  private userMessage(sessionId: string, text: string): unknown {
    return {
      type: 'user',
      session_id: sessionId,
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text }] },
    };
  }

  private armIdleTimer(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => void this.end(sessionId), this.idleTimeoutMs);
  }

  async start(opts: {
    cwd: string;
    prompt: string;
    permissionMode: PermissionMode;
    resume?: string;
    model?: string;
  }): Promise<string> {
    const state: ManagedSession = {
      status: 'working', queue: [], pending: [], generator: null, idleTimer: null,
    };
    // Input stream: yields queued user messages; null closes it.
    const dequeue = () =>
      new Promise<unknown | null>((resolve) => {
        if (state.pending.length) resolve(state.pending.shift()!);
        else state.queue.push(resolve);
      });
    async function* input() {
      while (true) {
        const msg = await dequeue();
        if (msg === null) return;
        yield msg;
      }
    }
    const options: Record<string, unknown> = {
      cwd: opts.cwd,
      permissionMode: opts.permissionMode,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
    };
    if (opts.resume) options.resume = opts.resume;
    if (opts.model) options.model = opts.model;

    const generator = this.queryFn({ prompt: input(), options });
    state.generator = generator;

    const sessionId = await new Promise<string>((resolve, reject) => {
      let resolved = false;
      const pump = async () => {
        try {
          for await (const msg of generator) {
            const id: string = msg.session_id;
            if (!resolved && id) {
              resolved = true;
              this.sessions.set(id, state);
              resolve(id);
              // First user message goes in only after the session is registered.
              this.enqueue(id, this.userMessage(id, opts.prompt));
            }
            if (msg.type === 'assistant' || msg.type === 'user') {
              for (const chat of sdkToChatMessages(msg)) {
                this.hub.publish(`session:${id}`, { event: 'message', message: chat });
              }
            } else if (msg.type === 'result') {
              this.hub.publish(`session:${id}`, { event: 'turn_result', usage: msg.usage ?? {} });
              this.setStatus(id, 'needs_input');
              this.armIdleTimer(id);
            }
          }
        } catch (err) {
          console.warn('orbital: runner pump error:', err);
        }
        // Generator finished (SDK process exited).
        if (resolved) {
          const id = [...this.sessions.entries()].find(([, s]) => s === state)?.[0];
          if (id) this.setStatus(id, 'ended');
        } else {
          reject(new Error('SDK query ended before init'));
        }
      };
      void pump();
    });
    return sessionId;
  }

  private enqueue(sessionId: string, msg: unknown | null): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const waiter = s.queue.shift();
    if (waiter) waiter(msg);
    else if (msg !== null) s.pending.push(msg);
  }

  send(sessionId: string, text: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.status === 'ended') throw new Error(`session ${sessionId} is not active`);
    if (s.idleTimer) clearTimeout(s.idleTimer);
    this.setStatus(sessionId, 'working');
    this.enqueue(sessionId, this.userMessage(sessionId, text));
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.sessions.get(sessionId)?.generator?.interrupt?.();
    this.setStatus(sessionId, 'needs_input');
  }

  async end(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    this.enqueue(sessionId, null); // close the input stream
    this.setStatus(sessionId, 'ended');
    this.sessions.delete(sessionId);
  }

  status(sessionId: string): SessionStatus | undefined {
    return this.sessions.get(sessionId)?.status;
  }

  active(): string[] {
    return [...this.sessions.keys()];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- runner` → PASS. (The `end()` test also verifies the map cleanup, so `status()` returns `'ended'` — adjust: `end()` sets status before deleting; the test asserts `'ended'` right after the call. Keep a small `endedIds: Set<string>` if needed: after `this.sessions.delete`, `status()` should return `'ended'` for known-ended ids. Implement exactly that: add `private ended = new Set<string>()`, add the id in `end()`, and in `status()` return `'ended'` when the id is in the set.)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): agent sdk runner with streaming input, interrupt, idle end"
```

---

### Task 10: REST routes

**Files:**
- Create: `server/src/api/routes.ts`
- Test: `server/test/routes.test.ts`

**Interfaces:**
- Consumes: `openDb`, `effectiveTagIds`, `regenerateRuleTags`, `matchRule`, `Runner`, `SessionRegistry`, `parseTranscript`, `entriesToMessages`.
- Produces: `registerRoutes(app: FastifyInstance, ctx: RouteContext): void` where `RouteContext = { db, registry, runner, projectsDir, settings: { get(key): string; set(key, value): void } }`. Implements every endpoint from the spec's API table. Session list rows are shaped `{ id, cwd, title, firstAt, lastAt, messageCount, source, permissionMode, parentId, tagIds: number[], status: SessionStatus }` — status merged: runner status for web sessions, registry status for terminal sessions, else `'ended'`.

- [ ] **Step 1: Write the failing test**

`server/test/routes.test.ts` (Fastify's `app.inject`, no real network):

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db/database.js';
import { registerRoutes } from '../src/api/routes.js';

function makeApp() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'orbital-api-')), 'index.db'));
  db.prepare(`INSERT INTO tags (id, name, hue) VALUES (10, 'work', 210)`).run();
  db.prepare(
    `INSERT INTO sessions (id, project_dir, cwd, title, last_at, source)
     VALUES ('s1','p','/w/x','auth fix', 200, 'terminal'),
            ('s2','p','/w/y','recipe', 100, 'terminal')`,
  ).run();
  db.prepare(`INSERT INTO session_tags VALUES ('s1', 10, 'manual')`).run();
  const registry = {
    get: (id: string) => (id === 's1' ? { sessionId: 's1', status: 'working' } : undefined),
    all: () => [{ sessionId: 's1', status: 'working' }],
  };
  const runner = {
    status: () => undefined, active: () => [],
    start: async () => 'web-9', send: () => {}, interrupt: async () => {}, end: async () => {},
  };
  const app = Fastify();
  registerRoutes(app, {
    db, registry: registry as any, runner: runner as any, projectsDir: '/nonexistent',
    settings: {
      get: (k: string) => (db.prepare(`SELECT value FROM settings WHERE key=?`).get(k) as any)?.value ?? '',
      set: (k: string, v: string) =>
        db.prepare(`INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(k, v),
    },
  });
  return { app, db };
}

describe('REST routes', () => {
  let app: FastifyInstance;
  beforeEach(() => { ({ app } = makeApp()); });

  it('GET /api/sessions lists by recency with merged status and tags', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sessions.map((s: any) => s.id)).toEqual(['s1', 's2']);
    expect(body.sessions[0]).toMatchObject({ status: 'working', tagIds: [10] });
    expect(body.sessions[1].status).toBe('ended');
  });

  it('GET /api/sessions?tag=10&q=auth filters', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions?tag=10&q=auth' });
    expect(res.json().sessions.map((s: any) => s.id)).toEqual(['s1']);
  });

  it('PATCH /api/sessions/:id renames', async () => {
    const res = await app.inject({
      method: 'PATCH', url: '/api/sessions/s1', payload: { title: 'renamed' },
    });
    expect(res.statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: '/api/sessions?q=renamed' });
    expect(list.json().sessions).toHaveLength(1);
  });

  it('PUT /api/sessions/:id/tags records manual add and removal', async () => {
    await app.inject({ method: 'PUT', url: '/api/sessions/s2/tags', payload: { tagIds: [10] } });
    const list = await app.inject({ method: 'GET', url: '/api/sessions?tag=10' });
    expect(list.json().sessions.map((s: any) => s.id).sort()).toEqual(['s1', 's2']);
  });

  it('tags + rules CRUD and preview', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/tags', payload: { name: 'oncall', hue: 60 },
    });
    expect(created.statusCode).toBe(201);
    const tagId = created.json().id;
    const rule = await app.inject({
      method: 'POST', url: '/api/tag-rules',
      payload: { tagId, condition: 'path_matches', pattern: '/oncall/**' },
    });
    expect(rule.statusCode).toBe(201);
    const preview = await app.inject({
      method: 'POST', url: '/api/tag-rules/preview',
      payload: { cwd: '/oncall/runbooks', title: '', permissionMode: null },
    });
    expect(preview.json()).toMatchObject({ tagId });
  });

  it('POST /api/sessions starts a web session via the runner', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sessions',
      payload: { cwd: '/p', prompt: 'go', permissionMode: 'acceptEdits' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ sessionId: 'web-9' });
  });

  it('GET and PATCH /api/settings', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.json().default_permission_mode).toBe('acceptEdits');
    await app.inject({
      method: 'PATCH', url: '/api/settings', payload: { lineage_depth: '5' },
    });
    const after = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(after.json().lineage_depth).toBe('5');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- routes` → FAIL, module not found.

- [ ] **Step 3: Implement**

`server/src/api/routes.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseTranscript, entriesToMessages } from '../transcript/parser.js';
import { effectiveTagIds, regenerateRuleTags, matchRule } from '../tags/rules.js';
import type { Runner } from '../runner/runner.js';
import type { SessionRegistry } from '../watcher/registry.js';
import type { SessionRow, SessionStatus, TagRule } from '../types.js';

export interface RouteContext {
  db: Database.Database;
  registry: SessionRegistry;
  runner: Runner;
  projectsDir: string;
  settings: { get(key: string): string; set(key: string, value: string): void };
}

function statusOf(ctx: RouteContext, row: SessionRow): SessionStatus {
  const fromRunner = ctx.runner.status(row.id);
  if (fromRunner) return fromRunner;
  const live = ctx.registry.get(row.id);
  if (live) return live.status;
  return 'ended';
}

function toApi(ctx: RouteContext, row: SessionRow) {
  return {
    id: row.id, cwd: row.cwd, title: row.title,
    firstAt: row.first_at, lastAt: row.last_at,
    messageCount: row.message_count, source: row.source,
    permissionMode: row.permission_mode, parentId: row.parent_id,
    tagIds: effectiveTagIds(ctx.db, row.id),
    status: statusOf(ctx, row),
  };
}

export function registerRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { db } = ctx;

  app.get('/api/sessions', (req) => {
    const q = req.query as Record<string, string>;
    const limit = Math.min(Number(q.limit ?? 50), 200);
    const offset = Number(q.offset ?? 0);
    let rows = db
      .prepare(`SELECT * FROM sessions ORDER BY last_at DESC LIMIT ? OFFSET ?`)
      .all(limit * 4 + offset, 0) as SessionRow[]; // over-fetch, filter, then page
    if (q.source) rows = rows.filter((r) => r.source === q.source);
    if (q.q) rows = rows.filter((r) => r.title.toLowerCase().includes(q.q.toLowerCase()));
    let sessions = rows.map((r) => toApi(ctx, r));
    if (q.tag) sessions = sessions.filter((s) => s.tagIds.includes(Number(q.tag)));
    return { sessions: sessions.slice(offset, offset + limit) };
  });

  app.get('/api/sessions/:id', (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare(`SELECT * FROM sessions WHERE id=?`).get(id) as SessionRow | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    const lineage: string[] = [];
    let cursor: string | null = row.parent_id;
    while (cursor) {
      lineage.push(cursor);
      const parent = db.prepare(`SELECT parent_id FROM sessions WHERE id=?`).get(cursor) as
        | { parent_id: string | null } | undefined;
      cursor = parent?.parent_id ?? null;
    }
    return { session: toApi(ctx, row), lineage };
  });

  app.get('/api/sessions/:id/messages', (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, string>;
    const row = db.prepare(`SELECT project_dir FROM sessions WHERE id=?`).get(id) as
      | { project_dir: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    let messages;
    try {
      const text = readFileSync(join(ctx.projectsDir, row.project_dir, `${id}.jsonl`), 'utf8');
      messages = entriesToMessages(parseTranscript(text));
    } catch {
      return reply.code(404).send({ error: 'transcript missing' });
    }
    const limit = Math.min(Number(q.limit ?? 100), 500);
    const before = q.before ? messages.findIndex((m) => m.id === q.before) : messages.length;
    const end = before === -1 ? messages.length : before;
    return { messages: messages.slice(Math.max(0, end - limit), end) };
  });

  app.post('/api/sessions', async (req, reply) => {
    const body = req.body as {
      cwd: string; prompt: string; permissionMode: 'plan' | 'acceptEdits' | 'bypassPermissions';
      tagId?: number; model?: string; resume?: string; parentId?: string;
    };
    const sessionId = await ctx.runner.start(body);
    db.prepare(
      `INSERT OR IGNORE INTO sessions (id, project_dir, cwd, source, permission_mode, parent_id, last_at)
       VALUES (?, '', ?, 'web', ?, ?, ?)`,
    ).run(sessionId, body.cwd, body.permissionMode, body.parentId ?? null, Date.now());
    if (body.tagId != null) {
      db.prepare(`INSERT OR IGNORE INTO session_tags VALUES (?, ?, 'manual')`).run(sessionId, body.tagId);
    }
    return reply.code(201).send({ sessionId });
  });

  app.post('/api/sessions/:id/messages', (req, reply) => {
    const { id } = req.params as { id: string };
    const { text } = req.body as { text: string };
    try {
      ctx.runner.send(id, text);
    } catch {
      return reply.code(409).send({ error: 'session not active; use POST /api/sessions with resume' });
    }
    return { ok: true };
  });

  app.post('/api/sessions/:id/interrupt', async (req) => {
    await ctx.runner.interrupt((req.params as { id: string }).id);
    return { ok: true };
  });

  app.post('/api/sessions/:id/clear', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { startNew } = (req.body ?? {}) as { startNew?: boolean };
    const row = db.prepare(`SELECT * FROM sessions WHERE id=?`).get(id) as SessionRow | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    await ctx.runner.end(id);
    if (!startNew) return { ok: true };
    const inheritMode = ctx.settings.get('inherit_permission_mode') === 'true';
    const newId = await ctx.runner.start({
      cwd: row.cwd, prompt: '',
      permissionMode: (inheritMode && row.permission_mode
        ? row.permission_mode
        : ctx.settings.get('default_permission_mode')) as any,
    });
    db.prepare(
      `INSERT OR IGNORE INTO sessions (id, project_dir, cwd, source, permission_mode, parent_id, last_at)
       VALUES (?, '', ?, 'web', ?, ?, ?)`,
    ).run(newId, row.cwd, row.permission_mode, id, Date.now());
    if (ctx.settings.get('inherit_tags') === 'true') {
      db.prepare(
        `INSERT OR IGNORE INTO session_tags (session_id, tag_id, origin)
         SELECT ?, tag_id, 'manual' FROM session_tags WHERE session_id=? AND origin='manual'`,
      ).run(newId, id);
    }
    return { ok: true, sessionId: newId };
  });

  app.patch('/api/sessions/:id', (req, reply) => {
    const { id } = req.params as { id: string };
    const { title } = req.body as { title: string };
    const result = db.prepare(`UPDATE sessions SET title=? WHERE id=?`).run(title, id);
    if (result.changes === 0) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  app.put('/api/sessions/:id/tags', (req) => {
    const { id } = req.params as { id: string };
    const { tagIds } = req.body as { tagIds: number[] };
    const current = new Set(
      (db.prepare(`SELECT tag_id FROM session_tags WHERE session_id=? AND origin='rule'`)
        .all(id) as Array<{ tag_id: number }>).map((r) => r.tag_id),
    );
    db.transaction(() => {
      db.prepare(`DELETE FROM session_tags WHERE session_id=? AND origin IN ('manual','manual_removed')`).run(id);
      for (const tagId of tagIds) {
        if (!current.has(tagId)) {
          db.prepare(`INSERT OR IGNORE INTO session_tags VALUES (?, ?, 'manual')`).run(id, tagId);
        }
      }
      for (const ruleTag of current) {
        if (!tagIds.includes(ruleTag)) {
          db.prepare(`INSERT OR IGNORE INTO session_tags VALUES (?, ?, 'manual_removed')`).run(id, ruleTag);
        }
      }
    })();
    return { ok: true };
  });

  app.get('/api/tags', () => ({
    tags: db.prepare(`SELECT * FROM tags ORDER BY id`).all(),
  }));
  app.post('/api/tags', (req, reply) => {
    const { name, hue } = req.body as { name: string; hue: number };
    const r = db.prepare(`INSERT INTO tags (name, hue) VALUES (?, ?)`).run(name, hue);
    return reply.code(201).send({ id: Number(r.lastInsertRowid) });
  });
  app.patch('/api/tags/:id', (req) => {
    const { id } = req.params as { id: string };
    const { name, hue } = req.body as { name?: string; hue?: number };
    if (name != null) db.prepare(`UPDATE tags SET name=? WHERE id=?`).run(name, id);
    if (hue != null) db.prepare(`UPDATE tags SET hue=? WHERE id=?`).run(hue, id);
    return { ok: true };
  });
  app.delete('/api/tags/:id', (req) => {
    db.prepare(`DELETE FROM tags WHERE id=? AND is_default=0`).run((req.params as any).id);
    regenerateRuleTags(db);
    return { ok: true };
  });

  app.get('/api/tag-rules', () => ({
    rules: db.prepare(`SELECT * FROM tag_rules ORDER BY position`).all(),
  }));
  app.post('/api/tag-rules', (req, reply) => {
    const { tagId, condition, pattern } = req.body as {
      tagId: number; condition: TagRule['condition']; pattern: string;
    };
    const max = (db.prepare(`SELECT COALESCE(MAX(position),-1) m FROM tag_rules`).get() as any).m;
    const r = db.prepare(
      `INSERT INTO tag_rules (tag_id, position, enabled, condition, pattern) VALUES (?, ?, 1, ?, ?)`,
    ).run(tagId, max + 1, condition, pattern);
    regenerateRuleTags(db);
    return reply.code(201).send({ id: Number(r.lastInsertRowid) });
  });
  app.patch('/api/tag-rules/:id', (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as Partial<Pick<TagRule, 'position' | 'enabled' | 'condition' | 'pattern' | 'tag_id'>>;
    for (const key of ['position', 'enabled', 'condition', 'pattern', 'tag_id'] as const) {
      if (body[key] != null) db.prepare(`UPDATE tag_rules SET ${key}=? WHERE id=?`).run(body[key], id);
    }
    regenerateRuleTags(db);
    return { ok: true };
  });
  app.delete('/api/tag-rules/:id', (req) => {
    db.prepare(`DELETE FROM tag_rules WHERE id=?`).run((req.params as any).id);
    regenerateRuleTags(db);
    return { ok: true };
  });
  app.post('/api/tag-rules/preview', (req) => {
    const body = req.body as { cwd: string; title: string; permissionMode: string | null };
    const rules = db.prepare(`SELECT * FROM tag_rules ORDER BY position`).all() as TagRule[];
    const rule = matchRule(rules, body);
    return rule ? { tagId: rule.tag_id, ruleId: rule.id } : { tagId: null, ruleId: null };
  });

  app.get('/api/projects', () => {
    const rows = db
      .prepare(`SELECT DISTINCT cwd FROM sessions WHERE cwd != '' ORDER BY MAX(last_at) DESC LIMIT 50`)
      .all() as Array<{ cwd: string }>;
    return { projects: rows.map((r) => r.cwd) };
  });

  app.get('/api/settings', () => {
    const rows = db.prepare(`SELECT key, value FROM settings`).all() as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  });
  app.patch('/api/settings', (req) => {
    for (const [k, v] of Object.entries(req.body as Record<string, string>)) {
      ctx.settings.set(k, String(v));
    }
    return { ok: true };
  });
}
```

Note: the `GET /api/projects` SQL above uses `MAX(last_at)` without GROUP BY — write it as:
`SELECT cwd FROM sessions WHERE cwd != '' GROUP BY cwd ORDER BY MAX(last_at) DESC LIMIT 50`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server -- routes` → PASS. Full suite: `npm test -w server` → all green. `npm run typecheck -w server` → clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(server): rest api for sessions, tags, rules, settings"
```

---

### Task 11: Boot wiring + integration smoke test

**Files:**
- Create: `server/src/index.ts`
- Test: extend `server/test/routes.test.ts` with one smoke test via `buildServer`

**Interfaces:**
- Consumes: everything above.
- Produces: `buildServer(overrides?: { dbPath?: string; claudeDir?: string; queryFn?: QueryFn }): Promise<FastifyInstance>` — exported for tests; `index.ts` calls it and `listen({ host: '127.0.0.1', port: CONFIG.port })` when run directly.

- [ ] **Step 1: Write the failing test**

Append to `server/test/routes.test.ts`:

```ts
import { buildServer } from '../src/index.js';

describe('buildServer smoke', () => {
  it('boots, serves /api/sessions and /ws upgrade route exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbital-boot-'));
    const app = await buildServer({
      dbPath: join(dir, 'index.db'),
      claudeDir: dir, // empty: no projects/, no sessions/ — must still boot
    });
    const res = await app.inject({ method: 'GET', url: '/api/sessions' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessions: [] });
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w server -- routes` → FAIL — `buildServer` not exported.

- [ ] **Step 3: Implement boot**

`server/src/index.ts`:

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.js';
import { openDb } from './db/database.js';
import { indexProjects } from './indexer/indexer.js';
import { SessionRegistry } from './watcher/registry.js';
import { TranscriptTail } from './watcher/tail.js';
import { Hub } from './api/hub.js';
import { Runner, type QueryFn } from './runner/runner.js';
import { registerRoutes } from './api/routes.js';
import { entriesToMessages } from './transcript/parser.js';
import { trackSubagents } from './transcript/subagents.js';
import chokidar from 'chokidar';

export async function buildServer(overrides: {
  dbPath?: string; claudeDir?: string; queryFn?: QueryFn;
} = {}): Promise<FastifyInstance> {
  const claudeDir = overrides.claudeDir ?? CONFIG.claudeDir;
  const projectsDir = join(claudeDir, 'projects');
  const sessionsDir = join(claudeDir, 'sessions');
  const db = openDb(overrides.dbPath ?? CONFIG.dbPath);
  const hub = new Hub();
  const registry = new SessionRegistry(sessionsDir);
  const idleMinutes = Number(
    (db.prepare(`SELECT value FROM settings WHERE key='ended_after_idle_minutes'`).get() as any)
      ?.value ?? 30,
  );
  const runner = new Runner({
    hub,
    queryFn: overrides.queryFn,
    idleTimeoutMs: idleMinutes * 60_000,
  });

  // Initial index + re-index on transcript changes (debounced).
  indexProjects(db, projectsDir);
  const projectsWatcher = chokidar.watch(projectsDir, { ignoreInitial: true, depth: 2 });
  let indexTimer: ReturnType<typeof setTimeout> | null = null;
  projectsWatcher.on('all', () => {
    if (indexTimer) clearTimeout(indexTimer);
    indexTimer = setTimeout(() => indexProjects(db, projectsDir), 500);
  });

  // Live registry → 'sessions' topic.
  registry.on('upsert', (s) =>
    hub.publish('sessions', { event: 'upsert', session: { ...s, source: 'terminal' } }),
  );
  registry.on('remove', (id) => hub.publish('sessions', { event: 'remove', sessionId: id }));
  registry.scan();
  registry.watch();

  // On-demand transcript tails per subscribed session topic.
  const tails = new Map<string, TranscriptTail>();
  hub.onFirstSubscriber((topic) => {
    if (!topic.startsWith('session:')) return;
    const id = topic.slice('session:'.length);
    if (runner.active().includes(id)) return; // web sessions publish directly
    const row = db.prepare(`SELECT project_dir FROM sessions WHERE id=?`).get(id) as
      | { project_dir: string } | undefined;
    if (!row) return;
    const tail = new TranscriptTail(join(projectsDir, row.project_dir, `${id}.jsonl`));
    const seenAgents = new Map<string, string>();
    tail.on('entries', (entries) => {
      for (const msg of entriesToMessages(entries)) {
        hub.publish(topic, { event: 'message', message: msg });
      }
      for (const agent of trackSubagents(entries)) {
        if (seenAgents.get(agent.id) !== agent.state) {
          seenAgents.set(agent.id, agent.state);
          hub.publish(topic, { event: 'subagent', subagent: agent });
        }
      }
    });
    tail.start();
    tails.set(topic, tail);
  });
  hub.onLastUnsubscriber((topic) => {
    tails.get(topic)?.stop();
    tails.delete(topic);
  });

  const app = Fastify();
  await app.register(websocket);
  app.get('/ws', { websocket: true }, (socket) => hub.handleSocket(socket));
  registerRoutes(app, {
    db, registry, runner, projectsDir,
    settings: {
      get: (k) =>
        (db.prepare(`SELECT value FROM settings WHERE key=?`).get(k) as any)?.value ?? '',
      set: (k, v) =>
        db.prepare(
          `INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
        ).run(k, v),
    },
  });
  app.addHook('onClose', async () => {
    await registry.close();
    await projectsWatcher.close();
    for (const tail of tails.values()) tail.stop();
    db.close();
  });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await buildServer();
  await app.listen({ host: '127.0.0.1', port: CONFIG.port });
  console.log(`orbital server on http://127.0.0.1:${CONFIG.port}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w server` → all green. `npm run typecheck -w server` → clean.

- [ ] **Step 5: Manual smoke against real data**

Run: `npm run dev -w server` then in another shell:
`curl -s http://127.0.0.1:4737/api/sessions | head -c 500`
Expected: JSON with your real session history (titles from `~/.claude/projects`). Ctrl-C the server.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(server): boot wiring, ws tails on demand, integration smoke"
```

---

## Deferred to the web plan

- Everything under the spec's UI section (React app, R3F map, panels).
- `POST /api/sessions/:id/messages` reviving an ended session via `resume` (needs a
  UI decision on optimistic rendering; the endpoint currently returns 409 with a
  hint — the web plan adds the auto-revive call path: on 409 the client calls
  `POST /api/sessions` with `{resume: id, parentId: undefined, cwd, permissionMode, prompt}`).

## Self-review notes

- Spec coverage: data sources ✓ (registry Task 6, transcripts Tasks 2/5/7, subagents Task 3), DB ✓ (Task 1), rules ✓ (Task 4), REST table ✓ (Task 10; clear ✓, preview ✓, settings ✓), WS protocol ✓ (Tasks 8/11), runner config/lifecycle/interrupt/clear ✓ (Task 9/10), status model ✓ (Tasks 6/9/10), fail-soft parsing ✓ (Tasks 2/5/6/7).
- Known simplification: web-session rows created by `POST /api/sessions` get
  `project_dir=''`; the indexer fills real metadata as soon as the SDK writes the
  transcript (upsert by id). `needs_input` for terminal sessions is out of scope
  per spec.
