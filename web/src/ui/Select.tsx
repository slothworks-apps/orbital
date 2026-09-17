import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useEscapeLayer } from './escapeLayer'

export interface SelectOption<T> {
  value: T
  label: string
  /** Leading dot, e.g. a tag hue (`oklch(80% .13 H)`). Also tints the `pill` trigger's border. */
  dotColor?: string
  /** Trailing count, muted and right-aligned before the ✓ column (canvas 3b). */
  count?: number
  /**
   * Shown on the trigger instead of `label` — for a control that sits
   * somewhere too tight to spell the option out (canvas 3a's origin filter:
   * `other terminals · read-only` in the menu, `read-only` on the trigger).
   * Type-ahead still matches `label`, which is what the user can read while
   * the menu is open.
   */
  short?: string
}

export interface SelectProps<T> {
  options: ReadonlyArray<SelectOption<T>>
  value: T
  /** Fires only on commit (click, Enter, Space). Arrowing around and Escape never commit. */
  onChange: (value: T) => void
  id?: string
  'aria-label'?: string
  'aria-labelledby'?: string
  disabled?: boolean
  /** Typeface: mono for technical values (rules), sans for prose options (settings, canvas 1h). */
  font?: 'mono' | 'sans'
  /**
   * `field` is the boxed control of artboards 1h/1e; `pill` is 1e's
   * rounded-full target-tag pill, tinted with the selected option's hue;
   * `tag` is 1b's session-tag pill — the same hue, but FILLED and with the
   * chevron inline, so the trigger reads as the tag it carries; `ghost` is
   * 3a's origin filter — a bare label inside a list heading, which grows
   * chrome only while it is open or `active`.
   */
  variant?: 'field' | 'pill' | 'tag' | 'ghost'
  /**
   * `ghost` only: keep the lit chrome while the control is closed, because
   * its value is doing something visible (a filter that is narrowing a list).
   */
  active?: boolean
  /** Shown when `value` matches no option. */
  placeholder?: string
  /**
   * Hint pinned under the options (canvas 1b: `ONE TAG PER SESSION · SETS
   * PLANET HUE`). It sits outside the listbox and is wired to the trigger
   * with `aria-describedby`, so it is a description of the control rather
   * than an option nobody can pick.
   */
  footer?: string
  /** Layout-only passthrough (width, margin). Never use to override control styling. */
  className?: string
}

/** Gap between the trigger and the popup, and the popup's minimum clearance from the viewport edge. */
const POPUP_GAP = 4
const VIEWPORT_MARGIN = 8
/** Never squeeze the popup below this; below it, flip instead. */
const MIN_POPUP_HEIGHT = 96
/** Width floor for the `tag` popup (canvas 1b) — its trigger is narrower. */
const TAG_POPUP_MIN_WIDTH = 168
/** Width floor for the `ghost` popup (canvas 3a) — its trigger is narrower still. */
const GHOST_POPUP_MIN_WIDTH = 186
/** Type-ahead buffer lifetime, the same window the platform controls use. */
const TYPEAHEAD_MS = 500

/**
 * A tag hue arrives as a solid `oklch(80% .13 H)`; 1e's pill border is the
 * same hue at `.4`. `color-mix` with transparent is premultiplied, so mixing
 * 40% of the colour yields exactly that colour at alpha .4 — which keeps the
 * call site passing ONE colour instead of a colour and its faded twin.
 */
const tint = (color: string, pct: number) => `color-mix(in oklab, ${color} ${pct}%, transparent)`

const triggerFont: Record<NonNullable<SelectProps<unknown>['font']>, string> = {
  mono: 'font-mono text-xs',
  sans: 'font-sans text-[12.5px]',
}

