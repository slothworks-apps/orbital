import type { ReactNode } from 'react'
import type { ProgressItemState } from '@orbital/shared/progress'
import { useOrbital } from '../store/store'
import { clock, figureText, itemNote, progressMeta, progressSummary, type ProgressList } from '../lib/progressList'
import { useProgressFold, useProgressFrozen } from '../lib/useProgressList'
import { Panel } from '../ui/Panel'
import { useEscapeLayer } from '../ui/escapeLayer'
import { HarnessGlyph, ProgressGlyph } from '../ui/UtilityButton'
import { slotChrome } from './HarnessPanel'
import { CloseGlyph, DashedSeam, HeadButton, HeaderBlock, Kicker, ScopeChip } from './harness/parts'
import { ItemMark, ItemRow } from './progress/parts'
import { BackToSession, type SubagentPanelProps } from './SubagentPanel'

/** 67c's FROZEN note, on the list a harness took over from. */
function frozenText(frozenAt: number | null): string {
  const when = frozenAt !== null ? ` at ${clock(frozenAt)}` : ''
  return `A harness took over${when}. The list stays as the agent left it and doesn’t change any more.`
}

const LEGEND: [ProgressItemState, string][] = [
  ['pending', 'to do'],
  ['in_progress', 'in progress'],
  ['done', 'done'],
  ['dropped', 'dropped'],
]

/** 67c's big figure, `3/7`. */
function FigureNumber({ text, frozen }: { text: string; frozen: boolean }) {
  return (
    <span className={['font-mono fs-22 leading-none tracking-[-0.01em]', frozen ? 'text-ink-500/70' : 'text-ink-100'].join(' ')}>
      {text}
    </span>
  )
}

/** The figure, what it leaves out, and when (67c's header block under the kicker row). */
function Figure({ list, frozen, frozenAt }: { list: ProgressList; frozen: boolean; frozenAt: number | null }) {
  return (
    <>
      <div className="mt-2.5 flex items-baseline gap-2.5">
        <FigureNumber text={figureText(list.items)} frozen={frozen} />
        <span className="font-mono fs-10.5 text-ink-900/65">{progressSummary(list.items, frozen)}</span>
      </div>
      <div className="mt-2 font-mono fs-10 text-ink-900/55">{progressMeta(list, frozenAt, frozen)}</div>
      {frozen && (
        <div className="mt-3 flex flex-col gap-[5px] rounded-lg border border-line/16 bg-line/4 px-3 py-2.5">
          <div className="flex items-center gap-[7px] font-mono fs-9.5 tracking-[0.16em] text-ink-200/80">
            <HarnessGlyph />
            FROZEN
          </div>
          <div className="fs-12 leading-[1.5] text-pretty text-ink-100/88">{frozenText(frozenAt)}</div>
        </div>
      )}
    </>
  )
}

function ProgressSlot({
  sessionId,
  widthPx,
  inWindow,
  swap,
}: {
  sessionId: string
  widthPx: number
  inWindow: boolean
  swap: boolean
}) {
  const close = useOrbital((s) => s.closeProgress)
  const session = useOrbital((s) => s.sessions[sessionId])
  const { list } = useProgressFold(sessionId)
  const { frozen, frozenAt } = useProgressFrozen(sessionId)
  useEscapeLayer(true, close)

  const chrome = slotChrome({
    inWindow,
    swap,
    back: <BackToSession parent={session} onBack={close} />,
    close: (
      <HeadButton label="Close the progress list" onClick={close}>
        <CloseGlyph />
      </HeadButton>
    ),
  })

  let body: ReactNode = null
  if (list) {
    body = (
      <ul
        data-selectable
        aria-label="Progress list"
        // 67c: rows of one line; a long list scrolls under the header, which stays.
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-[18px] pt-3 pb-2"
        style={frozen ? { opacity: 0.62 } : undefined}
      >
        {list.items.map((item) => (
          <ItemRow key={item.title} item={item} note={itemNote(item, frozen ? frozenAt : null)} size="slot" />
        ))}
      </ul>
    )
  }

  return (
    <Panel side={swap ? 'right' : 'subagent'} widthPx={widthPx} fill={inWindow} className="relative flex h-full flex-col overflow-hidden">
      {!swap && <DashedSeam />}
      <HeaderBlock chrome={chrome}>
        {chrome.row(
          <>
            <span className="flex text-ink-900/60">
              <ProgressGlyph />
            </span>
            <Kicker>PROGRESS</Kicker>
            {frozen && <ScopeChip text="read only" />}
            <span className="flex-1" />
            {chrome.close}
          </>,
        )}
        {list ? (
          <Figure list={list} frozen={frozen} frozenAt={frozenAt} />
        ) : session?.progress ? (
          // The Mac has a list the calls are still being read for: its figure
          // alone, and the body stays empty until they land.
          <div className="mt-2.5 flex items-baseline gap-2.5">
            <FigureNumber text={`${session.progress.done}/${session.progress.total}`} frozen={frozen} />
          </div>
        ) : (
          <div className="mt-2.5 font-mono fs-10 text-ink-900/55">The agent hasn’t written its list yet.</div>
        )}
      </HeaderBlock>
      {body ?? <div className="flex-1" />}
      {/* 67c's foot: what the list is, and the four marks. */}
      <div className="flex flex-none flex-wrap items-center gap-2.5 border-t border-line/8 px-[18px] py-[11px] font-mono fs-9.5 text-ink-900/50">
        <span>{frozen ? 'frozen · nothing here changes' : 'read only · the agent keeps this list'}</span>
        <span className="flex-1" />
        {LEGEND.map(([state, label]) => (
          <span key={state} className="flex items-center gap-[5px]">
            <ItemMark state={state} />
            {label}
          </span>
        ))}
      </div>
    </Panel>
  )
}

/**
 * The session's progress list in the side slot (canvas `Feature - Progress
 * list` 67c; spec 2026-11-09-progress-list-design): the harness panel's slot
 * and shell, read only — nothing in it is a control but ×. Renders nothing
 * while `store.progressPanel` is null.
 */
export function ProgressPanel({ widthPx, inWindow = false, swap = false }: SubagentPanelProps) {
  const view = useOrbital((s) => s.progressPanel)
  if (!view) return null
  return <ProgressSlot key={view.sessionId} sessionId={view.sessionId} widthPx={widthPx} inWindow={inWindow || swap} swap={swap} />
}
