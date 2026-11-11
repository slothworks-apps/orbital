import { useState } from 'react'
import type { ProgressItem } from '@orbital/shared/progress'
import { clock, figureText, itemNote, type ProgressListItem, type ProgressRow } from '../lib/progressList'
import type { ChatMessage } from '../lib/types'
import { ProgressGlyph } from '../ui/UtilityButton'
import { ItemRow } from './progress/parts'

const FROZEN_WHY = 'A harness took over. The list stays as it was and doesn’t change any more.'

const itemsWord = (n: number) => `${n} item${n === 1 ? '' : 's'}`

/** The row's head line after the glyph (67d `what`). */
function what(row: ProgressRow): string {
  switch (row.kind) {
    case 'written':
      return `progress · written · ${itemsWord(row.items.length)}`
    case 'changed':
      return ['progress ·', row.added.length > 0 ? `+${row.added.length}` : null, row.dropped.length > 0 ? `−${row.dropped.length}` : null]
        .filter(Boolean)
        .join(' ')
    case 'new_list':
      return `progress · new list · ${itemsWord(row.items.length)}`
    case 'frozen':
      return `progress · frozen at ${figureText(row.items)}`
  }
}

/** The line under the head: the agent's reason, or Orbital's for a new list and a freeze. */
function why(row: ProgressRow): string | null {
  switch (row.kind) {
    case 'written':
      return null
    case 'changed':
      return row.reason ?? null
    case 'new_list':
      return `${row.reason ?? 'A new task in the same session.'} The previous list ended at ${figureText(row.previous)}.`
    case 'frozen':
      return FROZEN_WHY
  }
}

/** What the row unfolds to, and how strongly (67d `snap`, `snapOp`). */
function snapshot(row: ProgressRow): { items: ProgressItem[]; label: string; opacity?: number } | null {
  switch (row.kind) {
    case 'written':
      return { items: row.items, label: 'the list' }
    case 'new_list':
      return { items: row.previous, label: 'the previous list', opacity: 0.7 }
    case 'frozen':
      return { items: row.items, label: 'the list', opacity: 0.62 }
    case 'changed':
      return null
  }
}

/** A mono link in the sky ink (67d's `show the list ▸` and `open beside ›`). */
function RowLink({ children, onClick, expanded }: { children: string; onClick: () => void; expanded?: boolean }) {
  return (
    <button type="button" aria-expanded={expanded} onClick={onClick} className="font-mono fs-10 text-sky hover:text-sky-soft">
      {children}
    </button>
  )
}

/**
 * The progress list in the transcript (canvas `Feature - Progress list` 67d):
 * the harness's dashed row with the list glyph instead of ◆, for a list
 * written, items added or dropped with the agent's reason, a new list, and
 * the freeze when a harness took over. A written list, a previous list and a
 * frozen one unfold to the list as it was; the frozen one also opens beside,
 * in the side slot, when `onOpenList` is given. State changes get no row.
 */
export function ProgressTranscriptRow({ message, onOpenList }: { message: ChatMessage; onOpenList?: () => void }) {
  const [open, setOpen] = useState(false)
  const row = message.progressRow
  if (!row) return null
  const reason = why(row)
  const snap = snapshot(row)
  const at = message.timestamp ? Date.parse(message.timestamp) : Number.NaN
  const side = row.kind === 'frozen' && onOpenList
  return (
    <div data-progress-row className="flex flex-col gap-1.5 rounded-[7px] border border-dashed border-line/18 px-2.5 pt-[7px] pb-2">
      <div className="flex items-center gap-2 whitespace-nowrap font-mono fs-10.5 text-ink-900/75">
        <span className="flex">
          <ProgressGlyph />
        </span>
        <span className="min-w-0 truncate">{what(row)}</span>
        <span className="flex-1" />
        {!Number.isNaN(at) && <span className="text-ink-900/50">{clock(at)}</span>}
      </div>
      {row.kind === 'changed' && (
        <>
          {row.added.map((title) => (
            <ChangeLine key={`+${title}`} sign="+" title={title} />
          ))}
          {row.dropped.map(({ title }) => (
            <ChangeLine key={`−${title}`} sign="−" title={title} dropped />
          ))}
        </>
      )}
      {reason && <div className="pl-[17px] fs-12.5 leading-[1.5] text-pretty text-ink-600/80">{reason}</div>}
      {(snap || side) && (
        <div className="flex gap-3.5 pl-[17px]">
          {snap && (
            <RowLink expanded={open} onClick={() => setOpen((o) => !o)}>
              {open ? `hide ${snap.label} ▾` : `show ${snap.label} ▸`}
            </RowLink>
          )}
          {side && <RowLink onClick={onOpenList}>open beside ›</RowLink>}
        </div>
      )}
      {snap && open && (
        <ul
          className="mt-px ml-[17px] flex flex-col border-l border-line/14 pt-1 pb-0.5 pl-2.5"
          style={snap.opacity !== undefined ? { opacity: snap.opacity } : undefined}
        >
          {snap.items.map((item) => (
            <ItemRow
              key={item.title}
              item={item}
              note={row.kind === 'frozen' && !Number.isNaN(at) ? itemNote(item as ProgressListItem, at) : null}
              size="row"
            />
          ))}
        </ul>
      )}
    </div>
  )
}

/** One title the row added (+) or dropped (−, struck). */
function ChangeLine({ sign, title, dropped = false }: { sign: string; title: string; dropped?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 fs-12.5 leading-[1.45]">
      <span className="w-[9px] flex-none font-mono fs-11 text-ink-500/75">{sign}</span>
      <span
        title={title}
        className={['min-w-0 truncate', dropped ? 'text-ink-900/65 line-through decoration-ink-900/55' : 'text-ink-100'].join(' ')}
      >
        {title}
      </span>
    </div>
  )
}
