import { useEffect, type CSSProperties } from 'react'
import { create } from 'zustand'
import { swatch } from '../../lib/palette'
import type { ApiSession } from '../../lib/types'
import { clockLabel } from '../format'
import { BottomSheet, SheetPresence } from '../ui'
import { sessionSupports } from '../version'
import { itemNote, progressMeta, progressSummary, type ProgressListItem } from '../../lib/progressList'
import { useOrbital } from '../../store/store'
import { figureOf } from './figure'
import { useProgressFold, useProgressFrozen } from '../../lib/useProgressList'

/**
 * Which session's progress sheet is open. The header readout opens it; the
 * frozen list, which has no readout, opens from its transcript row (canvas
 * 67g, fourth phone) — the desktop's row asks the store for its side slot
 * (`openProgress`), and the host below turns that into this sheet.
 */
const useProgressSheet = create<{ sessionId: string | null }>(() => ({ sessionId: null }))

export function openProgressSheet(sessionId: string): void {
  useProgressSheet.setState({ sessionId })
}

function closeProgressSheet(): void {
  useProgressSheet.setState({ sessionId: null })
}

/** Whether the sheet of `sessionId` is open: the readout draws its pressed fill while it is (canvas 67g `tapBg`). */
export function useProgressSheetOpen(sessionId: string): boolean {
  return useProgressSheet((s) => s.sessionId === sessionId)
}

/** The list glyph (canvas 67g): three lines, the last one shorter and fainter. */
export function ListGlyph() {
  return (
    <span aria-hidden className="relative block h-2 w-[9px] shrink-0">
      <span className="absolute left-0 top-0 block h-[1.4px] w-[9px] rounded-[1px] bg-current" />
      <span className="absolute left-0 top-[3.3px] block h-[1.4px] w-[9px] rounded-[1px] bg-current" />
      <span className="absolute left-0 top-[6.6px] block h-[1.4px] w-[5px] rounded-[1px] bg-current opacity-55" />
    </span>
  )
}

/**
 * Canvas 67g `MK`: to do a ring, in progress cyan, done mint, dropped a dash;
 * the harness's colours without its amber.
 */
const ITEM_LOOK: Record<ProgressListItem['state'], { marker: CSSProperties; dash?: true; title: string; weight: number; struck?: true }> = {
  pending: { marker: { border: `1.3px solid ${swatch('ink-900', 0.5)}` }, title: swatch('ink-600', 0.66), weight: 500 },
  in_progress: { marker: { border: `1.3px solid ${swatch('accent')}`, background: swatch('accent') }, title: swatch('ink-100'), weight: 600 },
  done: { marker: { border: `1.3px solid ${swatch('success', 0.75)}`, background: swatch('success', 0.75) }, title: swatch('ink-200', 0.82), weight: 500 },
  dropped: { marker: { background: swatch('ink-900', 0.55) }, dash: true, title: swatch('ink-900', 0.6), weight: 500, struck: true },
}

/** The session screen's progress sheet, while it is open for this session. */
export function ProgressSheetHost({ session }: { session: ApiSession }) {
  const open = useProgressSheetOpen(session.id)
  const supported = sessionSupports('progressList', session.id)
  // Leaving the session closes it: coming back opens the transcript, not the sheet.
  useEffect(() => closeProgressSheet, [session.id])
  // The phone has no side slot: a transcript row asking for it gets the sheet.
  const asked = useOrbital((s) => s.progressPanel?.sessionId === session.id)
  useEffect(() => {
    if (!asked) return
    openProgressSheet(session.id)
    useOrbital.getState().closeProgress()
  }, [asked, session.id])
  return (
    <SheetPresence>
      {open && supported && session.progress ? <ProgressSheet session={session} figure={session.progress} /> : null}
    </SheetPresence>
  )
}

/**
 * The progress list as a sheet (canvas 67g, the harness steps sheet's shell
 * from 10b): the figure and what it leaves out, when it was written and
 * changed, then the items. Read only: nothing in it is pressable, so its
 * items have no › and no pressed state; it closes by a swipe down or a tap
 * outside. Frozen once a harness took over: "read only", the note, items
 * dimmed.
 */
