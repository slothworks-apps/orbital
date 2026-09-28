import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useOrbital } from '../store/store'
import type { BackgroundTask } from '../lib/types'
import { badgeText, displayLines, taskElapsedMs, taskTone, type TaskTone } from '../lib/backgroundTasks'
import { ELAPSED_TICK_MS } from '../lib/subagentPanel'
import { formatToolDuration } from '../lib/format'
import { STATE_DOT_RING_PX } from '../lib/stateStyle'
import { TASK_TONE } from '../ui/Badge'
import { Panel, WINDOW_STRIP_INSET_PX } from '../ui/Panel'
import { CollapseGlyph, UtilityButton } from '../ui/UtilityButton'
import { Tooltip } from '../ui/Tooltip'
import { PIN_TOOLTIP_DELAY_MS } from './UtilityStrip'
import { useEscapeLayer } from '../ui/escapeLayer'
import { BackToSession, type SubagentPanelProps } from './SubagentPanel'
import { SubagentChip } from './SubagentChip'
import { TaskChip } from './TaskChip'

/** 26b: how close to the bottom still counts as at the bottom, so a sub-pixel scroll does not pause following. */
const FOLLOW_SLACK_PX = 24

/** 26b's inks per tone: the badge and the end line are the only places they appear. */
const TONE_INK: Record<TaskTone, string> = {
  running: TASK_TONE.running.dotColor,
  done: TASK_TONE.completed.dotColor,
  failed: TASK_TONE.failed.dotColor,
  stopped: TASK_TONE.stopped.ink,
  unknown: 'rgba(160,190,225,.6)',
}
const TONE_BORDER: Record<TaskTone, string> = {
  running: TASK_TONE.running.border,
  done: TASK_TONE.completed.border,
  failed: TASK_TONE.failed.border,
  stopped: TASK_TONE.stopped.border,
  unknown: 'rgba(150,205,255,.2)',
}

/** The dashed line Orbital adds under the output once the task ended (26b). */
function endText(task: BackgroundTask, elapsed: string | undefined): string {
  const tone = taskTone(task)
  if (tone === 'stopped') return elapsed ? `stopped after ${elapsed}` : 'stopped'
  if (task.exitCode !== undefined) return `exited with code ${task.exitCode}`
  if (tone === 'unknown') return 'ended — how is not known'
  return tone === 'failed' ? 'failed' : 'ended'
}

const clockOf = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

/**
 * A shell's or monitor's output, read-only, in the side slot (spec
 * 2026-09-28-background-tasks-design §§ 3, 4; canvas 26b, 26c). The
 * subagent panel's frame with a different body: the full command in the
 * header, the output following its tail, and a stop while it runs. Renders
 * nothing while `store.taskOutput` is null.
 */
