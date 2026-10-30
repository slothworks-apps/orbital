import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { recentAge } from '../lib/devices'
import { searchDirectories, type DirectoryRow } from '../lib/directorySearch'
import { useEscapeLayer } from '../ui/escapeLayer'
import { Marked } from '../ui/Marked'

export interface DirectoryFieldProps {
  id: string
  value: string
  onChange: (value: string) => void
  /** The chosen device's directories, most recent first: the same list as its RECENT chips. */
  projects: readonly DirectoryRow[]
  /** Called when the field takes focus: 50g's folder chooser closes then. */
  onFocus?: () => void
}

/**
 * New session's PROJECT DIRECTORY field with its suggestion list (canvas
 * `Feature - Directory suggestions` 1a–1c). The list hangs from the field
 * while it has focus: the most recent directories until something is typed,
 * then every directory whose path holds the query (`searchDirectories`). It
 * closes on no match, on Esc, or when a row is picked. Nothing is highlighted
 * until ↓, so Enter never swaps out a path that was typed.
 */
export function DirectoryField({ id, value, onChange, projects, onFocus }: DirectoryFieldProps) {
  /** What was typed here, while it is still what the field holds; null until then. */
  const [typed, setTyped] = useState<string | null>(null)
  const [focused, setFocused] = useState(false)
  /** Closed by hand (Esc, a pick) until the next keystroke or focus. */
  const [shut, setShut] = useState(false)
  const [hi, setHi] = useState(-1)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  // A value set from outside — a RECENT chip, Browse…, switching device — is not a query.
  const query = typed !== null && typed === value ? typed : ''
  const rows = useMemo(() => searchDirectories(projects, query), [projects, query])
  const open = focused && !shut && rows.length > 0

  const close = () => {
    setShut(true)
    setHi(-1)
  }
  useEscapeLayer(open, close)

  const pick = (path: string) => {
    onChange(path)
    setTyped(null)
    close()
  }

  // The highlighted row scrolls into view (1c KEYBOARD).
  useEffect(() => {
    const list = listRef.current
    if (!list || hi < 0) return
    const row = list.querySelectorAll<HTMLElement>('[role="option"]')[hi]
    if (!row) return
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop - 4
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight + 4
  }, [hi])

  const now = Date.now()

  return (
    <div className="relative min-w-0 flex-1">
      <input
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && hi >= 0 ? `${listId}-${hi}` : undefined}
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder="Type a name or a path"
        onChange={(e) => {
          setTyped(e.target.value)
          onChange(e.target.value)
          setShut(false)
          setHi(-1)
        }}
        onFocus={() => {
          setFocused(true)
          setShut(false)
          setHi(-1)
          onFocus?.()
        }}
        // Leaving the field settles what was typed: the next focus opens on the recent list again.
        onBlur={() => {
          setFocused(false)
          setTyped(null)
          setHi(-1)
        }}
        onKeyDown={(e) => {
          if (!open) return
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setHi((h) => Math.min(h + 1, rows.length - 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setHi((h) => Math.max(h - 1, -1))
          } else if (e.key === 'Enter' && hi >= 0 && !e.metaKey && !e.ctrlKey) {
            e.preventDefault()
            e.stopPropagation()
            pick(rows[hi].row.cwd)
          }
        }}
        // Canvas 1a/1c ONE SHAPE: open, the lower corners go square and the
        // bottom border drops to the hairline the list continues from.
        className={[
          'block h-[38px] w-full border bg-space/60 px-3 font-mono fs-12.5 text-ink-100 outline-none transition-[border-color,box-shadow] duration-[120ms] ease-out placeholder:text-ink-900/45',
          open ? 'rounded-t-[9px] rounded-b-none' : 'rounded-[9px]',
          focused ? 'border-accent/50 shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-accent)_10%,transparent)]' : 'border-line/18',
          open ? 'border-b-line/10' : '',
        ].join(' ')}
      />
      <div
        // 1c: the list carries the field's accent border and focus ring down
        // and round its bottom corners; the clip hides the ring along the seam.
        className={[
          'absolute left-0 right-0 top-[38px] z-[5] rounded-b-[9px] border border-t-0 border-accent/50 bg-panel-solid transition-opacity duration-[120ms] ease-out [clip-path:inset(0_-4px_-48px_-4px)]',
          'shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-accent)_10%,transparent),0_16px_32px_color-mix(in_oklab,var(--color-shadow)_45%,transparent)]',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        ].join(' ')}
        aria-hidden={!open}
      >
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Directories"
          className="max-h-[328px] overflow-y-auto p-1 [scrollbar-color:color-mix(in_oklab,var(--color-line)_25%,transparent)_transparent] [scrollbar-width:thin]"
        >
          {rows.map((m, i) => (
            <div
              key={m.row.cwd}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === hi}
              onMouseEnter={() => setHi(i)}
              // mousedown, not click: the field keeps its focus.
              onMouseDown={(e) => {
                e.preventDefault()
                pick(m.row.cwd)
              }}
              className={[
                'flex h-10 cursor-pointer flex-col justify-center gap-0.5 rounded-[6px] px-2.5',
                i === hi ? 'bg-line/12' : '',
              ].join(' ')}
            >
              <span className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate font-sans fs-12.5 font-bold text-ink-100">
                  <Marked text={m.name} marks={m.nameMarks} />
                </span>
                <span className="shrink-0 font-mono fs-10 text-ink-900/50">{recentAge(m.row.lastAt, now)}</span>
                <span
                  aria-hidden
                  className={['w-2.5 shrink-0 font-mono fs-10 text-ink-500/75', i === hi ? '' : 'opacity-0'].join(' ')}
                >
                  ↵
                </span>
              </span>
              <span className="truncate pr-[18px] font-mono fs-10 text-ink-900/60">
                <Marked text={m.path} marks={m.pathMarks} bright />
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