/**
 * Custom listbox — deliberately NOT a `<select>`. See `web/CLAUDE.md`: the
 * native popup is OS-drawn, so it ignores the app's typography, spacing and
 * dark theme and looks different on every platform.
 *
 * The closed field is verbatim from canvas 1h (8px/10px padding, a 26px right
 * gutter for the chevron, 8px radius over the `rgba(4,8,16,.6)` field fill);
 * the popup follows canvas 1b, which is the one artboard that draws an open
 * listbox (5px padding, 10px radius, flat `rgba(10,16,28,.96)` fill, rows
 * inset at a 7px radius).
 *
 * Focus never leaves the trigger: the active option is tracked with
 * `aria-activedescendant`, and the popup swallows its own pointer-downs so a
 * click cannot pull focus out of the control (which is what keeps an open
 * rule row in `TagsRules` from closing underneath it).
 */
export function Select<T extends string | number>({
  options,
  value,
  onChange,
  id,
  disabled = false,
  font = 'mono',
  variant = 'field',
  active = false,
  placeholder,
  footer,
  className,
  ...aria
}: SelectProps<T>) {
  const baseId = useId()
  const listboxId = `${baseId}-listbox`
  const footerId = `${baseId}-footer`
  const optionId = (index: number) => `${listboxId}-opt-${index}`

  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popupRef = useRef<HTMLDivElement | null>(null)
  const search = useRef({ query: '', at: 0 })

  const [open, setOpen] = useState(false)
  const selectedIndex = options.findIndex((o) => o.value === value)
  const [activeIndex, setActiveIndex] = useState(selectedIndex < 0 ? 0 : selectedIndex)

  const selected = selectedIndex < 0 ? undefined : options[selectedIndex]
  const label = selected?.short ?? selected?.label ?? placeholder ?? ''

  const openPopup = useCallback(
    (index?: number) => {
      if (disabled) return
      setActiveIndex(index ?? (selectedIndex < 0 ? 0 : selectedIndex))
      setOpen(true)
    },
    [disabled, selectedIndex],
  )

  const closePopup = useCallback((restoreFocus: boolean) => {
    setOpen(false)
    search.current = { query: '', at: 0 }
    if (restoreFocus) triggerRef.current?.focus()
  }, [])

  // Innermost escape layer: an open popup outranks the row, panel or dialog
  // it sits in, so one press closes the popup and stops there. Closing never
  // commits — the value is whatever it was before the popup opened.
  useEscapeLayer(open, () => closePopup(true))

  const commit = useCallback(
    (index: number) => {
      const option = options[index]
      closePopup(true)
      if (option && option.value !== value) onChange(option.value)
    },
    [closePopup, onChange, options, value],
  )

  /**
   * Portalled to `<body>` and positioned from the trigger's rect, for two
   * reasons that have both already bitten this codebase: a `backdrop-filter`
   * ancestor (every `Panel`) becomes the containing block for `position:
   * fixed` descendants, and the rules table / settings body are overflow
   * containers that would clip an absolutely-positioned popup.
   */
  const reposition = useCallback(() => {
    const trigger = triggerRef.current
    const popup = popupRef.current
    if (!trigger || !popup) return

    const rect = trigger.getBoundingClientRect()
    // Measure unconstrained first, so the flip decision is made against the
    // height the list actually wants rather than against last frame's cap.
    popup.style.maxHeight = ''
    const natural = popup.offsetHeight

    const below = window.innerHeight - rect.bottom - POPUP_GAP - VIEWPORT_MARGIN
    const above = rect.top - POPUP_GAP - VIEWPORT_MARGIN
    const flip = natural > below && above > below
    const maxHeight = Math.max(MIN_POPUP_HEIGHT, flip ? above : below)
    popup.style.maxHeight = `${maxHeight}px`

    const height = Math.min(natural, maxHeight)
    popup.style.top = flip ? `${rect.top - POPUP_GAP - height}px` : `${rect.bottom + POPUP_GAP}px`
    popup.dataset.placement = flip ? 'above' : 'below'

    // The tag pill is narrower than its own menu, so 1b gives that popup a
    // 168px floor rather than letting it shrink to the trigger; 3a's origin
    // trigger is a word and a caret, and its menu is a sentence wide.
    const floor =
      variant === 'tag'
        ? TAG_POPUP_MIN_WIDTH
        : variant === 'ghost'
          ? GHOST_POPUP_MIN_WIDTH
          : 0
    popup.style.minWidth = `${Math.max(rect.width, floor)}px`
    const width = popup.offsetWidth
    const maxLeft = window.innerWidth - width - VIEWPORT_MARGIN
    // 3a hangs the origin menu off the trigger's RIGHT edge: that trigger sits
    // at the right end of a 300px panel, and a menu wider than it — which it
    // always is — would otherwise spill out of the sidebar and onto the map.
    const wanted = variant === 'ghost' ? rect.right - width : rect.left
    popup.style.left = `${Math.max(VIEWPORT_MARGIN, Math.min(wanted, maxLeft))}px`
  }, [variant])

  // Re-measure rather than close: a scroll inside the rules table or the
  // settings body must not yank the popup away mid-interaction.
  useLayoutEffect(() => {
    if (!open) return
    reposition()
    const onViewportChange = () => reposition()
    window.addEventListener('scroll', onViewportChange, true)
    window.addEventListener('resize', onViewportChange)
    return () => {
      window.removeEventListener('scroll', onViewportChange, true)
      window.removeEventListener('resize', onViewportChange)
    }
  }, [open, options, reposition])

  // Opening lands on the selected row even when the list is longer than the
  // popup. `scrollIntoView` is absent in jsdom, hence the optional call.
  useLayoutEffect(() => {
    if (!open) return
    const el = document.getElementById(optionId(activeIndex))
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [open, activeIndex, listboxId])

  // `pointerdown`, not `click`: closing on click would land after the next
  // control had already been pressed, so the dismissal would fight it.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent | MouseEvent) => {
      const target = e.target
      if (!(target instanceof Node)) return
      if (triggerRef.current?.contains(target) || popupRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open])

  function typeahead(char: string) {
    const now = Date.now()
    const query = (now - search.current.at > TYPEAHEAD_MS ? '' : search.current.query) + char.toLowerCase()
    search.current = { query, at: now }
    // A repeated single character cycles through the options starting with
    // it; a longer buffer re-matches from the current row.
    const from = query.length === 1 ? activeIndex + 1 : activeIndex
    for (let i = 0; i < options.length; i++) {
      const index = (from + i + options.length) % options.length
      if (options[index].label.toLowerCase().startsWith(query)) return index
    }
    return -1
  }

  function handleKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>) {
    if (disabled) return
    const last = options.length - 1

    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        openPopup(e.key === 'ArrowUp' && !e.altKey ? last : undefined)
        return
      }
      if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault()
        openPopup(e.key === 'Home' ? 0 : last)
        return
      }
      if (isTypeaheadKey(e)) {
        e.preventDefault()
        const match = typeahead(e.key)
        openPopup(match < 0 ? undefined : match)
      }
      return
    }

    switch (e.key) {
      case 'Escape':
        // Handled by the popup's escape layer, which is registered above the
        // panels' — see `ui/escapeLayer`. Swallowing it here as well would be
        // harmless but misleading: the layer stack is what makes one press
        // peel exactly one surface.
        return
      case 'Tab':
        // Let focus move on — just don't leave the popup hanging.
        closePopup(false)
        return
      case 'Enter':
        e.preventDefault()
        e.stopPropagation()
        commit(activeIndex)
        return
      case ' ':
        // Space only commits when it isn't part of a type-ahead buffer.
        if (search.current.query && Date.now() - search.current.at <= TYPEAHEAD_MS) break
        e.preventDefault()
        e.stopPropagation()
        commit(activeIndex)
        return
      case 'ArrowDown':
        e.preventDefault()
        if (e.altKey) return closePopup(true)
        setActiveIndex((i) => Math.min(last, i + 1))
        return
      case 'ArrowUp':
        e.preventDefault()
        if (e.altKey) return closePopup(true)
        setActiveIndex((i) => Math.max(0, i - 1))
        return
      case 'Home':
        e.preventDefault()
        setActiveIndex(0)
        return
      case 'End':
        e.preventDefault()
        setActiveIndex(last)
        return
      default:
        break
    }

    if (isTypeaheadKey(e)) {
      e.preventDefault()
      const match = typeahead(e.key)
      if (match >= 0) setActiveIndex(match)
    }
  }

  const isPill = variant === 'pill'
  const isTag = variant === 'tag'
  const isGhost = variant === 'ghost'
  // 3a paints the ghost trigger in two states only: bare, or lit. Open and
  // "narrowing something" are the same state — both mean it has the floor.
  const lit = isGhost && (open || active)
  // Counts need a column that does not move between rows, so the ✓ gutter is
  // reserved for every row as soon as one option carries a count (3b).
  const reserveCheck = options.some((o) => o.count !== undefined)
  // 1e's pill borrows the hue for its border only; 1b's tag pill is filled
  // with it, and brightens on open (border .4 -> .7, fill .1 -> .16).
  const hue = selected?.dotColor
  const triggerStyle: CSSProperties | undefined = !hue
    ? undefined
    : isTag
      ? { borderColor: tint(hue, open ? 70 : 40), background: tint(hue, open ? 16 : 10) }
      : isPill
        ? { borderColor: tint(hue, 40) }
        : undefined

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-activedescendant={open && options.length > 0 ? optionId(activeIndex) : undefined}
        aria-label={aria['aria-label']}
        aria-labelledby={aria['aria-labelledby']}
        aria-describedby={open && footer ? footerId : undefined}
        disabled={disabled}
        data-value={String(value)}
        data-variant={variant}
        onClick={() => (open ? closePopup(true) : openPopup())}
        onKeyDown={handleKeyDown}
        style={triggerStyle}
        className={[
          // No width here on purpose: `className` is the only source of one,
          // so a caller's `w-[200px]` never has to out-order a built-in
          // `w-full` in the stylesheet (see the v4 footguns in web/CLAUDE.md).
          'relative inline-flex min-w-0 cursor-pointer items-center text-left disabled:cursor-not-allowed disabled:opacity-50',
          isGhost ? 'gap-[5px]' : 'gap-1.5',
          // The ghost branch owns its own ink in both states, so it must not
          // also inherit `text-text-bright` — two colour utilities on one
          // element are settled by stylesheet order, not by this array's.
          isGhost ? '' : 'text-text-bright',
          isGhost
            ? // 3a's origin trigger: 3px/7px inside a 6px radius, the heading's
              // own mono face at a looser .04em, transparent until it is lit.
              [
                'rounded-md border px-[7px] py-[3px] font-mono text-[10px] tracking-[0.04em]',
                'transition-[background-color,border-color,color] duration-[180ms] ease-out',
                lit
                  ? 'border-[rgba(150,205,255,.22)] bg-[rgba(150,205,255,.12)] text-[oklch(90%_.06_205)]'
                  : 'border-transparent bg-transparent text-inherit hover:bg-[rgba(150,205,255,.1)]',
              ].join(' ')
            : isTag
              ? // 1b's session-tag pill: 4px/9px/4px/10px inside a 999px
                // hue-tinted border over a hue fill, 11px/600 label, chevron
                // inline rather than in a gutter.
                [
                  'rounded-full border py-1 pl-2.5 pr-[9px] text-[11px] font-semibold',
                  'transition-[background-color,border-color] duration-[180ms] ease-out',
                  font === 'mono' ? 'font-mono' : 'font-sans',
                ].join(' ')
              : isPill
                ? // 1e's target-tag pill: 3px/9px inside a 999px hue-tinted
                  // border, 11px/600 label, chevron in the right gutter.
                  [
                    'rounded-full border border-panel-border py-[3px] pl-[9px] pr-6 text-[11px] font-semibold',
                    font === 'mono' ? 'font-mono' : 'font-sans',
                  ].join(' ')
                : // 1h's field: 8px/10px padding, a 26px right gutter for the
                  // chevron, 8px radius over the rgba(4,8,16,.6) fill.
                  [
                    'rounded-lg border border-panel-border bg-[rgba(4,8,16,.6)] py-2 pl-2.5 pr-[26px] transition-colors',
                    'hover:border-accent/40 focus:border-accent/60 focus:outline-none',
                    triggerFont[font],
                  ].join(' '),
          className ?? '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {selected?.dotColor && (
          <span
            aria-hidden
            className="block h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: selected.dotColor }}
          />
        )}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span
          aria-hidden
          data-caret
          className={
            isTag || isGhost
              ? // Inline, and it flips while the popup is open (1b, 3a).
                `block shrink-0 text-[8px] opacity-70 transition-transform duration-200 ease-out ${open ? 'rotate-180' : ''}`
              : [
                  'pointer-events-none absolute top-1/2 -translate-y-1/2',
                  isPill
                    ? 'right-2 text-[9px] text-text-muted'
                    : 'right-2.5 text-[11px] text-[rgba(160,190,225,.6)]',
                ].join(' ')
          }
        >
          ▾
        </span>
      </button>

      {open &&
        createPortal(
          <div
            ref={popupRef}
            // Keeps DOM focus on the trigger through a click, so the control
            // never fires a focusout that an ancestor reads as "left the row".
            onMouseDown={(e) => e.preventDefault()}
            className={[
              'fixed z-[60] flex max-w-[calc(100vw-16px)] flex-col p-[5px]',
              // Canvas 1b draws this popup literally: 10px radius, a flat
              // rgba(10,16,28,.96) fill (not the panels' gradient glass), a
              // .16 hairline and a single soft drop shadow.
              'rounded-[10px] border border-[rgba(150,205,255,.16)] bg-[rgba(10,16,28,.96)] backdrop-blur-[12px]',
              'shadow-[0_14px_34px_rgba(0,0,0,.55)]',
              triggerFont[font],
            ].join(' ')}
          >
            <div
              role="listbox"
              id={listboxId}
              aria-label={aria['aria-label']}
              aria-labelledby={aria['aria-labelledby']}
              aria-activedescendant={options.length > 0 ? optionId(activeIndex) : undefined}
              className="flex min-h-0 flex-col gap-0.5 overflow-y-auto overscroll-contain"
            >
              {options.map((option, index) => {
                const isSelected = option.value === value
                const isActive = index === activeIndex
                return (
                  <div
                    key={String(option.value)}
                    id={optionId(index)}
                    role="option"
                    aria-selected={isSelected}
                    data-label={option.label}
                    data-active={isActive || undefined}
                    onMouseMove={() => setActiveIndex(index)}
                    onClick={() => commit(index)}
                    // 1b rows: 7px/9px inside a 7px radius, 8px gap. The
                    // canvas paints hover and selection the SAME tint, which
                    // would leave an arrowing keyboard user unable to tell
                    // the two apart — so the active row keeps the accent
                    // tint and only selection uses the canvas's.
                    className={[
                      'flex shrink-0 cursor-pointer items-center gap-2 rounded-[7px] px-[9px] py-[7px]',
                      isActive
                        ? 'bg-accent/10'
                        : isSelected
                          ? 'bg-[rgba(150,205,255,.09)]'
                          : '',
                      isSelected ? 'text-accent' : 'text-text-bright',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {option.dotColor && (
                      <span
                        aria-hidden
                        className="block h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ background: option.dotColor }}
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {option.count !== undefined && (
                      <span aria-hidden className="shrink-0 text-[rgba(160,190,225,.45)]">
                        {option.count}
                      </span>
                    )}
                    {(isSelected || reserveCheck) && (
                      <span
                        aria-hidden
                        className={`shrink-0 text-[10px] text-accent ${isSelected ? '' : 'opacity-0'}`}
                      >
                        ✓
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
            {footer && (
              <div
                id={footerId}
                className="mx-[5px] mt-[3px] mb-0.5 shrink-0 border-t border-[rgba(150,205,255,.1)] pt-1.5 font-mono text-[9.5px] leading-[1.4] tracking-[.1em] text-[rgba(160,190,225,.5)]"
              >
                {footer}
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  )
}

/** A single printable character — anything else is a command key, not a search. */
function isTypeaheadKey(e: ReactKeyboardEvent): boolean {
  return e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey
}
