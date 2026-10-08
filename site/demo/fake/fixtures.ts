import type {
  ApiSession,
  ChatMessage,
  OrbitalModel,
  PendingVerdictDecision,
  PermissionMode,
  SessionDefaults,
  SessionStatus,
  Subagent,
  Tag,
} from '../../../web/src/lib/types'

/**
 * The demo world every demo starts from: a handful of generic projects, typed
 * with the app's own types so a change to the API fails the site's typecheck
 * instead of the live demo. No real people, paths or secrets — every name
 * here is made up.
 *
 * Times are relative to `DEMO_EPOCH`, taken once when the page loads, so the
 * "3 minutes ago" a panel prints reads the same on every visit.
 */
export const DEMO_EPOCH = Date.now()
const MINUTE = 60_000

const HOME = '/Users/demo/code'

export const MODELS: OrbitalModel[] = [
  {
    value: 'opus[1m]',
    resolvedModel: 'claude-opus-5[1m]',
    family: 'Opus',
    version: 'Opus 5 with 1M context',
    shortVersion: 'Opus 5',
    variant: '1M',
    blurb: '',
    contextWindow: 1_000_000,
  },
  {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-5',
    family: 'Sonnet',
    version: 'Sonnet 5',
    shortVersion: 'Sonnet 5',
    variant: null,
    blurb: '',
    contextWindow: 200_000,
  },
]

export const TAGS: Tag[] = [
  { id: 1, name: 'backend', hue: 210, is_default: 0 },
  { id: 2, name: 'product', hue: 150, is_default: 0 },
  { id: 3, name: 'ops', hue: 30, is_default: 0 },
]

/** The settings `GET /api/settings` answers. Planets is the only theme a demo shows. */
export const SETTINGS: Record<string, string> = {
  map_theme: 'planets',
  sidebar_collapsed: 'true',
  // Pills rather than the default dots: the visitor has not learned what a
  // dot's colour means yet, and the landing's legend names the pills' words.
  map_state_pills: 'label',
  // The new-session dialog opens on a directory, so Launch works at once
  // rather than waiting on a path the visitor has no reason to know.
  default_project_dir: `${HOME}/billing-api`,
  // The stats button rather than the bar: the demo has no stats to fill the
  // bar with, and an empty strip in the header reads as broken.
  header_session_stats: 'button',
}

interface SessionSpec {
  id: string
  project: string
  tag: number
  title: string
  status: SessionStatus
  source?: ApiSession['source']
  sonnet?: boolean
  startedMinutesAgo: number
  messageCount: number
  contextUsedTokens?: number
}

function session(spec: SessionSpec): ApiSession {
  const web = (spec.source ?? 'web') === 'web'
  return {
    id: spec.id,
    cwd: `${HOME}/${spec.project}`,
    title: spec.title,
    firstAt: DEMO_EPOCH - spec.startedMinutesAgo * MINUTE,
    lastAt: DEMO_EPOCH - MINUTE,
    messageCount: spec.messageCount,
    source: spec.source ?? 'web',
    permissionMode: web ? 'acceptEdits' : null,
    model: spec.sonnet ? 'sonnet' : 'opus[1m]',
    resolvedModel: spec.sonnet ? 'claude-sonnet-5' : 'claude-opus-5[1m]',
    // A terminal session never has a measured context (`ApiSession.contextUsedTokens`).
    contextUsedTokens: web ? (spec.contextUsedTokens ?? null) : null,
    pinnedAt: null,
    endedAt: null,
    interruptedAt: null,
    tagIds: [spec.tag],
    status: spec.status,
    awaitingSubagents: false,
    subagents: [],
    pendingDecision: null,
    git: { ref: 'main', detached: false, worktree: false, defaultBranch: true },
  }
}

export function subagent(sessionId: string, index: number, name: string, state: Subagent['state']): Subagent {
  return {
    id: `${sessionId}-agent-${index}`,
    name,
    state,
    toolUseId: `${sessionId}-agent-${index}-call`,
    startedAt: DEMO_EPOCH - (6 - index) * MINUTE,
  }
}

