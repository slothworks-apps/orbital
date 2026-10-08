import type { ApiSession, ChatMessage, OrbitalModel, PendingVerdictDecision } from '../../../web/src/lib/types'
import type { DemoWorld } from '../fake/fakeServer'
import { BILLING, DEMO_EPOCH, DOCS, INFRA, MESSAGES, MOBILE, MODELS, QUIET, SETTINGS, TAGS, subagent } from '../fake/fixtures'

/**
 * The phone demo's world: the same projects as the desktop demos, seen from
 * the phone. billing-api has finished its edit and asks to push the branch —
 * a command, which reads better on a phone's width than a diff does.
 */

const MINUTE = 60_000

export const PUSH_DECISION: PendingVerdictDecision = {
  id: 'billing-push',
  kind: 'permission',
  toolName: 'Bash',
  input: { command: 'git push -u origin webhook-retry', description: 'Push the branch so CI runs it' },
  createdAt: DEMO_EPOCH,
}

function row(id: string, minutesAgo: number, fields: Omit<ChatMessage, 'id' | 'timestamp'>): ChatMessage {
  return { id, uuid: `${id}-u`, timestamp: new Date(DEMO_EPOCH - minutesAgo * MINUTE).toISOString(), ...fields }
}

const OPUS = BILLING.resolvedModel ?? undefined
const SENDER = `${BILLING.cwd}/src/webhooks/sender.ts`

const BILLING_TRANSCRIPT: ChatMessage[] = [
  row('p1', 9, {
    role: 'user',
    text: 'Webhook deliveries fail for good on the first 5xx. Add a retry with backoff to the sender.',
    rewindable: true,
  }),
  row('p2', 9, {
    role: 'assistant',
    model: OPUS,
    text: 'There is already a `withRetry` helper in `src/lib/retry.ts`. I will use it in the sender.',
  }),
  row('p3', 8, { role: 'tool_use', toolName: 'Read', toolUseId: 'p3-call', toolInput: { file_path: SENDER } }),
  row('p4', 8, { role: 'tool_result', toolUseId: 'p3-call', text: 'export async function send(endpoints, payload) {\n  …\n}' }),
  row('p5', 6, {
    role: 'tool_use',
    toolName: 'Edit',
    toolUseId: 'p5-call',
    toolInput: {
      file_path: SENDER,
      old_string: '    await post(endpoint.url, payload)',
      new_string: "    await withRetry(() => post(endpoint.url, payload), { attempts: 5, backoff: 'exponential' })",
    },
  }),
  row('p6', 6, { role: 'tool_result', toolUseId: 'p5-call', text: 'The file has been updated.' }),
  row('p7', 4, {
    role: 'tool_use',
    toolName: 'Bash',
    toolUseId: 'p7-call',
    toolInput: { command: 'npm test -- webhooks', description: 'Run the webhook tests' },
  }),
  row('p8', 3, { role: 'tool_result', toolUseId: 'p7-call', text: ' Test Files  1 passed (1)\n      Tests  14 passed (14)' }),
  row('p9', 2, {
    role: 'assistant',
    model: OPUS,
    text: 'The sender retries a failed delivery up to five times now, and the 14 webhook tests pass. I will push the branch so CI runs them too.',
  }),
  // The call the permission is asked about: the card is drawn in its place.
  row(PUSH_DECISION.id, 1, {
    role: 'tool_use',
    toolName: PUSH_DECISION.toolName,
    toolInput: PUSH_DECISION.input,
    toolUseId: PUSH_DECISION.id,
  }),
]

const asking: ApiSession = {
  ...BILLING,
  status: 'needs_input',
  pendingDecision: PUSH_DECISION,
  messageCount: BILLING_TRANSCRIPT.length,
}

const waiting: ApiSession = {
  ...MOBILE,
  awaitingSubagents: true,
  subagents: [subagent(MOBILE.id, 0, 'trace client refresh', 'working'), subagent(MOBILE.id, 1, 'read server registration', 'working')],
  subagentCount: 2,
}

/** The phone shows one more model than the desktop demos, so its picker reads as a choice. */
const HAIKU: OrbitalModel = {
  value: 'haiku',
  resolvedModel: 'claude-haiku-5',
  family: 'Haiku',
  version: 'Haiku 5',
  shortVersion: 'Haiku 5',
  variant: null,
  blurb: '',
  contextWindow: 200_000,
}

export const PHONE_WORLD: DemoWorld = {
  sessions: [asking, DOCS, waiting, INFRA, ...QUIET],
  tags: TAGS,
  models: [...MODELS, HAIKU],
  settings: SETTINGS,
  messages: { ...MESSAGES, [BILLING.id]: BILLING_TRANSCRIPT },
  approvedOutputs: {
    [PUSH_DECISION.id]: "branch 'webhook-retry' set up to track 'origin/webhook-retry'.\nTo github.com:demo/billing-api.git\n * [new branch]      webhook-retry -> webhook-retry",
  },
}
