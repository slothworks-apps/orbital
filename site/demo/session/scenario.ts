import type { ApiSession, ChatMessage, PendingVerdictDecision } from '../../../web/src/lib/types'
import { BILLING, DEMO_EPOCH } from '../fake/fixtures'

/** One director tick. The beats below are counted in these. */
export const TICK_MS = 1000

const FILE = `${BILLING.cwd}/src/webhooks/sender.ts`

/**
 * A transcript row at a fixed place in the session's past: `minutesAgo`
 * before `DEMO_EPOCH`, so the panel's clock reads the same on every visit.
 */
function row(id: string, minutesAgo: number, fields: Omit<ChatMessage, 'id' | 'timestamp'>): ChatMessage {
  return { id, uuid: `${id}-u`, timestamp: new Date(DEMO_EPOCH - minutesAgo * 60_000).toISOString(), ...fields }
}

const OPUS = BILLING.resolvedModel ?? undefined

/** What happened before the scenario starts: an earlier exchange, then the reading the edit is based on. */
const HISTORY: ChatMessage[] = [
  row('h1', 14, {
    role: 'user',
    text: 'Some customers say they never got the invoice.paid webhook last night. Can you check the delivery log?',
    rewindable: true,
  }),
  row('h2', 14, {
    role: 'tool_use',
    toolName: 'Bash',
    toolUseId: 'h2-call',
    toolInput: { command: 'grep -c "status=503" logs/webhooks-2026-10-07.log', description: 'Count failed deliveries' },
  }),
  row('h3', 14, { role: 'tool_result', toolUseId: 'h2-call', text: '37' }),
  row('h4', 13, {
    role: 'assistant',
    model: OPUS,
    text: '37 deliveries got a `503` from the receiving end between 02:10 and 02:25 and were never sent again: the sender gives up after the first failure.',
  }),
  row('h5', 9, {
    role: 'user',
    text: 'Add a retry with backoff to the sender.',
    rewindable: true,
  }),
  row('h6', 9, {
    role: 'assistant',
    model: OPUS,
    text: "I'll look at how the sender posts today, then wrap the call in a retry.",
  }),
  row('h7', 8, { role: 'tool_use', toolName: 'Read', toolUseId: 'h7-call', toolInput: { file_path: FILE } }),
  row('h8', 8, {
    role: 'tool_result',
    toolUseId: 'h7-call',
    text: 'export async function send(endpoints: Endpoint[], payload: Payload) {\n  for (const endpoint of endpoints) {\n    await post(endpoint.url, payload)\n  }\n}',
  }),
  row('h9', 8, {
    role: 'tool_use',
    toolName: 'Grep',
    toolUseId: 'h9-call',
    toolInput: { pattern: 'export function withRetry', path: `${BILLING.cwd}/src` },
  }),
  row('h10', 8, { role: 'tool_result', toolUseId: 'h9-call', text: 'src/lib/retry.ts' }),
  row('h11', 7, {
    role: 'assistant',
    model: OPUS,
    text: 'There is already a `withRetry` helper in `src/lib/retry.ts`. I will use it in the sender rather than write a second one.',
  }),
]

/**
 * The edit the permission card asks about. Each round of the loop asks
 * afresh under its own id: the store remembers how a decision was answered
 * by its id, and a card under an answered id would open already answered.
 */
export function editDecision(round: number): PendingVerdictDecision {
  return {
    id: `billing-edit-${round}`,
    kind: 'permission',
    toolName: 'Edit',
    input: {
      file_path: FILE,
      old_string: '  for (const endpoint of endpoints) {\n    await post(endpoint.url, payload)\n  }',
      new_string:
        "  for (const endpoint of endpoints) {\n    await withRetry(() => post(endpoint.url, payload), {\n      attempts: 5,\n      backoff: 'exponential',\n    })\n  }",
    },
    createdAt: DEMO_EPOCH,
  }
}

