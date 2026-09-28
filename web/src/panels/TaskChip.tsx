import { useEffect, useState } from 'react'
import type { MouseEvent, RefObject } from 'react'
import { useOrbital } from '../store/store'
import type { BackgroundTask } from '../lib/types'
import { taskPhrase } from '../lib/types'
import {
  kindWord,
  opensOutput,
  rowWord,
  taskChipModel,
  taskElapsedMs,
  taskGroups,
  taskTone,
  type TaskTone,
} from '../lib/backgroundTasks'
import { ELAPSED_TICK_MS } from '../lib/subagentPanel'
import { formatToolDuration } from '../lib/format'
import { STATE_DOT_RING_PX } from '../lib/stateStyle'
import { TASK_TONE } from '../ui/Badge'
import { MENU_SEPARATOR, MenuButton } from '../ui/Menu'
import type { MenuEntry } from '../ui/Menu'

/** Canvas 26a: the dropdown is 25a's shell — the same width, row ceiling and gap as the subagent list. */
const LIST_WIDTH_PX = 372
const LIST_MAX_ROWS = 8
const LIST_GAP_PX = 8
/** Canvas 26e: the meta line's ink. */
const MUTED_INK = 'rgba(160,190,225,.6)'
/** 26e: a row's `no output` stands in for the command, one step dimmer. */
const NO_COMMAND_INK = 'rgba(160,190,225,.4)'
/** 26e: the dashed grey ring of a task that ended without saying how. */
const UNKNOWN_INK = 'rgba(160,190,225,.6)'

/** 25c's table, read for 26e's five tones; `unknown` is 26e's one addition. */
function toneStyle(tone: TaskTone): { ink: string; solid: boolean; square: boolean; dashed: boolean; blink: boolean } {
  switch (tone) {
    case 'running':
      return { ink: TASK_TONE.running.dotColor, solid: true, square: false, dashed: false, blink: true }
    case 'done':
      return { ink: TASK_TONE.completed.dotColor, solid: false, square: false, dashed: false, blink: false }
    case 'failed':
      return { ink: TASK_TONE.failed.dotColor, solid: false, square: false, dashed: false, blink: false }
    case 'stopped':
      return { ink: TASK_TONE.stopped.dotColor, solid: true, square: true, dashed: false, blink: false }
    case 'unknown':
      return { ink: UNKNOWN_INK, solid: false, square: false, dashed: true, blink: false }
  }
}

export interface TaskChipProps {
  sessionId: string
  tasks: readonly BackgroundTask[]
  /** 26c/26e: `2 · 3h 4m` beside the subagent chip in a column too narrow for both full forms. */
  compact?: boolean
  /** The session's turn is over and it waits on what it launched: the chip carries the noun (`2 shells`), the row says only WAITING FOR (26d). */
  waiting?: boolean
  withinRef?: RefObject<HTMLElement | null>
}

/**
 * The detail header's ▣ chip and its dropdown (spec
 * 2026-09-28-background-tasks-design § 3, canvas 26a, 26e): the session's
 * background tasks, running first with a stop on each, then the ended ones.
 * A shell or monitor opens its output in the side slot. What is counted and
 * ordered is `lib/backgroundTasks`'s; this draws it.
 */
