import { useEffect, useState } from 'react'
import type { RefObject } from 'react'
import { useOrbital } from '../store/store'
import type { ChatMessage, Subagent } from '../lib/types'
import { chipSegments, isOpenable, listGroups, rowElapsedMs, rowStateWord } from '../lib/subagentList'
import { ELAPSED_TICK_MS, subagentTypeFrom, taskStateFor } from '../lib/subagentPanel'
import { formatToolDuration } from '../lib/format'
import { STATE_DOT_RING_PX } from '../lib/stateStyle'
import { TASK_TONE } from '../ui/Badge'
import { MENU_SEPARATOR, MenuButton } from '../ui/Menu'
import type { MenuEntry } from '../ui/Menu'

/** Canvas 25a: the dropdown's width. */
const LIST_WIDTH_PX = 372
/** Canvas 25a: "max 8 rows visible, then the list scrolls inside the shell". */
const LIST_MAX_ROWS = 8
/** Canvas 25a: the list's top sits this far under the state row. */
const LIST_GAP_PX = 8
/** Canvas 25c: the meta line's ink, which a row without a transcript also dims its dot and word to. */
const MUTED_INK = 'rgba(160,190,225,.6)'

const NO_MESSAGES: readonly ChatMessage[] = []

export interface SubagentChipProps {
  /** The parent session — what `openSubagent` and the parent transcript are keyed on. */
  sessionId: string
  /** That session's own `subagents`, every one it ever had. */
  subagents: readonly Subagent[]
  /**
   * The header row the list stays inside: it hangs under the chip and, when
   * the row is too narrow for that, ends on the row's right edge instead
   * (25a: "right-aligned to the header", drawn in a 450px panel). Without it
   * the list hangs under the chip wherever that lands.
   */
  withinRef?: RefObject<HTMLElement | null>
}

/**
 * The detail header's subagent chip and its dropdown (subagent list spec
 * §§ 1, 2; canvas 25a, 25c): the session's counts on the state row, and
 * under them every subagent the session had, one pick from its transcript.
 * What is counted, grouped and ordered is `lib/subagentList`'s; this only
 * draws it and wires the pick to `openSubagent`.
 */
export function SubagentChip({ sessionId, subagents, withinRef }: SubagentChipProps) {
  const [open, setOpen] = useState(false)
  const [nowMs, setNowMs] = useState(Date.now)
  const openSubagent = useOrbital((s) => s.openSubagent)
  const openAgentId = useOrbital((s) =>
    s.subagentPanel?.sessionId === sessionId ? s.subagentPanel.subagent.id : undefined,
  )
  // Only read while the list is open: the types are drawn nowhere else, and a
  // closed chip has no reason to re-render on every transcript message.
  const parentMessages = useOrbital((s) => (open ? s.transcripts[sessionId] : undefined)) ?? NO_MESSAGES

  const segments = chipSegments(subagents)
  const running = segments.some((segment) => segment.kind === 'running')

  // One clock for the open list, and none while it is closed; the list opens
  // on a fresh reading, and only a running row needs it to advance.
  useEffect(() => {
    if (!open) return
    setNowMs(Date.now())
    if (!running) return
    const timer = setInterval(() => setNowMs(Date.now()), ELAPSED_TICK_MS)
    return () => clearInterval(timer)
  }, [open, running])

  if (segments.length === 0) return null

  const entries: MenuEntry[] = listGroups(subagents).flatMap((group, i): MenuEntry[] => [
    ...(i > 0 ? ([MENU_SEPARATOR] as const) : []),
    { heading: group.heading },
    ...group.rows.map((subagent) => ({
      key: subagent.id,
      label: subagent.name,
      disabled: !isOpenable(subagent),
      selected: subagent.id === openAgentId,
      body: <SubagentRow subagent={subagent} type={subagentTypeFrom(parentMessages, subagent.toolUseId)} nowMs={nowMs} />,
      onSelect: () => void openSubagent(sessionId, subagent),
    })),
  ])

  return (
    <MenuButton
      aria-label="Subagents"
      entries={entries}
      widthPx={LIST_WIDTH_PX}
      maxRows={LIST_MAX_ROWS}
      gapPx={LIST_GAP_PX}
      align="left"
      withinRef={withinRef}
      onOpenChange={setOpen}
      footer={
        // 25a's hint strip, under the scroll.
        <div className="mt-1 flex shrink-0 items-center gap-2 border-t border-[rgba(150,205,255,.08)] px-2.5 pt-2 pb-1 font-mono text-[9.5px] tracking-[.06em] text-[rgba(160,190,225,.45)]">
          ↑↓ move · ↵ open · ⎋ close
          <span aria-hidden className="flex-1" />
          this session only
        </div>
      }
      renderTrigger={(props, isOpen) => (
        <button
          type="button"
          title="Subagents in this session"
          {...props}
          // 25a/25c's chip: as tall as the state badge beside it, so the row
          // does not grow; open is the standard active chip.
          className={[
            'orbital-no-drag flex h-[22px] shrink-0 items-center gap-[7px] rounded-md border px-2 font-mono text-[10.5px]',
            'transition-[background-color,border-color,color] duration-[180ms] ease-[ease] focus-visible:outline-none',
            isOpen
              ? 'border-[rgba(150,205,255,.3)] bg-[rgba(150,205,255,.14)] text-text-bright'
              : [
                  'border-[rgba(150,205,255,.14)] text-[rgba(160,190,225,.75)]',
                  'hover:border-[rgba(150,205,255,.3)] hover:text-text-bright',
                  'focus-visible:border-[oklch(85%_.12_205_/_.7)] focus-visible:text-text-bright',
                ].join(' '),
          ].join(' ')}
        >
          <MoonGlyph running={running} />
          {segments.map((segment, i) => (
            <span key={segment.kind} className="contents">
              {i > 0 && (
                <span aria-hidden className="text-[rgba(150,205,255,.3)]">
                  ·
                </span>
              )}
              <span
                className={
                  segment.kind === 'running'
                    ? 'text-[var(--state-active)]'
                    : segment.kind === 'failed'
                      ? 'text-[var(--state-interrupted)]'
                      : undefined
                }
              >
                {segment.count} {segment.kind}
              </span>
            </span>
          ))}
          <span aria-hidden className="text-[8px]">
            {isOpen ? '▴' : '▾'}
          </span>
        </button>
      )}
    />
  )
}

