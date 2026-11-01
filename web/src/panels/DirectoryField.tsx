import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { recentAge } from '../lib/devices'
import type { DirectoryRow } from '../lib/directorySearch'
import { useDirectorySuggestions } from '../lib/useDirectorySuggestions'
import { useNow } from '../lib/useNow'
import { useEscapeLayer } from '../ui/escapeLayer'
import { Marked } from '../ui/Marked'
import { usePopupPosition } from '../ui/usePopupPosition'

/** The rows' ages read in minutes at the finest: the open list re-reads the clock this often. */
const AGE_TICK_MS = 30_000

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
 *
 * The list is portalled and placed by `usePopupPosition`: the dialog body
 * scrolls, and a list absolutely positioned inside it would be cut off in a
 * short window. Where there is no room below it opens above, and the seam
 * moves to the field's top edge.
 */
export function DirectoryField({ id, value, onChange, projects, onFocus }: DirectoryFieldProps) {
  const suggestions = useDirectorySuggestions(value, projects)
  const { rows, focused } = suggestions
  /** Closed by hand (Esc, a pick) until the next keystroke or focus. */
  const [shut, setShut] = useState(false)
  const [hi, setHi] = useState(-1)
  const [above, setAbove] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  const open = focused && !shut && rows.length > 0
  const now = useNow(open, AGE_TICK_MS)

  usePopupPosition(open, inputRef, popupRef, { gap: 0, matchAnchorWidth: true })
  // The hook writes where it put the list; the field squares the corners on that side.
  // A changed list changes its height, and with it the side it fits on.
  useLayoutEffect(() => {
    const placedAbove = popupRef.current?.dataset.placement === 'above'
    if (open && placedAbove !== above) setAbove(placedAbove)
  }, [open, above, rows])

  const close = () => {
    setShut(true)
    setHi(-1)
  }
  useEscapeLayer(open, close)

  const pick = (path: string) => {
    onChange(path)
    suggestions.settle()
    close()
  }

  // The highlighted row scrolls into view (1c KEYBOARD).
  useEffect(() => {
    if (hi < 0) return
    listRef.current?.querySelectorAll<HTMLElement>('[role="option"]')[hi]?.scrollIntoView?.({ block: 'nearest' })
  }, [hi])

  return (
    <div className="min-w-0 flex-1">
      <input
        ref={inputRef}
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
        {...suggestions.inputProps}
        onChange={(e) => {
          suggestions.type(e.target.value)
          onChange(e.target.value)
          setShut(false)
          setHi(-1)
        }}
        onFocus={(e) => {
          suggestions.inputProps.onFocus(e)
          setShut(false)
          setHi(-1)
          onFocus?.()
        }}
        onBlur={() => {
          suggestions.inputProps.onBlur()
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
        // Canvas 1a/1c ONE SHAPE: open, the corners on the list's side go
        // square and that border drops to the hairline the list continues from.
        className={[
          'block h-[38px] w-full border bg-space/60 px-3 font-mono fs-12.5 text-ink-100 outline-none transition-[border-color,box-shadow] duration-[120ms] ease-out placeholder:text-ink-900/45',
          !open ? 'rounded-[9px]' : above ? 'rounded-b-[9px] rounded-t-none' : 'rounded-t-[9px] rounded-b-none',
          focused ? 'border-accent/50 shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-accent)_10%,transparent)]' : 'border-line/18',
          !open ? '' : above ? 'border-t-line/10' : 'border-b-line/10',
        ].join(' ')}
      />
      {rows.length > 0 &&
        createPortal(
          <div
            ref={popupRef}
            // 1c: the list carries the field's accent border and focus ring
            // round the far corners; the clip hides the ring along the seam.
            className={[
              'orbital-no-drag fixed z-[60] flex flex-col border border-accent/50 bg-panel-solid transition-opacity duration-[120ms] ease-out',
              'shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-accent)_10%,transparent),0_16px_32px_color-mix(in_oklab,var(--color-shadow)_45%,transparent)]',
              above
                ? 'rounded-t-[9px] border-b-0 [clip-path:inset(-48px_-4px_0_-4px)]'
                : 'rounded-b-[9px] border-t-0 [clip-path:inset(0_-4px_-48px_-4px)]',
              open ? 'opacity-100' : 'pointer-events-none invisible opacity-0',
            ].join(' ')}
            aria-hidden={!open}
          >
            <div
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label="Directories"
              className="max-h-[328px] min-h-0 overflow-y-auto p-1 [scrollbar-color:color-mix(in_oklab,var(--color-line)_25%,transparent)_transparent] [scrollbar-width:thin]"
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
                    'flex h-10 shrink-0 cursor-pointer flex-col justify-center gap-0.5 rounded-[6px] px-2.5',
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
          </div>,
          document.body,
        )}
    </div>
  )
}
