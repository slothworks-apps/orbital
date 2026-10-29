import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import type { KnownHarnessProject, TemplateScope } from '../../lib/types'
import { Popover, ScopeMark } from './parts'
import { scopeKey } from './logic'

/**
 * 30m's "Where does it live?": Global, or one project. Asked before a new
 * template exists, and reused wherever a scope is picked later — the
 * editor's Scope (Move), a row's Move to…, and Draft…'s "Saves to".
 */
export function ScopePicker({
  open,
  anchorRef,
  projects,
  value,
  cameFromRoot,
  footer,
  onPick,
  onClose,
}: {
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  projects: readonly KnownHarnessProject[]
  /** The row marked ✓ and highlighted on opening. */
  value: TemplateScope
  /** The project of the session Settings was opened from: "where you came from". */
  cameFromRoot: string | null
  /** 30m's footer after ↵, e.g. "create in orbital · change later under Scope". */
  footer: (scope: TemplateScope) => string
  onPick: (scope: TemplateScope) => void
  onClose: () => void
}) {
  const rows: TemplateScope[] = [
    { kind: 'global' },
    ...projects.map((p): TemplateScope => ({ kind: 'project', root: p.root, name: p.name })),
  ]
  const [highlight, setHighlight] = useState(0)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const at = rows.findIndex((r) => scopeKey(r) === scopeKey(value))
    setHighlight(at < 0 ? 0 : at)
    // Focus the list so ↑↓ and ↵ work without a click.
    requestAnimationFrame(() => listRef.current?.focus())
    // Only on opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => (h + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      onPick(rows[highlight])
    }
  }

  const row = (scope: TemplateScope, index: number) => {
    const selected = scopeKey(scope) === scopeKey(value)
    const lit = index === highlight
    const base = 'flex w-full rounded-[7px] text-left transition-colors'
    const fill = lit ? 'bg-line/8' : 'hover:bg-line/5'
    if (scope.kind === 'global') {
      return (
        <button
          key="global"
          type="button"
          role="option"
          aria-selected={selected}
          onMouseEnter={() => setHighlight(index)}
          onClick={() => onPick(scope)}
          className={[base, fill, 'items-start gap-2.5 px-2.5 py-2'].join(' ')}
        >
          <span className="mt-[3px]">
            <ScopeMark scope="global" size={8} border={1.4} />
          </span>
          <span className="flex-1">
            <span className="block fs-12.5 font-semibold">Global</span>
            <span className="mt-0.5 block fs-11 text-ink-900/65">Offered when starting a harness in any project</span>
          </span>
          {selected && <span className="fs-11 text-accent">✓</span>}
        </button>
      )
    }
    return (
      <button
        key={scope.root}
        type="button"
        role="option"
        aria-selected={selected}
        title={scope.root}
        onMouseEnter={() => setHighlight(index)}
        onClick={() => onPick(scope)}
        className={[base, fill, 'items-center gap-2.5 px-2.5 py-[7px]'].join(' ')}
      >
        <ScopeMark scope="project" size={8} border={1.4} />
        <span
          className={[
            'min-w-0 flex-1 truncate font-mono fs-11.5',
            selected ? 'text-ink-100' : 'text-ink-200/85',
          ].join(' ')}
        >
          {scope.name}
        </span>
        {scope.root === cameFromRoot && (
          <span className="font-mono fs-9.5 text-ink-900/55">where you came from</span>
        )}
        {selected && <span className="fs-11 text-accent">✓</span>}
      </button>
    )
  }

  return (
    <Popover open={open} anchorRef={anchorRef} onClose={onClose} width={330} className="gap-0.5 p-1.5">
      <div
        ref={listRef}
        tabIndex={-1}
        role="listbox"
        aria-label="Where does it live?"
        onKeyDown={onKeyDown}
        className="flex flex-col gap-0.5 focus:outline-none"
      >
        <div className="px-2.5 pb-1.5 pt-2 font-mono fs-9.5 tracking-[0.18em] text-ink-900/60">
          WHERE DOES IT LIVE?
        </div>
        {row(rows[0], 0)}
        <div className="mx-2.5 my-1 h-px bg-line/10" />
        <div className="px-2.5 pb-0.5 pt-1.5 font-mono fs-9.5 tracking-[0.18em] text-ink-900/60">
          ONE PROJECT · ONLY ITS SESSIONS
        </div>
        {rows.slice(1).map((scope, i) => row(scope, i + 1))}
        {rows.length === 1 && (
          <div className="px-2.5 py-[7px] font-mono fs-10.5 text-ink-900/50">no project has run a session yet</div>
        )}
      </div>
      <div className="mt-1 border-t border-line/8 px-2.5 pb-1 pt-2 font-mono fs-9.5 text-ink-900/45">
        ↵ {footer(rows[highlight] ?? value)}
      </div>
    </Popover>
  )
}
