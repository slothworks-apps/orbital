import {
  answerSummary,
  commandLine,
  decisionsOf,
  questionIntro,
  questionTitle,
  sourceLabel,
  type McpjsonAnswer,
  type McpjsonAnswers,
  type McpjsonDecisions,
  type McpjsonServer,
} from '../../lib/mcpjson'
import { Button } from '../../ui/Button'
import { BottomSheet, PrimaryButton } from '../ui'

/**
 * The phone's `.mcp.json` question, a sheet over the dimmed New session
 * form (spec 2026-10-08-mcpjson-approval-design § Clients; canvas `Feature -
 * MCP approval` 47c one server, 47d three). Back to the form, a tap on the
 * dimmed form or a swipe down cancel the launch; the form underneath keeps
 * every field.
 *
 * No *View file*: the phone's file screen reads through an open session, and
 * there is none yet. The row still says it runs a file from the project.
 */
export function McpjsonSheet({
  servers,
  answers,
  project,
  macName,
  pending,
  onAnswer,
  onStart,
  onBack,
}: {
  servers: readonly McpjsonServer[]
  answers: McpjsonAnswers
  /** The project's folder name, for the eyebrow. */
  project: string
  /** The programs run on the Mac, not the phone, so the copy names it. */
  macName: string
  pending: boolean
  onAnswer: (name: string, answer: McpjsonAnswer) => void
  onStart: (decisions: McpjsonDecisions) => void
  onBack: () => void
}) {
  const title = questionTitle(servers.length)
  const decisions = decisionsOf(servers, answers)
  return (
    <BottomSheet label={title} onDismiss={onBack} variant="question" swipeToDismiss>
      {/* 47c draws no rule under one server's head; 47d's list scrolls under it. */}
      <div
        className={[
          'shrink-0 border-b px-5 pb-3 pt-0.5',
          servers.length > 1 ? 'border-[rgba(150,205,255,.1)]' : 'border-transparent',
        ].join(' ')}
      >
        <div className="font-mono text-[10px] tracking-[0.18em] text-[oklch(85%_.12_205/.8)]">
          NEW SESSION · {project.toUpperCase()}
        </div>
        <h2 className="mt-1 text-[19px] font-bold leading-[1.25] tracking-[-0.01em] text-pretty">{title}</h2>
      </div>
      <div
        data-sheet-scroll
        className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto overscroll-contain px-5 pb-3.5 pt-3 [scrollbar-width:none]"
      >
        <p className="text-[13.5px] leading-[1.5] text-pretty text-[rgba(200,214,235,.88)]">
          Its .mcp.json{questionIntro(servers.length, macName)}
        </p>
        {servers.map((server) => (
          <ServerCard
            key={server.name}
            server={server}
            answer={answers[server.name]}
            onAnswer={(answer) => onAnswer(server.name, answer)}
          />
        ))}
      </div>
      <div className="flex shrink-0 flex-col gap-0.5 border-t border-[rgba(150,205,255,.1)] px-4 pt-2.5">
        <div className="pb-2 text-center font-mono text-[10.5px] text-[rgba(160,190,225,.55)]">
          {answerSummary(servers, answers)}
        </div>
        <PrimaryButton ready={decisions !== null} disabled={pending} onClick={() => decisions && onStart(decisions)}>
          Start session
        </PrimaryButton>
        <button
          type="button"
          onClick={onBack}
          className="h-11 w-full text-[14px] font-semibold text-[rgba(200,220,245,.8)]"
        >
          Back to the form
        </button>
      </div>
    </BottomSheet>
  )
}

/** 47c/47d: one server as a card — name and source, the command, the two answers. */
function ServerCard({
  server,
  answer,
  onAnswer,
}: {
  server: McpjsonServer
  answer: McpjsonAnswer | undefined
  onAnswer: (answer: McpjsonAnswer) => void
}) {
  const file = server.source === 'file'
  return (
    <div className="flex flex-col gap-2.5 rounded-[14px] border border-[rgba(150,205,255,.12)] bg-[rgba(4,8,16,.45)] p-3.5">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[14px] font-semibold text-text-bright">{server.name}</span>
        {file ? (
          // 2d / 47c: the auto permission mode's amber, a dot and the label only.
          <span className="inline-flex items-center gap-1.5 font-mono text-[9.5px] tracking-[0.12em] text-[oklch(84%_.12_85)]">
            <span aria-hidden className="block h-1.5 w-1.5 rounded-full bg-[oklch(76%_.16_85)]" />
            {sourceLabel('file')}
          </span>
        ) : (
          <span className="font-mono text-[9.5px] tracking-[0.12em] text-[rgba(160,190,225,.5)]">{sourceLabel(server.source)}</span>
        )}
      </div>
      {/* Wrapped, never cut off: 47d's docker command runs over seven lines. */}
      <div
        className={[
          'rounded-[10px] border bg-[rgba(4,8,16,.7)] px-[11px] py-[9px] font-mono text-[12px] leading-[1.6] whitespace-pre-wrap text-[#dfeeff] [overflow-wrap:anywhere]',
          file ? 'border-[oklch(76%_.16_85/.3)]' : 'border-[rgba(150,205,255,.12)]',
        ].join(' ')}
      >
        {commandLine(server)}
      </div>
      {file && (
        <span className="text-[12.5px] leading-[1.45] text-pretty text-[rgba(160,190,225,.7)]">
          Runs a file from this project — the command alone doesn&apos;t say what it does.
        </span>
      )}
      <div role="radiogroup" aria-label={server.name} className="grid grid-cols-2 gap-2">
        <Button
          role="radio"
          aria-checked={answer === 'allow'}
          variant={answer === 'allow' ? 'choice-on' : 'choice'}
          size="choice-touch"
          onClick={() => onAnswer('allow')}
        >
          Allow
        </Button>
        <Button
          role="radio"
          aria-checked={answer === 'deny'}
          variant={answer === 'deny' ? 'choice-on' : 'choice'}
          size="choice-touch"
          onClick={() => onAnswer('deny')}
        >
          Don&apos;t allow
        </Button>
      </div>
    </div>
  )
}