/** The permission billing-api asks for once it has finished reading. */
export const BILLING_DECISION: PendingVerdictDecision = {
  id: 'billing-decision-1',
  kind: 'permission',
  toolName: 'Edit',
  input: {
    file_path: `${HOME}/billing-api/src/webhooks/sender.ts`,
    old_string: '    await post(endpoint.url, payload)\n',
    new_string: '    await withRetry(() => post(endpoint.url, payload), { attempts: 5, backoff: "exponential" })\n',
  },
  createdAt: DEMO_EPOCH,
}

/** The four sessions the map scenario moves, in the order of the legend. */
export const BILLING = session({
  id: 'billing',
  project: 'billing-api',
  tag: 1,
  title: 'Add retry to the webhook sender',
  status: 'working',
  startedMinutesAgo: 14,
  messageCount: 18,
  contextUsedTokens: 182_000,
})
export const DOCS = session({
  id: 'docs',
  project: 'docs-site',
  tag: 2,
  title: 'Rewrite the onboarding guide',
  status: 'needs_input',
  startedMinutesAgo: 41,
  messageCount: 34,
  contextUsedTokens: 96_000,
  sonnet: true,
})
export const MOBILE = session({
  id: 'mobile',
  project: 'mobile-app',
  tag: 2,
  title: 'Fix push token refresh',
  status: 'working',
  startedMinutesAgo: 22,
  messageCount: 26,
  contextUsedTokens: 240_000,
})
export const INFRA = session({
  id: 'infra',
  project: 'infra',
  tag: 3,
  title: 'Bump Node to 24',
  status: 'working',
  source: 'terminal',
  startedMinutesAgo: 9,
  messageCount: 11,
})

/** Quieter planets the hero adds around the four, so the map reads as a day's work. */
export const QUIET: ApiSession[] = [
  session({
    id: 'invoices',
    project: 'billing-api',
    tag: 1,
    title: 'Paginate the invoices endpoint',
    status: 'idle',
    startedMinutesAgo: 180,
    messageCount: 52,
    contextUsedTokens: 120_000,
    sonnet: true,
  }),
  session({
    id: 'settings-dark',
    project: 'mobile-app',
    tag: 2,
    title: 'Dark mode for settings',
    status: 'idle',
    startedMinutesAgo: 240,
    messageCount: 61,
    contextUsedTokens: 310_000,
  }),
  session({
    id: 'certs',
    project: 'infra',
    tag: 3,
    title: 'Rotate staging certificates',
    status: 'idle',
    source: 'terminal',
    startedMinutesAgo: 300,
    messageCount: 23,
  }),
]

let messageSeq = 0
function message(sessionId: string, role: ChatMessage['role'], fields: Partial<ChatMessage>): ChatMessage {
  messageSeq += 1
  return {
    id: `${sessionId}-m${messageSeq}`,
    uuid: `${sessionId}-u${messageSeq}`,
    role,
    timestamp: new Date(DEMO_EPOCH - (40 - messageSeq) * 20_000).toISOString(),
    ...fields,
  }
}

function toolCall(sessionId: string, name: string, input: Record<string, unknown>, result: string): ChatMessage[] {
  const toolUseId = `${sessionId}-call-${messageSeq + 1}`
  return [
    message(sessionId, 'tool_use', { toolName: name, toolInput: input, toolUseId }),
    message(sessionId, 'tool_result', { toolUseId, text: result }),
  ]
}