export function TaskOutputPanel({ widthPx, inWindow: inWindowProp = false, swap = false }: SubagentPanelProps) {
  const inWindow = inWindowProp || swap
  const titleRowRef = useRef<HTMLDivElement | null>(null)
  const view = useOrbital((s) => s.taskOutput)
  const close = useOrbital((s) => s.closeTaskOutput)
  const stopTask = useOrbital((s) => s.stopTask)
  const session = useOrbital((s) => (view ? s.sessions[view.sessionId] : undefined))
  const task = session?.backgroundTasks?.find((t) => t.id === view?.taskId)
  const stopping = useOrbital((s) => (view ? Boolean(s.stoppingTasks[`${view.sessionId}:${view.taskId}`]) : false))
  const running = task?.state === 'running'

  const [nowMs, setNowMs] = useState(Date.now)
  useEffect(() => {
    setNowMs(Date.now())
    if (!running) return
    const timer = setInterval(() => setNowMs(Date.now()), ELAPSED_TICK_MS)
    return () => clearInterval(timer)
  }, [running, view?.taskId])

  useEscapeLayer(view !== null, close)

  // Following the tail (26b): new lines keep the view at the bottom until
  // the reader scrolls up; then the footer counts what arrived, and coming
  // back to the bottom resumes.
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [following, setFollowing] = useState(true)
  const [pausedAt, setPausedAt] = useState(0)
  const lines = view ? displayLines(view.output) : []
  const lineCount = lines.length

  useEffect(() => {
    setFollowing(true)
  }, [view?.sessionId, view?.taskId])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && following) el.scrollTop = el.scrollHeight
  }, [lineCount, following, view?.phase])

  if (!view) return null

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX
    if (atBottom !== following) {
      setFollowing(atBottom)
      if (!atBottom) setPausedAt(lineCount)
    }
  }
  const jumpToLatest = () => setFollowing(true)

  const tone: TaskTone = task ? taskTone(task) : 'unknown'
  const elapsed = task ? formatToolDuration(taskElapsedMs(task, nowMs)) : undefined
  const kind = task?.kind ?? 'shell'
  const newLines = Math.max(0, lineCount - pausedAt)

  return (
    <Panel
      side={swap ? 'right' : 'subagent'}
      widthPx={widthPx}
      fill={inWindow}
      className="relative flex h-full flex-col overflow-hidden"
    >
      {/* 11b's dashed seam, which 26b keeps: the pair is told apart by it. */}
      {!swap && (
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 h-px"
          style={{ background: 'repeating-linear-gradient(90deg, rgba(150,205,255,.4) 0 4px, transparent 4px 10px)' }}
        />
      )}

      <div
        className={[
          'orbital-band-controls border-b border-[rgba(150,205,255,.1)] px-[18px] pb-[14px] pt-4',
          swap ? 'bg-[image:linear-gradient(180deg,rgba(10,15,27,.6),rgba(5,8,16,.3))]' : '',
        ].join(' ')}
      >
        {/* 26c under 760px: 25b's swap unchanged — row 1 is the title bar,
            with `← session` and both chips in their compact form. */}
        {swap && (
          <div
            ref={titleRowRef}
            className="orbital-drag-region -mx-[18px] -mt-4 flex h-10 items-center gap-2.5 pt-3 pr-[18px]"
            style={{ paddingLeft: WINDOW_STRIP_INSET_PX }}
          >
            <BackToSession parent={session} onBack={close} />
            <span aria-hidden className="flex-1" />
            {session && (
              <>
                <SubagentChip sessionId={session.id} subagents={session.subagents} compact withinRef={titleRowRef} />
                <TaskChip sessionId={session.id} tasks={session.backgroundTasks ?? []} compact withinRef={titleRowRef} />
              </>
            )}
          </div>
        )}
        <div
          className={[
            'flex items-center gap-2',
            swap ? 'mt-3' : inWindow ? 'orbital-drag-region -mx-[18px] -mt-4 h-[38px] px-[18px] pt-4' : 'h-[22px]',
          ].join(' ')}
        >
          <span className="font-mono text-[9.5px] tracking-[0.18em] text-[rgba(160,190,225,.55)]">
            {kind.toUpperCase()} · OUTPUT · READ-ONLY
          </span>
          <span aria-hidden className="flex-1" />
          {!swap && (
            <Tooltip variant="name" title="Collapse panel" align="right" delayMs={PIN_TOOLTIP_DELAY_MS}>
              <UtilityButton aria-label="Collapse the output panel" onClick={close}>
                <CollapseGlyph />
              </UtilityButton>
            </Tooltip>
          )}
        </div>

        <div className="mt-2 text-pretty text-[15px] font-semibold leading-[1.34] text-text-bright">
          {task?.label ?? 'Background task'}
        </div>

        {/* 26b: the whole command, wrapped and never cut — the flags are the point. */}
        {task?.command && (
          <div className="mt-2.5 whitespace-pre-wrap break-words rounded-[7px] border border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.5)] px-2.5 py-2 font-mono text-[11px] leading-[1.5] text-text-bright">
            <span className="text-[rgba(160,190,225,.5)]">$ </span>
            {task.command}
          </div>
        )}

        <div className="mt-3 flex h-[26px] items-center gap-2">
          {task && (
            <span
              data-task-badge
              className="inline-flex items-center gap-1.5 rounded-[5px] border px-[9px] py-1 font-mono text-[9.5px] tracking-[0.16em]"
              style={{ color: TONE_INK[tone], borderColor: TONE_BORDER[tone] }}
            >
              <ToneDot tone={tone} />
              {badgeText(task)}
            </span>
          )}
          <span aria-hidden className="flex-1" />
          {elapsed && (
            <span
              className="font-mono text-[10.5px]"
              style={{ color: running ? 'rgba(200,225,255,.9)' : 'rgba(160,190,225,.6)' }}
            >
              {elapsed}
            </span>
          )}
          {running && (
            <button
              type="button"
              disabled={stopping}
              onClick={() => void stopTask(view.sessionId, view.taskId)}
              className={[
                'flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-sans text-[11.5px] font-bold transition-colors',
                stopping
                  ? 'orbital-pulse cursor-default border-[rgba(255,187,123,.3)] text-[rgba(255,187,123,.6)]'
                  : 'border-[rgba(255,187,123,.55)] text-[#ffbb7b] hover:bg-[rgba(255,187,123,.1)]',
              ].join(' ')}
            >
              ■ {stopping ? 'Stopping…' : 'Stop'}
            </button>
          )}
        </div>
      </div>

      {view.phase === 'gone' ? (
        <div className="flex flex-1 flex-col items-start justify-center gap-2.5 bg-[rgba(3,5,11,.45)] px-7">
          <span className="font-mono text-[10px] tracking-[0.18em] text-[rgba(160,190,225,.6)]">
            OUTPUT NO LONGER AVAILABLE
          </span>
          <span className="text-pretty text-[13px] leading-[1.55] text-[rgba(200,214,235,.9)]">
            Its output file no longer exists. The task is still listed so the count matches, but there is nothing
            left to show.
          </span>
        </div>
      ) : (
        <div
          ref={scrollRef}
          onScroll={onScroll}
          data-task-output
          className="min-h-0 flex-1 overflow-auto bg-[rgba(3,5,11,.45)] shadow-[inset_0_14px_24px_-18px_rgba(0,0,0,.9)]"
        >
          <div className="px-[18px] py-3 font-mono text-[11px] leading-[1.62] text-[rgba(214,226,244,.86)]">
            {lines.map((line, i) => (
              <div key={i} className="min-h-[1.62em] whitespace-pre-wrap break-words">
                {line}
              </div>
            ))}
            {task && !running && view.phase === 'ready' && (
              <div
                className="mt-2 border-t border-dashed border-[rgba(150,205,255,.16)] pt-2 tracking-[0.04em]"
                style={{ color: TONE_INK[tone] }}
              >
                — {endText(task, elapsed)}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 border-t border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.4)] px-[18px] py-3 font-mono text-[10px] tracking-[0.06em] text-[rgba(160,190,225,.5)]">
        {view.phase === 'gone' ? (
          <span>{task?.endedAt ? `ended ${clockOf(task.endedAt)}` : 'ended'}</span>
        ) : !following ? (
          <button
            type="button"
            onClick={jumpToLatest}
            className="flex items-center gap-1.5 rounded-[5px] border border-[rgba(150,205,255,.3)] bg-[rgba(150,205,255,.14)] px-2 py-[3px] text-text-bright"
          >
            ↓ {newLines > 0 ? `${newLines} new · ` : ''}jump to latest
          </button>
        ) : running ? (
          <span className="flex items-center gap-1.5 text-[var(--state-active)]">
            <span aria-hidden className="orbital-pulse block size-[5px] rounded-full bg-[var(--state-active)]" />
            following the tail
          </span>
        ) : (
          <span>{task?.endedAt ? `ended ${clockOf(task.endedAt)} · output frozen` : 'output frozen'}</span>
        )}
        <span aria-hidden className="flex-1" />
        <span>{swap ? '⎋ back to session' : 'read-only · ⎋ close'}</span>
      </div>
    </Panel>
  )
}

/** The badge's dot in 26e's vocabulary: breathing solid for running, a ring for ended, a square for stopped, dashed for unknown. */
function ToneDot({ tone }: { tone: TaskTone }) {
  const ink = TONE_INK[tone]
  const solid = tone === 'running' || tone === 'stopped'
  return (
    <span
      aria-hidden
      className={['block size-1.5 shrink-0', tone === 'stopped' ? 'rounded-[1px]' : 'rounded-full', tone === 'running' ? 'orbital-pulse' : '']
        .filter(Boolean)
        .join(' ')}
      style={{
        border: `${STATE_DOT_RING_PX}px ${tone === 'unknown' ? 'dashed' : 'solid'} ${ink}`,
        background: solid ? ink : 'transparent',
      }}
    />
  )
}
