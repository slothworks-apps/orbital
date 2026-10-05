import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { EMPTY_OUTPUT, displayLines, kindWord, taskElapsedMs } from '../../lib/backgroundTasks'
import { findPathMatches } from '../../lib/pathLinks'
import { ELAPSED_TICK_MS } from '../../lib/subagentPanel'
import { isReadOnly, type BackgroundTask } from '../../lib/types'
import { useNow } from '../../lib/useNow'
import { useOrbital } from '../../store/store'
import { PHONE_OUTPUT_LINES } from '../constants'
import { isMacAsleep, pushedTop, useMobile } from '../state'
import { INK, elapsedLabel } from '../subagents/model'
import { StopTaskSheet, stoppedHereKey, useStoppedHere } from '../subagents/StopTaskSheet'
import { appendedLines, followPill, taskView } from '../subagents/tasks'
import { MobileScreen } from '../ui'

/** How far above the bottom the reader may sit and still be following the tail. */
const FOLLOW_SLACK_PX = 4

/**
 * A background task's output, pushed over its session (canvas 10g, 10h; spec
 * 2026-10-05-mobile-next § 3): mono on a darker well, the newest
 * `PHONE_OUTPUT_LINES`, following the tail until the reader scrolls up. Stop
 * while it runs, asked once.
 */
export function TaskScreen() {
  const item = useMobile((s) => pushedTop(s, 'task'))
  return item ? <TaskView key={`${item.sessionId}:${item.taskId}`} sessionId={item.sessionId} taskId={item.taskId} /> : null
}