/** A short, believable transcript per session — what the detail panel opens on. */
export const MESSAGES: Record<string, ChatMessage[]> = {
  billing: [
    message('billing', 'user', {
      text: 'Webhook deliveries fail for good on the first 5xx. Add a retry with backoff to the sender.',
      rewindable: true,
    }),
    message('billing', 'assistant', {
      text: "I'll look at how the sender posts today, then wrap the call in a retry.",
      model: 'claude-opus-5[1m]',
    }),
    ...toolCall('billing', 'Read', { file_path: `${HOME}/billing-api/src/webhooks/sender.ts` }, 'export async function send(endpoint, payload) {\n  …\n    await post(endpoint.url, payload)\n  …\n}'),
    ...toolCall('billing', 'Grep', { pattern: 'withRetry', path: `${HOME}/billing-api/src` }, 'src/lib/retry.ts'),
    message('billing', 'assistant', {
      text: 'There is already a `withRetry` helper in `src/lib/retry.ts`. I will use it in the sender rather than writing a second one.',
      model: 'claude-opus-5[1m]',
    }),
    // The call the permission is asked about: a pending decision is drawn as
    // a card in place of the tool call whose id it carries.
    message('billing', 'tool_use', {
      toolName: BILLING_DECISION.toolName,
      toolInput: BILLING_DECISION.input,
      toolUseId: BILLING_DECISION.id,
    }),
  ],
  docs: [
    message('docs', 'user', {
      text: 'Rewrite the onboarding guide so a new user gets to their first deploy in five steps.',
      rewindable: true,
    }),
    ...toolCall('docs', 'Read', { file_path: `${HOME}/docs-site/content/onboarding.md` }, '# Getting started\n…'),
    ...toolCall('docs', 'Write', { file_path: `${HOME}/docs-site/content/onboarding.md`, content: '# Your first deploy\n…' }, 'File written.'),
    message('docs', 'assistant', {
      text: 'The guide is down to five steps: install, sign in, create a project, connect the repository, deploy. The old troubleshooting section moved to its own page.',
      model: 'claude-sonnet-5',
    }),
  ],
  mobile: [
    message('mobile', 'user', {
      text: 'Push stops arriving after the token refreshes. Find out why and fix it.',
      rewindable: true,
    }),
    message('mobile', 'assistant', {
      text: 'I will send three agents in parallel: one through the client refresh path, one through the server registration, one through the logs from last week.',
      model: 'claude-opus-5[1m]',
    }),
    ...toolCall('mobile', 'Agent', { description: 'Trace the client token refresh', subagent_type: 'Explore' }, 'Running…'),
  ],
  infra: [
    message('infra', 'user', { text: 'Bump Node to 24 across the Dockerfiles and the CI matrix.' }),
    ...toolCall('infra', 'Glob', { pattern: '**/Dockerfile' }, 'api/Dockerfile\nworker/Dockerfile'),
    ...toolCall('infra', 'Bash', { command: 'grep -rn "node-version" .github/workflows' }, '.github/workflows/ci.yml:18:          node-version: 22'),
  ],
}

/** What `GET /api/sessions/defaults` answers: the Mac's own new-session defaults. */
export const SESSION_DEFAULTS: SessionDefaults = {
  permissionMode: 'acceptEdits',
  model: 'opus[1m]',
  rememberModelPerProject: true,
}

export interface DemoProject {
  cwd: string
  lastModel: string | null
  lastAt: number | null
}

/**
 * What `GET /api/projects` answers — the new-session directory list, newest
 * first: the world's own projects and a few the Mac worked in before.
 */
export function projects(sessions: ApiSession[]): DemoProject[] {
  const byCwd = new Map<string, DemoProject>()
  for (const s of sessions) {
    const seen = byCwd.get(s.cwd)
    if (!seen || (s.lastAt ?? 0) > (seen.lastAt ?? 0)) byCwd.set(s.cwd, { cwd: s.cwd, lastModel: s.model, lastAt: s.lastAt })
  }
  const older = [
    { cwd: `${HOME}/design-tokens`, lastModel: 'sonnet', lastAt: DEMO_EPOCH - 2 * 24 * 60 * MINUTE },
    { cwd: `${HOME}/status-page`, lastModel: 'opus[1m]', lastAt: DEMO_EPOCH - 4 * 24 * 60 * MINUTE },
  ]
  return [...byCwd.values(), ...older].sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))
}

/**
 * A session the visitor started from a new-session dialog or screen: at work
 * in the directory they chose, under a generic title — the real one comes
 * with Claude's reply, which the demos do not simulate.
 */
export function launchedSession(fields: {
  id: string
  cwd: string
  permissionMode: PermissionMode
  model: OrbitalModel | null
  tagIds: number[]
}): ApiSession {
  const now = Date.now()
  return {
    ...session({ id: fields.id, project: '', tag: 0, title: 'New session', status: 'working', startedMinutesAgo: 0, messageCount: 0 }),
    cwd: fields.cwd,
    firstAt: now,
    lastAt: now,
    permissionMode: fields.permissionMode,
    model: fields.model?.value ?? null,
    resolvedModel: fields.model?.resolvedModel ?? null,
    tagIds: fields.tagIds,
  }
}
