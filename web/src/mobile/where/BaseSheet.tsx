import { useState } from 'react'
import type { BaseRow } from '../../lib/worktree'
import { BottomSheet } from '../ui'
import { baseSheetLines, noteIsKey } from '../worktree'

/**
 * BASE FOR THE NEW WORKTREE (canvas 63g BASE SHEET): what New session's BASE
 * row opens — `BranchSheet`'s shell with its handle and mono title, a search
 * over the branches, then the desktop picker's rows in its order, ✓ on the
 * one chosen. A pick closes the sheet; the backdrop keeps the base as it was.
 */
export function BaseSheet({
  rows,
  value,
  onPick,
  onClose,
}: {
  rows: readonly BaseRow[]
  value: string
  onPick: (value: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const lines = baseSheetLines(rows, query)

  return (
    <BottomSheet label="Base for the new worktree" onDismiss={onClose} swipeToDismiss>
      {/* 63g: the title 2px under the handle, 10px in from the shell's 10. */}
      <div className="px-2.5 pb-2.5 pt-0.5 font-mono fs-10 tracking-[0.18em] text-ink-900/60">BASE FOR THE NEW WORKTREE</div>
      <input
        aria-label="Search branches"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search branches"
        inputMode="search"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        className="mx-1.5 mb-2 box-border block h-11 w-[calc(100%-12px)] rounded-[12px] border border-line/16 bg-space/60 px-3.5 font-mono fs-13 text-ink-100 outline-none placeholder:text-ink-900/50 focus:border-accent/55"
      />
      <div role="listbox" aria-label="Base" data-sheet-scroll className="max-h-[56vh] overflow-y-auto overscroll-contain pb-2">
        {lines.length === 0 && <div className="px-2.5 py-3 fs-13 text-ink-900/60">No branch matches.</div>}
        {lines.map((line) =>
          line.kind === 'caption' ? (
            // 63g: the group's caption, 10px 10px 4px.
            <div key={`cap-${line.label}`} className="px-2.5 pb-1 pt-2.5 font-mono fs-9.5 tracking-[0.14em] text-ink-900/50">
              {line.label}
            </div>
          ) : (
            <BaseSheetRow key={line.row.value} row={line.row} selected={line.row.value === value} onPick={onPick} />
          ),
        )}
      </div>
    </BottomSheet>
  )
}

/** 63g: a 52px row — the name in mono with its note under it, or `local`/`remote` on its right; ✓ on the pick. */
function BaseSheetRow({ row, selected, onPick }: { row: BaseRow; selected: boolean; onPick: (value: string) => void }) {
  const keyed = noteIsKey(row)
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={() => onPick(row.value)}
      className={[
        'flex min-h-13 w-full items-center gap-3 rounded-[10px] px-2.5 py-1.5 text-left text-ink-100',
        selected ? 'bg-line/7' : 'bg-transparent active:bg-line/7',
      ].join(' ')}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-mono fs-13">{row.label}</span>
        {!keyed && row.sub && <span className="truncate fs-12 text-ink-900/65">{row.sub}</span>}
      </span>
      {keyed && row.sub && <span className="shrink-0 font-mono fs-11 text-ink-900/50">{row.sub}</span>}
      <span aria-hidden className={['w-3 shrink-0 font-mono fs-12 text-accent', selected ? '' : 'opacity-0'].join(' ')}>
        ✓
      </span>
    </button>
  )
}