export function TaskChip({ sessionId, tasks, compact = false, waiting = false, withinRef }: TaskChipProps) {
  const [nowMs, setNowMs] = useState(Date.now)
  const openTaskOutput = useOrbital((s) => s.openTaskOutput)
  const stopTask = useOrbital((s) => s.stopTask)
  const stopping = useOrbital((s) => s.stoppingTasks)
  const openTaskId = useOrbital((s) => (s.taskOutput?.sessionId === sessionId ? s.taskOutput.taskId : undefined))

  const running = tasks.some((task) => task.state === 'running')

  // The chip's own age reading ticks while anything runs, open or not: the
  // age of a forgotten dev server is the one thing it is there to show.
  useEffect(() => {
    setNowMs(Date.now())
    if (!running) return
    const timer = setInterval(() => setNowMs(Date.now()), ELAPSED_TICK_MS)
    return () => clearInterval(timer)
  }, [running])

  const model = taskChipModel(tasks, nowMs)
  if (!model) return null

  const entries: MenuEntry[] = taskGroups(tasks).flatMap((group, i): MenuEntry[] => [
    ...(i > 0 ? ([MENU_SEPARATOR] as const) : []),
    { heading: group.heading },
    ...group.rows.map((task) => ({
      key: task.id,
      label: task.label,
      disabled: !opensOutput(task),
      selected: task.id === openTaskId,
      body: (
        <TaskRow
          task={task}
          nowMs={nowMs}
          stopping={Boolean(stopping[`${sessionId}:${task.id}`])}
          onStop={() => void stopTask(sessionId, task.id)}
        />
      ),
      onSelect: () => void openTaskOutput(sessionId, task.id),
    })),
  ])

  const runningKinds = tasks.filter((task) => task.state === 'running').map((task) => task.kind)
  const age = model.oldestAgeMs !== undefined ? formatToolDuration(model.oldestAgeMs) : undefined
  const title = [
    `${model.running} running`,
    ...(age ? [`oldest ${age}`] : []),
    `${model.ended} ended`,
    ...(model.failed ? [`${model.failed} failed`] : []),
  ].join(' · ')

  // 26e's forms, in the order they win: the noun after WAITING FOR, the
  // running count (compact drops the word), the ended counts.
  const segments: { text: string; ink?: string }[] = []
  if (model.running > 0) {
    if (waiting) segments.push({ text: taskPhrase(runningKinds, false), ink: 'var(--state-active)' })
    else {
      segments.push({ text: compact ? String(model.running) : `${model.running} running`, ink: 'var(--state-active)' })
      if (age) segments.push({ text: age, ink: 'rgba(200,225,255,.9)' })
    }
  } else {
    segments.push({ text: `${model.ended - model.failed} ended` })
    if (model.failed) segments.push({ text: `${model.failed} failed`, ink: 'var(--state-interrupted)' })
  }

  return (
    <MenuButton
      aria-label="Background tasks"
      entries={entries}
      widthPx={LIST_WIDTH_PX}
      maxRows={LIST_MAX_ROWS}
      gapPx={LIST_GAP_PX}
      align="left"
      withinRef={withinRef}
      footer={
        <div className="mt-1 flex shrink-0 items-center gap-2 border-t border-[rgba(150,205,255,.08)] px-2.5 pt-2 pb-1 font-mono text-[9.5px] tracking-[.06em] text-[rgba(160,190,225,.45)]">
          ↵ open output · ■ stops at once · ⎋ close
          <span aria-hidden className="flex-1" />
          this session only
        </div>
      }
      renderTrigger={(props, isOpen) => {
        // 26e: open, or its output in the slot, is the standard active chip.
        const active = isOpen || openTaskId !== undefined
        return (
          <button
            type="button"
            title={title}
            {...props}
            className={[
              'orbital-no-drag flex h-[22px] shrink-0 items-center gap-[7px] rounded-md border px-2 font-mono text-[10.5px]',
              'transition-[background-color,border-color,color] duration-[180ms] ease-[ease] focus-visible:outline-none',
              active
                ? 'border-[rgba(150,205,255,.3)] bg-[rgba(150,205,255,.14)] text-text-bright'
                : [
                    'border-[rgba(150,205,255,.14)] text-[rgba(160,190,225,.75)]',
                    'hover:border-[rgba(150,205,255,.3)] hover:text-text-bright',
                    'focus-visible:border-[oklch(85%_.12_205_/_.7)] focus-visible:text-text-bright',
                  ].join(' '),
            ].join(' ')}
          >
            <ProcessGlyph running={model.running > 0} blink={!isOpen} />
            {segments.map((segment, i) => (
              <span key={i} className="contents">
                {i > 0 && (
                  <span aria-hidden className="text-[rgba(150,205,255,.3)]">
                    ·
                  </span>
                )}
                <span style={segment.ink ? { color: segment.ink } : undefined}>{segment.text}</span>
              </span>
            ))}
            <span aria-hidden className="text-[8px]">
              {isOpen ? '▴' : '▾'}
            </span>
          </button>
        )
      }}
    />
  )
}

/** 26e's glyph: a 9px square — a process, beside the subagent chip's moon — with the running dot on its corner. */
function ProcessGlyph({ running, blink }: { running: boolean; blink: boolean }) {
  return (
    <span aria-hidden className="relative block h-[9px] w-[9px] shrink-0 rounded-[2px] border-[1.3px] border-current">
      {running && (
        <span
          className={[
            'absolute -top-[3px] -right-[3px] block h-1 w-1 rounded-full bg-[var(--state-active)]',
            blink ? 'orbital-pulse' : '',
          ].join(' ')}
        />
      )}
    </span>
  )
}