/** The rows each beat adds, after the history and the edit's call. */
function tail(beat: number, round: number): ChatMessage[] {
  const decision = editDecision(round)
  const rows: ChatMessage[] = []
  if (beat >= 1) {
    // The id and words `FakeServer.settleDecision` gives an approval, so a
    // visitor's own Approve and the scenario's land as the same row.
    rows.push(row(`${decision.id}-result`, 1, { role: 'tool_result', toolUseId: decision.id, text: 'The file has been updated.' }))
  }
  if (beat >= 2) {
    rows.push(
      // Also what keeps the edit a row of its own: calls in a row fold into one run.
      row(`next-${round}`, 1, { role: 'assistant', model: OPUS, text: 'The edit is in. Running the webhook tests.' }),
      row(`tests-${round}`, 1, {
        role: 'tool_use',
        toolName: 'Bash',
        toolUseId: `tests-${round}-call`,
        toolInput: { command: 'npm test -- webhooks', description: 'Run the webhook tests' },
      }),
      row(`tests-${round}-result`, 0, {
        role: 'tool_result',
        toolUseId: `tests-${round}-call`,
        text: ' ✓ src/webhooks/sender.test.ts (14 tests) 212ms\n\n Test Files  1 passed (1)\n      Tests  14 passed (14)',
      }),
    )
  }
  if (beat >= 3) {
    rows.push(
      row(`summary-${round}`, 0, {
        role: 'assistant',
        model: OPUS,
        text: 'The sender now retries a failed delivery up to five times with exponential backoff, through the existing `withRetry` helper. The webhook tests pass.',
      }),
    )
  }
  return rows
}

interface Beat {
  /** Ticks this beat holds. */
  ticks: number
  status: ApiSession['status']
}

/**
 * The session scenario (spec 2026-10-08-landing-site-design § Scenarios):
 * Claude asks to edit the sender, the edit is approved and lands as a diff,
 * the tests run, and the session is done. Then it starts over.
 *
 * The first beat is the one the page opens on and the poster is taken from:
 * the permission card with the edit's diff, which is what this demo is for.
 * It holds longest, so a visitor has time to answer it themselves.
 */
export const SESSION_BEATS: Beat[] = [
  { ticks: 9, status: 'needs_input' },
  { ticks: 3, status: 'working' },
  { ticks: 4, status: 'working' },
  { ticks: 6, status: 'idle' },
]

export const SESSION_DURATIONS = SESSION_BEATS.map((beat) => beat.ticks)

export interface SessionFrame {
  session: ApiSession
  /** The whole transcript as it stands in this beat. */
  messages: ChatMessage[]
}

/** The session and its transcript in `beat` of loop `round`. Pure: the page diffs one frame against the last. */
export function frameFor(beat: number, round: number): SessionFrame {
  const decision = editDecision(round)
  const asking = beat === 0
  const messages = [
    ...HISTORY,
    // The call the permission is asked about: while the decision is pending,
    // the transcript draws its card in place of this row.
    row(decision.id, 2, { role: 'tool_use', toolName: 'Edit', toolUseId: decision.id, toolInput: decision.input }),
    ...tail(beat, round),
  ]
  return {
    session: {
      ...BILLING,
      status: SESSION_BEATS[beat].status,
      pendingDecision: asking ? decision : null,
      messageCount: messages.length,
    },
    messages,
  }
}

/**
 * What moving from one frame to the next tells the panel: the rows added at
 * the end, or — when the new frame is not the old one grown, as when the loop
 * starts over — that the transcript must be read again.
 */
export function transcriptChange(
  from: readonly ChatMessage[],
  to: readonly ChatMessage[],
): { kind: 'append'; rows: ChatMessage[] } | { kind: 'reset' } {
  const grown = from.length <= to.length && from.every((m, i) => to[i].id === m.id)
  return grown ? { kind: 'append', rows: to.slice(from.length) } : { kind: 'reset' }
}
