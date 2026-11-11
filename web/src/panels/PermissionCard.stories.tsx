import type { Meta, StoryObj } from '@storybook/react-vite'
import { BILLING, BILLING_DECISION, INFRA } from '../../../site/demo/fake/fixtures'
import type { ApiSession, ChatMessage, PendingVerdictDecision } from '../lib/types'
import { useOrbital } from '../store/store'
import { PermissionCard } from './PermissionCard'

const PLAN = [
  '## Retry the webhook sender',
  '',
  '1. Wrap `post` in the existing `withRetry` helper.',
  '2. Back off exponentially, five attempts.',
  '3. Log the final failure with the endpoint id.',
  '4. Add a test for a 503 followed by a 200.',
].join('\n')

const BASH: PendingVerdictDecision = {
  id: 'billing-bash-1',
  kind: 'permission',
  toolName: 'Bash',
  input: { command: 'rm -rf node_modules/.cache && npm ci', description: 'Clear the cache and reinstall' },
  createdAt: Date.now(),
  defaultToNo: true,
}

const PLAN_DECISION: PendingVerdictDecision = {
  id: 'billing-plan-1',
  kind: 'plan',
  toolName: 'ExitPlanMode',
  input: { plan: PLAN },
  createdAt: Date.now(),
}

function toolUse(decision: PendingVerdictDecision): ChatMessage {
  return {
    id: `${decision.id}-use`,
    role: 'tool_use',
    toolName: decision.toolName,
    toolInput: decision.input,
    toolUseId: decision.id,
    timestamp: new Date().toISOString(),
  }
}

function result(decision: PendingVerdictDecision, isError: boolean): ChatMessage {
  return {
    id: `${decision.id}-result`,
    role: 'tool_result',
    toolUseId: decision.id,
    text: isError ? 'The user rejected the plan: keep the old sender and add a dead-letter queue instead.' : 'Approved.',
    isError,
    timestamp: new Date().toISOString(),
  }
}

/** Seeds the session, and the decision it is stopped on when the card is the pending one. */
function seed(session: ApiSession, pending: PendingVerdictDecision | null, settings: Record<string, string> = {}): () => () => void {
  return () => {
    const before = useOrbital.getState()
    useOrbital.setState({
      sessions: { [session.id]: session },
      pendingDecisions: pending ? { [session.id]: pending } : {},
      settings: { ...before.settings, ...settings },
    })
    return () => useOrbital.setState(before, true)
  }
}

interface PermissionCardStoryProps {
  sessionId: string
  decision: PendingVerdictDecision
  settled?: 'approved' | 'denied'
  offline?: boolean
}

/** The card in the detail panel's column, as the transcript draws it. */
function PermissionCardDemo({ sessionId, decision, settled, offline = false }: PermissionCardStoryProps) {
  return (
    <div className="w-[450px]">
      <PermissionCard
        sessionId={sessionId}
        toolUse={toolUse(decision)}
        toolResult={settled ? result(decision, settled === 'denied') : undefined}
        offline={offline}
      />
    </div>
  )
}

const meta = {
  title: 'Panels/PermissionCard',
  component: PermissionCardDemo,
  args: { sessionId: BILLING.id, decision: BILLING_DECISION },
  beforeEach: seed(BILLING, BILLING_DECISION),
} satisfies Meta<typeof PermissionCardDemo>
export default meta

type Story = StoryObj<typeof meta>

/** An edit waiting on you, its diff open, Allow and Deny. */
export const Edit: Story = {}

/** A command the CLI flagged default-to-no: the guard chrome, and Allow held to approve. */
export const Guarded: Story = {
  args: { decision: BASH },
  beforeEach: seed(BILLING, BASH),
}

/** The guard as a two-step confirm, for someone who set it so. */
export const GuardedConfirm: Story = {
  args: { decision: BASH },
  beforeEach: seed(BILLING, BASH, { permission_guard_gesture: 'confirm' }),
}

/** A plan approval: the plan itself, Approve and Keep planning. */
export const Plan: Story = {
  args: { decision: PLAN_DECISION },
  beforeEach: seed(BILLING, PLAN_DECISION),
}

/** A plan approved earlier, read back from its tool result. */
export const PlanApproved: Story = {
  args: { decision: PLAN_DECISION, settled: 'approved' },
  beforeEach: seed(BILLING, null),
}

/** A plan refused, with the reason it came back with. */
export const PlanDenied: Story = {
  args: { decision: PLAN_DECISION, settled: 'denied' },
  beforeEach: seed(BILLING, null),
}

/** Pending in a terminal Orbital only watches: "answer in the terminal". */
export const Terminal: Story = {
  args: { sessionId: INFRA.id },
  beforeEach: seed(INFRA, { ...BILLING_DECISION }),
}

/** The device holding the session cannot be reached: LOCKED, readable and inert. */
export const Offline: Story = { args: { offline: true } }

/** The session ended while it waited: LOCKED with the dashed note. */
export const Ended: Story = {
  beforeEach: seed({ ...BILLING, status: 'ended' }, null),
}