function TaskView({ sessionId, taskId }: { sessionId: string; taskId: string }) {
  const parent = useOrbital((s) => s.sessions[sessionId])
  const live = useOrbital((s) => s.sessions[sessionId]?.backgroundTasks?.find((t) => t.id === taskId))
  const view = useOrbital((s) => (s.taskOutput?.sessionId === sessionId && s.taskOutput.taskId === taskId ? s.taskOutput : null))
  const stopping = useOrbital((s) => s.stoppingTasks[stoppedHereKey(sessionId, taskId)] === true)
  const openTaskOutput = useOrbital((s) => s.openTaskOutput)
  const closeTaskOutput = useOrbital((s) => s.closeTaskOutput)
  const stopTask = useOrbital((s) => s.stopTask)
  const stoppedHere = useStoppedHere((s) => s.keys[stoppedHereKey(sessionId, taskId)] === true)
  const markStopped = useStoppedHere((s) => s.mark)
  const offline = useMobile(isMacAsleep)
  const asOf = useMobile((s) => s.asOf)
  const goBack = useMobile((s) => s.goBack)
  const openFile = useMobile((s) => s.openFile)
  const [confirming, setConfirming] = useState(false)

  // The last reading of the task, for when the session's list no longer carries it.
  const lastKnown = useRef<BackgroundTask | undefined>(undefined)
  if (live) lastKnown.current = live
  const task = live ?? lastKnown.current

  // Read the tail and follow the topic while the screen is up; the store
  // selects the session itself when the task was opened from the list.
  useEffect(() => {
    void openTaskOutput(sessionId, taskId)
    return () => {
      const open = useOrbital.getState().taskOutput
      if (open?.sessionId === sessionId && open.taskId === taskId) closeTaskOutput()
    }
  }, [sessionId, taskId, openTaskOutput, closeTaskOutput])

  const running = task?.state === 'running'
  const now = useNow(running && !offline, ELAPSED_TICK_MS)
  const parentTitle = parent?.title || 'Untitled session'
  const shape = task
    ? taskView({
        task, phase: view?.phase ?? 'loading', stoppedHere, offline, asOf, now,
        readOnly: parent ? isReadOnly(parent) : true,
      })
    : null

  const follow = useFollow(sessionId, taskId)
  const ranFor = task ? taskElapsedMs(task, now) : undefined

  const head = (
    <div className="px-1.5 pb-0.5">
      {/* canvas 10g: ‹ · "▣ <label>" over "background task of <parent> · <kind>". */}
      <div className="flex h-13 items-center gap-1">
        <button
          type="button"
          aria-label={`Back to ${parentTitle}`}
          onClick={() => goBack()}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-[12px] text-[28px] leading-none text-[rgba(220,235,255,.85)]"
        >
          ‹
        </button>
        <div className="min-w-0 flex-1 pr-2">
          <h1 className="truncate font-mono text-[15px] font-medium">▣ {task?.label ?? 'Background task'}</h1>
          <div className="mt-0.5 truncate font-mono text-[10.5px] text-[rgba(160,190,225,.65)]">
            background task of {parentTitle}
            {task && ` · ${kindWord(task)}`}
          </div>
        </div>
      </div>
      {/* canvas 10g: the state word, "after … · hh:mm" once ended, Stop while it runs. */}
      <div className={['flex h-11 items-center gap-2.5 pl-2.5', shape?.canStop ? 'pr-1.5' : 'pr-3.5'].join(' ')}>
        {shape && (
          <span className="flex items-center gap-[7px] font-mono text-[10.5px] tracking-[0.1em]" style={{ color: shape.ink }}>
            {shape.dot && (
              <span
                aria-hidden
                className={['block h-[7px] w-[7px] rounded-full', shape.dot === 'pulse' ? 'orbital-pulse' : ''].join(' ')}
                style={{ background: shape.ink }}
              />
            )}
            {shape.word}
          </span>
        )}
        {shape?.after && <span className="font-mono text-[10.5px] text-[rgba(160,190,225,.55)]">{shape.after}</span>}
        <span aria-hidden className="flex-1" />
        {shape?.canStop && (
          <button
            type="button"
            disabled={stopping}
            onClick={() => setConfirming(true)}
            className="flex h-11 items-center gap-2 rounded-[12px] border border-[oklch(80%_.13_60/.5)] px-3.5 text-[13.5px] font-semibold text-[oklch(85%_.12_60)] disabled:opacity-40"
          >
            <span aria-hidden className="block h-[9px] w-[9px] rounded-[1.5px] bg-current" />
            Stop
          </button>
        )}
      </div>
    </div>
  )

  const footer = (
    // canvas 10g: the follow pill and what the output is; ended, that nothing is left to stop.
    <div className="flex items-center gap-2.5 border-t border-[rgba(150,205,255,.1)] bg-[rgba(6,10,20,.94)] px-4 pb-1.5 pt-2.5 font-mono text-[10.5px] text-[rgba(160,190,225,.6)]">
      {shape?.live ? (
        <>
          <button type="button" onClick={follow.resume} className="flex h-11 items-center" aria-label={follow.paused ? 'Follow the output again' : 'Following the output'}>
            <span
              className="flex h-[30px] items-center rounded-full border border-[rgba(150,205,255,.18)] px-2.5"
              style={{ color: follow.paused ? INK.accent : 'rgba(200,215,235,.8)' }}
            >
              {followPill(follow.paused ? follow.paused.count : null)}
            </span>
          </button>
          <span className="flex-1" />
          last {PHONE_OUTPUT_LINES.toLocaleString('en-US')} lines · read-only
        </>
      ) : running ? (
        <span className="flex h-11 items-center">last {PHONE_OUTPUT_LINES.toLocaleString('en-US')} lines · read-only</span>
      ) : (
        <span className="flex h-11 items-center">ended · nothing to stop</span>
      )}
    </div>
  )

  return (
    <MobileScreen header={head} footer={footer} scroll={false}>
      <div
        ref={follow.scroller}
        onScroll={follow.onScroll}
        className="min-h-0 flex-1 overflow-y-auto bg-[rgba(2,4,9,.7)] py-2.5"
      >
        {/* canvas 10g: the newest line sits on the bottom edge, the older ones above it. */}
        <div className="flex min-h-full flex-col justify-end">
          {follow.shown.map(({ key, text }) => (
            <OutputLine key={key} text={text} onOpen={(path, line) => openFile({ sessionId, path, line })} />
          ))}
          {shape?.cursor && !follow.paused && (
            <div className="px-3.5 font-mono text-[11.5px] leading-[1.8]">
              <span aria-hidden className="orbital-caret inline-block h-[13px] w-[7px] translate-y-[2px] bg-[oklch(85%_.12_205)]" />
            </div>
          )}
          {shape?.end && (
            <div
              className="mx-3.5 mt-2 border-t border-[rgba(150,205,255,.12)] pt-2 font-mono text-[11px]"
              style={{ color: shape.end.ink }}
            >
              {shape.end.text}
            </div>
          )}
        </div>
      </div>
      {confirming && task && (
        <StopTaskSheet
          label={task.label}
          ranFor={ranFor === undefined ? undefined : elapsedLabel(ranFor, true)}
          parentTitle={parentTitle}
          onCancel={() => setConfirming(false)}
          onStop={() => {
            setConfirming(false)
            markStopped(stoppedHereKey(sessionId, taskId))
            void stopTask(sessionId, taskId)
          }}
        />
      )}
    </MobileScreen>
  )
}