/**
 * 25c's chip glyph: a ring in the chip's ink with a small body on its near
 * side, lit only while an agent runs. Drawn as the canvas draws it rather
 * than with `ui/Logo`: the rail mark is a fixed-colour gradient drawing,
 * this one is monochrome with a body that comes and goes.
 */
function MoonGlyph({ running }: { running: boolean }) {
  return (
    <span aria-hidden className="relative block h-[9px] w-[9px] shrink-0 rounded-full border-[1.3px] border-current">
      {running && (
        <span className="orbital-pulse absolute -top-[3px] -right-[3px] block h-1 w-1 rounded-full bg-[var(--state-active)]" />
      )}
    </span>
  )
}

/**
 * One row of the list (25a, 25c): the state dot, the task as the title, the
 * type and state word under it, the elapsed time at the right end. The ✓
 * and the row's focus, dimming and keys are `Menu`'s.
 */
function SubagentRow({ subagent, type, nowMs }: { subagent: Subagent; type: string | undefined; nowMs: number }) {
  const state = taskStateFor(subagent, true)
  const tone = TASK_TONE[state]
  const openable = isOpenable(subagent)
  const ink = openable ? tone.dotColor : MUTED_INK
  const word = openable ? rowStateWord(subagent) : 'no transcript'
  const elapsed = formatToolDuration(rowElapsedMs(subagent, nowMs))
  // 25c: solid for running and stopped, a ring for the two that returned.
  const solid = state === 'running' || state === 'stopped'

  return (
    <div className="flex items-center gap-2.5">
      <span
        aria-hidden
        className={['block h-2 w-2 shrink-0', tone.dot === 'square' ? 'rounded-[1px]' : 'rounded-full', tone.blink ? 'orbital-pulse' : '']
          .filter(Boolean)
          .join(' ')}
        style={{ border: `${STATE_DOT_RING_PX}px solid ${ink}`, background: solid ? ink : 'transparent' }}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-sans text-[12.5px] font-semibold text-text-bright">{subagent.name}</span>
        <span className="flex gap-1.5 overflow-hidden font-mono text-[10px] whitespace-nowrap" style={{ color: MUTED_INK }}>
          {type}
          {word && <span style={{ color: openable ? tone.ink : MUTED_INK }}>{word}</span>}
        </span>
      </span>
      {elapsed !== undefined && (
        <span
          className="shrink-0 font-mono text-[10.5px]"
          // 25a: a running row's clock reads brighter than a frozen one.
          style={{ color: state === 'running' ? 'rgba(200,225,255,.85)' : 'rgba(160,190,225,.55)' }}
        >
          {elapsed}
        </span>
      )}
    </div>
  )
}
