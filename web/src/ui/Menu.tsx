import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode, Ref } from 'react'
import { useEscapeLayer } from './escapeLayer'
import { POPUP_SHELL, usePopupPosition } from './usePopupPosition'

export interface MenuItem {
  key: string
  label: string
  /** A glyph for the 20px column in front of the label (23c: "the 23b glyphs double as menu-row icons"). */
  icon?: ReactNode
  /** Mono read-out at the row's right end — 23c's stats row carries its numbers here. */
  detail?: ReactNode
  /** Still in the list and still focusable (a menu keeps its shape), but it does nothing. */
  disabled?: boolean
  onSelect: () => void
}

/** A hairline between groups of rows. */
export const MENU_SEPARATOR = 'separator'

export type MenuEntry = MenuItem | typeof MENU_SEPARATOR

/** What the trigger has to carry — spread it onto the button that opens the menu. */
export interface MenuTriggerProps {
  ref: Ref<HTMLButtonElement>
  'aria-haspopup': 'menu'
  'aria-expanded': boolean
  'aria-controls': string | undefined
  onClick: () => void
  onKeyDown: (e: ReactKeyboardEvent<HTMLButtonElement>) => void
}

export interface MenuButtonProps {
  entries: readonly MenuEntry[]
  /** The menu's accessible name. */
  'aria-label': string
  /** The trigger, drawn by the caller: the menu owns behaviour, not the button's look. */
  renderTrigger: (props: MenuTriggerProps, open: boolean) => ReactElement
  /** Told whenever the menu opens or closes — the header strip holds its form while it is open. */
  onOpenChange?: (open: boolean) => void
  /** Pin the popup's width (23c: 252px). Without it the popup takes its content's width. */
  widthPx?: number
  /** Which of the trigger's edges the popup lines up with. */
  align?: 'left' | 'right'
}

/** Trigger to popup, the same 4px as `Select`'s (23c: the menu starts 4px under the ⋯). */
const POPUP_GAP = 4
/** Type-ahead buffer lifetime, the same as `Select`'s. */
const TYPEAHEAD_MS = 500

const isItem = (entry: MenuEntry): entry is MenuItem => entry !== MENU_SEPARATOR

/**
 * A menu button: a trigger, and a `role="menu"` of actions under it. The
 * sibling of `ui/Select` for a list of things to DO rather than a value to
 * pick — same portalled, positioned shell (`usePopupPosition`, `POPUP_SHELL`),
 * same escape layer, same outside-press dismissal.
 *
 * Unlike `Select`, focus moves INTO the menu (the WAI-ARIA menu button
 * pattern): each row is a real focus target, so a screen reader announces the
 * row it lands on, and closing hands focus back to the trigger.
 *
 * Keys — on the trigger: Enter, Space and ArrowDown open on the first row,
 * ArrowUp on the last. In the menu: arrows move and wrap, Home/End jump,
 * Enter/Space run the row, a letter jumps to the next row starting with it,
 * Escape and Tab close back to the trigger.
 */