/**
 * One output line (canvas 10g): mono, wrapped anywhere. A path the phone can
 * show opens its preview at its line (spec § 2); the rest stays text. Kept
 * by its line number, so a new line draws itself and nothing above it does.
 */
const OutputLine = memo(function OutputLine({ text, onOpen }: { text: string; onOpen: (path: string, line: number | null) => void }) {
  const matches = findPathMatches(text)
  const parts: ReactNode[] = []
  let at = 0
  for (const match of matches) {
    if (match.index > at) parts.push(text.slice(at, match.index))
    parts.push(
      <button
        key={match.index}
        type="button"
        onClick={() => onOpen(match.path, match.line)}
        className="inline break-all text-left text-[oklch(85%_.12_205)]"
      >
        {match.text}
      </button>,
    )
    at = match.index + match.length
  }
  if (at < text.length) parts.push(text.slice(at))
  return (
    <div className="whitespace-pre-wrap break-all px-3.5 font-mono text-[11.5px] leading-[1.8] text-[rgba(214,230,248,.88)]">
      {parts.length > 0 ? parts : ' '}
    </div>
  )
}, (a, b) => a.text === b.text)

interface Paused {
  /** The lines as they stood when the reader scrolled up, with their keys. */
  shown: { key: number; text: string }[]
  /** Complete lines that arrived since. */
  count: number
}

/**
 * Following the tail (canvas 10g, 10h FOLLOWING PAUSED): at the bottom the
 * output grows and stays in view; scrolled up, it holds still and only
 * counts what arrives, until ↓ live or a scroll back to the bottom. Each
 * line keeps one key for its life, counted from the first line the view
 * ever held, so lines dropping off the top redraw nothing.
 */
function useFollow(sessionId: string, taskId: string) {
  const output = useOrbital((s) =>
    s.taskOutput?.sessionId === sessionId && s.taskOutput.taskId === taskId ? s.taskOutput.output : EMPTY_OUTPUT,
  )
  const [first, setFirst] = useState(0)
  const [paused, setPaused] = useState<Paused | null>(null)
  const scroller = useRef<HTMLDivElement | null>(null)

  // Count what the store appends: lines that fell off the top move `first`
  // on; while paused, the new ones are counted, not drawn.
  useEffect(() => {
    let prev = useOrbital.getState().taskOutput?.output.lines ?? EMPTY_OUTPUT.lines
    return useOrbital.subscribe((state) => {
      const view = state.taskOutput
      const next = view?.sessionId === sessionId && view.taskId === taskId ? view.output.lines : EMPTY_OUTPUT.lines
      if (next === prev) return
      const appended = appendedLines(prev, next)
      const dropped = prev.length + appended - next.length
      prev = next
      if (dropped !== 0) setFirst((f) => f + dropped)
      if (appended > 0) setPaused((p) => (p ? { ...p, count: p.count + appended } : p))
    })
  }, [sessionId, taskId])

  const current = useMemo(() => {
    const all = displayLines(output)
    const shown = all.slice(-PHONE_OUTPUT_LINES)
    const offset = first + all.length - shown.length
    return shown.map((text, i) => ({ key: offset + i, text }))
  }, [output, first])

  const shown = paused ? paused.shown : current

  useLayoutEffect(() => {
    const el = scroller.current
    if (el && !paused) el.scrollTop = el.scrollHeight
  }, [current, paused])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX
    if (!atBottom && !paused) setPaused({ shown: current, count: 0 })
    else if (atBottom && paused) setPaused(null)
  }

  return { scroller, shown, paused, onScroll, resume: () => setPaused(null) }
}
