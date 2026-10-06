import type { ReactNode } from 'react'
import { ELAPSED_TICK_MS } from '../../lib/subagentPanel'
import type { ApiSession, BackgroundTask, Subagent } from '../../lib/types'
import { useNow } from '../../lib/useNow'
import { useMobile } from '../state'
import { BottomSheet } from '../ui'
import {
  opensSubagent,
  opensTask,
  orderSubagents,
  orderTasks,
  subagentStatus,
  subagentsHeading,
  taskStatus,
  tasksHeading,
  type RowStatus,
} from './model'

/**
 * SUBAGENTS & BACKGROUND TASKS (canvas 10f, first phone; spec
 * 2026-10-05-mobile-next § 3): what the 9b moons chip opens. Subagents, then
 * tasks, each running before ended; a row opens its screen over the
 * session, a row with nothing to open has no › and does nothing.
 */
/**
 * The session whose sheet a subagent or task was opened from. The sheet is not
 * on the navigation stack, so back from that screen lands on the session; its
 * chip reads this once on mount and opens the sheet again, so back returns
 * where the tap came from.
 */
let returnToSheet: string | null = null

function markReturnToSheet(sessionId: string): void {
  returnToSheet = sessionId
}

/** True once, for the session a sheet item was opened from. */
export function takeReturnToSheet(sessionId: string): boolean {
  const hit = returnToSheet === sessionId
  returnToSheet = null
  return hit
}

export function MoonsSheet({
  session,
  tagHue,
  offline,
  onClose,
}: {
  session: ApiSession
  /** The session's tag colour, which its moons wear. */
  tagHue: string
  offline: boolean
  onClose: () => void
}) {
  const openSubagent = useMobile((s) => s.openSubagent)
  const openTask = useMobile((s) => s.openTask)
  const subagents = orderSubagents(session.subagents)
  const tasks = orderTasks(session.backgroundTasks ?? [])
  const running = subagents.some((a) => a.state !== 'ended') || tasks.some((t) => t.state === 'running')
  const now = useNow(running && !offline, ELAPSED_TICK_MS)

  const open = (go: () => void) => {
    onClose()
    markReturnToSheet(session.id)
    go()
  }

  // canvas 10f: the sheet's rows run edge to edge, so they step out of the
  // shell's own inset; a long list scrolls inside the sheet.
  return (
    <BottomSheet label="Subagents and background tasks" onDismiss={onClose}>
      <div className="-mx-2.5 max-h-[70vh] overflow-y-auto pb-[30px]">
        {subagents.length > 0 && (
          <>
            <Heading>{subagentsHeading(subagents)}</Heading>
            {subagents.map((agent, i) => (
              <SubagentRow
                key={agent.id}
                agent={agent}
                first={i === 0}
                tagHue={tagHue}
                pulse={!offline && agent.state !== 'ended'}
                status={subagentStatus(agent, now)}
                onOpen={
                  opensSubagent(agent)
                    ? () => open(() => openSubagent({ sessionId: session.id, toolUseId: agent.toolUseId! }))
                    : undefined
                }
              />
            ))}
          </>
        )}
        {tasks.length > 0 && (
          <>
            <Heading divided={subagents.length > 0}>{tasksHeading(tasks)}</Heading>
            {tasks.map((task, i) => (
              <TaskRow
                key={task.id}
                task={task}
                first={i === 0}
                status={taskStatus(task, now)}
                onOpen={opensTask(task) ? () => open(() => openTask({ sessionId: session.id, taskId: task.id })) : undefined}
              />
            ))}
          </>
        )}
      </div>
    </BottomSheet>
  )
}

/** canvas 10f: the group label; the second one opens with a rule. */
function Heading({ children, divided = false }: { children: string; divided?: boolean }) {
  return (
    <div
      className={[
        'px-5 font-mono text-[10px] tracking-[0.18em] text-[rgba(160,190,225,.6)]',
        divided ? 'border-t border-[rgba(150,205,255,.1)] pb-1.5 pt-3.5' : 'pb-1.5 pt-1',
      ].join(' ')}
    >
      {children}
    </div>
  )
}

/** canvas 10f: one row, 56 px, ending in › when it opens something. */
function Row({
  first,
  dim = false,
  onOpen,
  label,
  children,
}: {
  first: boolean
  dim?: boolean
  onOpen?: () => void
  label: string
  children: ReactNode
}) {
  const className = [
    'flex h-14 w-full items-center gap-3 pl-5 pr-3 text-left',
    first ? '' : 'border-t border-[rgba(150,205,255,.06)]',
    dim ? 'opacity-80' : '',
  ].join(' ')
  const chevron = <span aria-hidden className="w-8 text-center text-[18px] text-[rgba(160,190,225,.6)]">{onOpen ? '›' : ''}</span>
  if (!onOpen) {
    return (
      <div className={className}>
        {children}
        {chevron}
      </div>
    )
  }
  return (
    <button type="button" aria-label={label} onClick={onOpen} className={className}>
      {children}
      {chevron}
    </button>
  )
}

function StatusLine({ prefix, status }: { prefix?: string; status: RowStatus }) {
  return (
    <span className="font-mono text-[10.5px] text-[rgba(160,190,225,.6)]">
      {prefix && `${prefix} · `}
      <span style={status.ink ? { color: status.ink } : undefined}>{status.word}</span>
      {status.time && ` · ${status.time}`}
    </span>
  )
}

function SubagentRow({
  agent, first, tagHue, pulse, status, onOpen,
}: {
  agent: Subagent
  first: boolean
  tagHue: string
  pulse: boolean
  status: RowStatus
  onOpen?: () => void
}) {
  return (
    <Row first={first} onOpen={onOpen} label={`Open subagent ${agent.name}`}>
      <span
        aria-hidden
        className={['box-border block h-[9px] w-[9px] shrink-0 rounded-full border bg-[oklch(30%_.05_220)]', pulse ? 'orbital-pulse' : ''].join(' ')}
        style={{ borderColor: tagHue }}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[14.5px] font-semibold text-text-bright">{agent.name}</span>
        <StatusLine status={status} />
      </span>
    </Row>
  )
}

function TaskRow({
  task, first, status, onOpen,
}: {
  task: BackgroundTask
  first: boolean
  status: RowStatus & { kind: string }
  onOpen?: () => void
}) {
  const ended = task.state !== 'running'
  return (
    <Row first={first} dim={ended} onOpen={onOpen} label={`Open the output of ${task.label}`}>
      <span
        aria-hidden
        className={[
          'w-[9px] shrink-0 text-center font-mono text-[12px]',
          ended ? 'text-[rgba(200,220,245,.6)]' : 'text-[rgba(200,220,245,.8)]',
        ].join(' ')}
      >
        ▣
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={['truncate font-mono text-[13px]', ended ? 'text-[rgba(232,238,248,.85)]' : 'text-text-bright'].join(' ')}>
          {task.label}
        </span>
        <StatusLine prefix={status.kind} status={status} />
      </span>
    </Row>
  )
}