export function MenuButton({
  entries,
  renderTrigger,
  onOpenChange,
  widthPx,
  align = 'right',
  ...aria
}: MenuButtonProps) {
  const menuId = useId()
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popupRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef<(HTMLDivElement | null)[]>([])
  const search = useRef({ query: '', at: 0 })
  const [open, setOpen] = useState(false)
  /** Which row takes focus when the menu has just opened. */
  const [initial, setInitial] = useState<'first' | 'last'>('first')

  const items = entries.filter(isItem)

  const latestOnOpenChange = useRef(onOpenChange)
  latestOnOpenChange.current = onOpenChange
  useEffect(() => {
    latestOnOpenChange.current?.(open)
    // A menu that unmounts while open closes as far as its owner knows too —
    // otherwise whatever it holds (the strip's form) would stay held.
    return () => {
      if (open) latestOnOpenChange.current?.(false)
    }
  }, [open])

  const openMenu = useCallback((at: 'first' | 'last') => {
    setInitial(at)
    setOpen(true)
  }, [])

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false)
    search.current = { query: '', at: 0 }
    if (restoreFocus) triggerRef.current?.focus()
  }, [])

  useEscapeLayer(open, () => close(true))

  usePopupPosition(open, triggerRef, popupRef, { gap: POPUP_GAP, align })

  // Into the menu on open. A layout effect, so the first row already holds
  // focus in the frame the menu appears.
  useLayoutEffect(() => {
    if (!open || items.length === 0) return
    itemRefs.current[initial === 'first' ? 0 : items.length - 1]?.focus()
    // Only on opening: re-running on every render would yank focus back to
    // the first row under a pointer that has moved on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // `pointerdown`, not `click`, like `Select`: closing on click would land
  // after the next control had already been pressed.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent | MouseEvent) => {
      const target = e.target
      if (!(target instanceof Node)) return
      if (triggerRef.current?.contains(target) || popupRef.current?.contains(target)) return
      close(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open, close])

  function run(item: MenuItem) {
    if (item.disabled) return
    close(true)
    item.onSelect()
  }

  const focusedIndex = () => itemRefs.current.findIndex((el) => el === document.activeElement)
  const focusAt = (index: number) => itemRefs.current[(index + items.length) % items.length]?.focus()

  function typeahead(char: string): number {
    const now = Date.now()
    const query = (now - search.current.at > TYPEAHEAD_MS ? '' : search.current.query) + char.toLowerCase()
    search.current = { query, at: now }
    const current = focusedIndex()
    const from = query.length === 1 ? current + 1 : current
    for (let i = 0; i < items.length; i++) {
      const index = (from + i + items.length) % items.length
      if (items[index].label.toLowerCase().startsWith(query)) return index
    }
    return -1
  }

  function handleMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const current = focusedIndex()
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        focusAt(current + 1)
        return
      case 'ArrowUp':
        e.preventDefault()
        focusAt(current < 0 ? items.length - 1 : current - 1)
        return
      case 'Home':
        e.preventDefault()
        focusAt(0)
        return
      case 'End':
        e.preventDefault()
        focusAt(items.length - 1)
        return
      case 'Enter':
      case ' ':
        e.preventDefault()
        if (current >= 0) run(items[current])
        return
      case 'Tab':
        // The menu is portalled to the end of <body>; letting Tab run from
        // there would drop focus outside the app. Back to the trigger instead.
        e.preventDefault()
        close(true)
        return
      default:
        break
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const match = typeahead(e.key)
      if (match >= 0) focusAt(match)
    }
  }

  function handleTriggerKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>) {
    if (open) return
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      openMenu('first')
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      openMenu('last')
    }
  }

  const trigger = renderTrigger(
    {
      ref: triggerRef,
      'aria-haspopup': 'menu',
      'aria-expanded': open,
      'aria-controls': open ? menuId : undefined,
      onClick: () => (open ? close(true) : openMenu('first')),
      onKeyDown: handleTriggerKeyDown,
    },
    open,
  )

  let itemIndex = 0
  return (
    <>
      {trigger}
      {open &&
        createPortal(
          <div
            ref={popupRef}
            id={menuId}
            role="menu"
            aria-label={aria['aria-label']}
            onKeyDown={handleMenuKeyDown}
            // 23c form 4: 6px padding, rows 2px apart, and the popup shell
            // Select's listbox wears (10px radius, .96 fill, .16 hairline).
            className={['fixed z-[60] flex max-w-[calc(100vw-16px)] flex-col gap-0.5 p-1.5', POPUP_SHELL].join(' ')}
            style={widthPx === undefined ? undefined : { width: `${widthPx}px` }}
          >
            {entries.map((entry, i) => {
              if (!isItem(entry)) {
                return (
                  <div
                    key={`separator-${i}`}
                    role="separator"
                    className="mx-0.5 my-1 h-px shrink-0 bg-[rgba(150,205,255,.1)]"
                  />
                )
              }
              const index = itemIndex++
              return (
                <div
                  key={entry.key}
                  ref={(el) => {
                    itemRefs.current[index] = el
                  }}
                  role="menuitem"
                  tabIndex={-1}
                  aria-disabled={entry.disabled || undefined}
                  onClick={() => run(entry)}
                  // Pointer and keyboard share one highlight: the row under
                  // the pointer IS the focused row, so arrowing on from a
                  // hover starts where the eye is.
                  onMouseMove={(e) => {
                    if (document.activeElement !== e.currentTarget) e.currentTarget.focus()
                  }}
                  // 23c form 4's rows: 7px/8px in a 7px radius, 10px gap, a
                  // 20px icon column, a 12.5px/600 label. The canvas lights
                  // the first row at the strip's hover fill — that is the
                  // focused row.
                  className={[
                    'group flex shrink-0 cursor-pointer items-center gap-2.5 rounded-[7px] px-2 py-[7px] outline-none',
                    'text-[rgba(220,235,255,.9)] focus:bg-[rgba(150,205,255,.09)] focus:text-[#e8eef8]',
                    'aria-disabled:cursor-default aria-disabled:opacity-50',
                  ].join(' ')}
                >
                  <span
                    aria-hidden
                    className="grid w-5 shrink-0 place-items-center text-[rgba(200,220,245,.7)] group-focus:text-[rgba(200,220,245,.85)]"
                  >
                    {entry.icon}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] font-semibold">{entry.label}</span>
                  {entry.detail !== undefined && (
                    <span className="shrink-0 font-mono text-[10px] text-[rgba(160,190,225,.5)]">{entry.detail}</span>
                  )}
                </div>
              )
            })}
          </div>,
          document.body,
        )}
    </>
  )
}
