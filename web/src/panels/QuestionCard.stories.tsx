import type { Meta, StoryObj } from '@storybook/react-vite'
import { DOCS, INFRA } from '../../../site/demo/fake/fixtures'
import type { ApiSession, ChatMessage, PendingQuestionDecision, QuestionSpec } from '../lib/types'
import { useOrbital } from '../store/store'
import { QuestionCard } from './QuestionCard'

const AUDIENCE: QuestionSpec = {
  question: 'Who is the onboarding guide for?',
  header: 'Audience',
  multiSelect: false,
  options: [
    { label: 'New users', description: 'Someone who signed up today and has never deployed.' },
    { label: 'Teams moving over', description: 'People who already deploy somewhere else.' },
    { label: 'Both', description: 'One guide, with a fork after step two.' },
  ],
}

const SECTIONS: QuestionSpec = {
  question: 'Which sections should stay?',
  header: 'Sections',
  multiSelect: true,
  options: [
    { label: 'Troubleshooting', description: 'The common errors on a first deploy.' },
    { label: 'CLI reference', description: 'Every flag of the deploy command.' },
    { label: 'Pricing', description: 'What a first project costs.' },
  ],
}

const TOOL_USE_ID = 'docs-question-1'

function toolUse(questions: QuestionSpec[]): ChatMessage {
  return {
    id: 'docs-q',
    role: 'tool_use',
    toolName: 'AskUserQuestion',
    toolInput: { questions },
    toolUseId: TOOL_USE_ID,
    timestamp: new Date().toISOString(),
  }
}

const RESULT: ChatMessage = {
  id: 'docs-q-result',
  role: 'tool_result',
  toolUseId: TOOL_USE_ID,
  text: '',
  answers: { [AUDIENCE.question]: 'New users', [SECTIONS.question]: 'Troubleshooting, Pricing' },
  timestamp: new Date().toISOString(),
}

/** Seeds the session, and the question it is stopped on when the card is the pending one. */
function seed(session: ApiSession, pending: boolean, questions: QuestionSpec[]): () => () => void {
  return () => {
    const before = useOrbital.getState()
    const decision: PendingQuestionDecision = { id: TOOL_USE_ID, kind: 'question', input: { questions }, createdAt: Date.now() }
    useOrbital.setState({
      sessions: { [session.id]: session },
      pendingDecisions: pending ? { [session.id]: decision } : {},
    })
    return () => useOrbital.setState(before, true)
  }
}

interface QuestionCardStoryProps {
  sessionId: string
  questions: QuestionSpec[]
  answered?: boolean
  readOnly?: boolean
}

/** The card in the detail panel's column, as the transcript draws it. */
function QuestionCardDemo({ sessionId, questions, answered = false, readOnly = false }: QuestionCardStoryProps) {
  return (
    <div className="w-[450px]">
      <QuestionCard sessionId={sessionId} toolUse={toolUse(questions)} toolResult={answered ? RESULT : undefined} readOnly={readOnly} />
    </div>
  )
}

const meta = {
  title: 'Panels/QuestionCard',
  component: QuestionCardDemo,
  args: { sessionId: DOCS.id, questions: [AUDIENCE] },
  beforeEach: seed(DOCS, true, [AUDIENCE]),
} satisfies Meta<typeof QuestionCardDemo>
export default meta

type Story = StoryObj<typeof meta>

/** Waiting on you: rows are buttons, ⏎ ↑↓ 1–4 work, Other… expands inline. */
export const Interactive: Story = {}

/** Two questions answered top-down; the second picks several. */
export const MultipleQuestions: Story = {
  args: { questions: [AUDIENCE, SECTIONS] },
  beforeEach: seed(DOCS, true, [AUDIENCE, SECTIONS]),
}

/** Pending in a terminal Orbital only watches: dimmed rows and "answer in the terminal". */
export const Terminal: Story = {
  args: { sessionId: INFRA.id },
  beforeEach: seed(INFRA, true, [AUDIENCE]),
}

/** Answered: the historical card from the tool result. */
export const Answered: Story = {
  args: { questions: [AUDIENCE, SECTIONS], answered: true },
  beforeEach: seed(DOCS, false, [AUDIENCE, SECTIONS]),
}

/** The session ended with the question open: UNANSWERED, inert. */
export const Unanswered: Story = {
  beforeEach: seed({ ...DOCS, status: 'ended' }, false, [AUDIENCE]),
}

/** In a subagent's panel: readable, never interactive. */
export const ReadOnly: Story = { args: { readOnly: true } }