/** One row (26e): the dot, the label, then kind, how it ended and the command; elapsed and, while it runs, ■. */
function TaskRow({
  task,
  nowMs,
  stopping,
  onStop,
}: {
  task: BackgroundTask
  nowMs: number
  stopping: boolean
  onStop: () => void
}) {
  const tone = taskTone(task)
  const style = toneStyle(tone)
  const word = rowWord(task)
  const elapsed = formatToolDuration(taskElapsedMs(task, nowMs))
  const hasCommand = Boolean(task.command) && (task.kind === 'shell' || task.kind === 'monitor')
  // 26e: the command, or `no output` for a row that has none to open.
  const meta = hasCommand ? task.command : opensOutput(task) ? undefined : 'no output'

  return (
    <div className="flex items-center gap-2.5">
      <span
        aria-hidden
        className={['block h-2 w-2 shrink-0', style.square ? 'rounded-[1px]' : 'rounded-full', style.blink ? 'orbital-pulse' : '']
          .filter(Boolean)
          .join(' ')}
        style={{
          border: `${STATE_DOT_RING_PX}px ${style.dashed ? 'dashed' : 'solid'} ${style.ink}`,
          background: style.solid ? style.ink : 'transparent',
        }}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-sans text-[12.5px] font-semibold text-text-bright">{task.label}</span>
        <span className="flex min-w-0 gap-1.5 font-mono text-[10px] whitespace-nowrap" style={{ color: MUTED_INK }}>
          <span className="shrink-0">{kindWord(task)}</span>
          {word && (
            <span className="shrink-0" style={{ color: style.ink }}>
              {word}
            </span>
          )}
          {meta && (
            <>
              <span aria-hidden className="shrink-0 text-[rgba(150,205,255,.3)]">
                ·
              </span>
              <span className="truncate" style={{ color: hasCommand ? MUTED_INK : NO_COMMAND_INK }}>
                {meta}
              </span>
            </>
          )}
        </span>
      </span>
      {elapsed !== undefined && (
        <span
          className="shrink-0 font-mono text-[10.5px]"
          style={{ color: tone === 'running' ? 'rgba(200,225,255,.85)' : 'rgba(160,190,225,.55)' }}
        >
          {elapsed}
        </span>
      )}
      {tone === 'running' && <StopButton label={`Stop ${task.label}`} stopping={stopping} onStop={onStop} />}
    </div>
  )
}

/**
 * 26e's ■: a 24px target at a running row's right end, neutral at rest and
 * amber on hover like the composer's Stop. It stops the task and does not
 * open the row. Once pressed it waits, dimmed, for the SDK to confirm (spec
 * § 3) rather than moving the row itself.
 */
export function StopButton({ label, stopping, onStop }: { label: string; stopping: boolean; onStop: () => void }) {
  const stop = (e: MouseEvent) => {
    e.stopPropagation()
    if (!stopping) onStop()
  }
  return (
    <button
      type="button"
      aria-label={label}
      title={stopping ? 'Stopping…' : label}
      disabled={stopping}
      onClick={stop}
      // The row is a menu item that runs on Enter and Space; a key on the
      // button must not also open the row.
      onKeyDown={(e) => e.stopPropagation()}
      className={[
        'grid h-6 w-6 shrink-0 place-items-center rounded-md border',
        'transition-[background-color,border-color,color] duration-[180ms] ease-[ease]',
        stopping
          ? 'orbital-pulse cursor-default border-[rgba(150,205,255,.18)] bg-[rgba(4,8,16,.5)] text-[rgba(200,220,245,.45)]'
          : [
              'border-[rgba(150,205,255,.18)] bg-[rgba(4,8,16,.5)] text-[rgba(200,220,245,.75)]',
              'hover:border-[rgba(255,187,123,.6)] hover:bg-[rgba(255,187,123,.08)] hover:text-[#ffbb7b]',
            ].join(' '),
      ].join(' ')}
    >
      <span aria-hidden className="block h-[7px] w-[7px] rounded-[1.5px] bg-current" />
    </button>
  )
}