function ProgressSheet({ session, figure }: { session: ApiSession; figure: { done: number; total: number; frozen: boolean } }) {
  const list = useProgressFold(session.id).list
  // The harness that froze the list says when it took over, once it is read.
  const { frozenAt } = useProgressFrozen(session.id)
  const frozen = figure.frozen
  // The figure is the Mac's; what it leaves out and the times need the list.
  const summary = list ? progressSummary(list.items, frozen) : `${figure.total - figure.done} ${frozen ? 'left as they were' : 'to go'}`
  const meta = list ? progressMeta(list, frozenAt) : null

  return (
    <BottomSheet label="Progress list" onDismiss={closeProgressSheet} swipeToDismiss>
      {/* Canvas 67g: the sheet stands 150 px from the top, as 10b's. */}
      <div className="-mx-2.5 flex h-[calc(100dvh-194px)] flex-col">
        <div className="border-b border-line/8 px-5 pb-3.5 pt-1">
          <div className="flex items-center gap-2 font-mono fs-10 tracking-[0.2em] text-ink-900/60">
            <ListGlyph />
            PROGRESS
            {frozen && (
              <span className="rounded-[4px] border border-line/14 px-[7px] py-0.5 tracking-[0.04em] text-ink-500/75">read only</span>
            )}
          </div>
          <div className="mt-2.5 flex items-baseline gap-2.5">
            <span className={['font-mono fs-24 leading-none', frozen ? 'text-ink-500/70' : 'text-ink-100'].join(' ')}>
              {figureOf(figure)}
            </span>
            <span className="font-mono fs-11 text-ink-900/65">{summary}</span>
          </div>
          {meta && <div className="mt-2 font-mono fs-10.5 text-ink-900/55">{meta}</div>}
          {frozen && (
            <div className="mt-3 text-pretty rounded-[10px] border border-line/16 bg-line/4 px-3 py-2.5 fs-13 leading-[1.5] text-ink-100/88">
              {frozenAt !== null
                ? `A harness took over at ${clockLabel(frozenAt)}.`
                : 'A harness took over.'}{' '}
              The list stays as the agent left it and doesn’t change any more.
            </div>
          )}
        </div>
        <div
          data-sheet-scroll
          data-selectable
          className={['flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pt-2', frozen ? 'opacity-[.62]' : ''].join(' ')}
        >
          {list?.items.map((item) => {
            const look = ITEM_LOOK[item.state]
            const note = itemNote(item, frozenAt)
            return (
              <div key={item.title} className="flex shrink-0 gap-2.5 py-2">
                <span className="grid h-5 w-3 shrink-0 place-items-center">
                  <span
                    aria-hidden
                    className={['box-border block w-[7px]', look.dash ? 'h-[1.4px] rounded-[1px]' : 'h-[7px] rounded-full'].join(' ')}
                    style={look.marker}
                  />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                  {/* 67g cuts a long title to one line with the rest on hover; a phone has no hover, so it takes two. */}
                  <span
                    className={['line-clamp-2 fs-14 leading-5', look.struck ? 'line-through' : ''].join(' ')}
                    style={{
                      color: look.title,
                      fontWeight: look.weight,
                      ...(look.struck ? { textDecorationColor: swatch('ink-900', 0.55) } : {}),
                    }}
                  >
                    {item.title}
                  </span>
                  {item.state === 'dropped' && item.reason && (
                    <span className="line-clamp-2 text-pretty fs-13 leading-[1.5] text-ink-600/74">{item.reason}</span>
                  )}
                  {note && <span className="font-mono fs-10.5 tracking-[0.03em] text-ink-900/58">{note}</span>}
                </div>
              </div>
            )
          })}
        </div>
        <div className="border-t border-line/8 px-5 py-3 font-mono fs-10 text-ink-900/55">
          {frozen ? 'frozen · nothing here changes' : 'read only · the agent keeps this list'}
        </div>
      </div>
    </BottomSheet>
  )
}
