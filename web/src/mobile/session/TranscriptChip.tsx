import { useMemo, type ReactNode } from 'react'
import { ELAPSED_TICK_MS } from '../../lib/subagentPanel'
import type { BackgroundTask, Subagent } from '../../lib/types'
import { useNow } from '../../lib/useNow'
import type { PhoneToolRow, ToolRowChipTarget } from '../../panels/ToolRow'
import { useMobile } from '../state'
import { INK, opensSubagent, opensTask, subagentStatus, taskStatus } from '../subagents/model'

/**
 * The phone's tool-row seam for one session's transcript (`PhoneToolRowContext`):
 * the chip under the row that started a subagent or a background task.
 */
export function usePhoneToolRow(sessionId: string, tagHue: string, offline: boolean): PhoneToolRow {
  return useMemo(
    () => ({
      renderChip: (target: ToolRowChipTarget) => (
        <TranscriptChip sessionId={sessionId} target={target} tagHue={tagHue} offline={offline} />
      ),
    }),
    [sessionId, tagHue, offline],
  )
}

/**
 * Canvas 10g, CHIP IN THE TRANSCRIPT (spec 2026-10-05-mobile-next § 3): the
 * 44 px chip under the tool row that started a task or a subagent — glyph ·
 * name · live state · age · ›. It reads the session's snapshot, so it
 * updates in place (running → exited code) and scrolling back still tells the
 * truth. A press opens the same screen the moons sheet does.
 */
function TranscriptChip({
  sessionId, target, tagHue, offline,
}: {
  sessionId: string
  target: ToolRowChipTarget
  tagHue: string
  offline: boolean
}) {
  const openSubagent = useMobile((s) => s.openSubagent)
  const openTask = useMobile((s) => s.openTask)
  const running = target.kind === 'subagent' ? target.subagent.state !== 'ended' : target.task.state === 'running'
  const live = running && !offline
  const now = useNow(live, ELAPSED_TICK_MS)

  if (target.kind === 'subagent') {
    const agent: Subagent = target.subagent
    const status = subagentStatus(agent, now)
    return (
      <Chip
        label={`Open subagent ${agent.name}`}
        onOpen={opensSubagent(agent) ? () => openSubagent({ sessionId, toolUseId: agent.toolUseId! }) : undefined}
      >
        <span
          aria-hidden
          className={['box-border block h-2 w-2 shrink-0 rounded-full border bg-[oklch(30%_.05_220)]', live ? 'orbital-pulse' : ''].join(' ')}
          style={{ borderColor: tagHue }}
        />
        <span className="min-w-0 truncate text-[#e8eef8]">{agent.name}</span>
        <span aria-hidden className="flex-1" />
        <span className="shrink-0 text-[rgba(160,190,225,.6)]">
          <span style={status.ink ? { color: status.ink } : undefined}>{status.word}</span>
          {status.time && ` · ${status.time}`}
        </span>
      </Chip>
    )
  }

  const task: BackgroundTask = target.task
  const status = taskStatus(task, now)
  return (
    <Chip
      label={`Open the output of ${task.label}`}
      onOpen={opensTask(task) ? () => openTask({ sessionId, taskId: task.id }) : undefined}
    >
      <span aria-hidden className="shrink-0 text-[rgba(200,220,245,.85)]">▣</span>
      <span className="min-w-0 truncate text-[#e8eef8]">{task.label}</span>
      {running ? (
        <span className="flex shrink-0 items-center gap-[5px]" style={{ color: offline ? INK.runningAsleep : INK.running }}>
          <span aria-hidden className={['block h-1.5 w-1.5 rounded-full bg-current', live ? 'orbital-pulse' : ''].join(' ')} />
          {status.word}
        </span>
      ) : (
        <span className="shrink-0 truncate" style={{ color: status.ink ?? INK.neutral }}>
          {status.word}
        </span>
      )}
      <span aria-hidden className="flex-1" />
      {status.time && <span className="shrink-0 text-[rgba(160,190,225,.6)]">{status.time}</span>}
    </Chip>
  )
}

/** canvas 10g: the chip's shell, inset under its row; › only when it opens something. */
function Chip({ label, onOpen, children }: { label: string; onOpen?: () => void; children: ReactNode }) {
  const className =
    'mx-2 mb-2 box-border flex h-11 w-[calc(100%-16px)] items-center gap-[9px] rounded-[8px] border border-[rgba(150,205,255,.18)] bg-[rgba(3,6,12,.6)] px-2.5 text-left font-mono text-[11.5px]'
  const chevron = (
    <span aria-hidden className="w-2 shrink-0 text-[15px] text-[rgba(160,190,225,.6)]">
      {onOpen ? '›' : ''}
    </span>
  )
  if (!onOpen) {
    return (
      <div data-transcript-chip className={className}>
        {children}
        {chevron}
      </div>
    )
  }
  return (
    <button type="button" data-transcript-chip aria-label={label} onClick={onOpen} className={className}>
      {children}
      {chevron}
    </button>
  )
}
