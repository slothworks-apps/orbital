import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useEscapeLayer } from './escapeLayer'

export interface SelectOption<T> {
  value: T
  label: string
  /** Leading dot, e.g. a tag hue (`oklch(80% .13 H)`). Also tints the `pill` trigger's border. */
  dotColor?: string
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
   * rounded-full target-tag pill, tinted with the selected option's hue.
   */
  variant?: 'field' | 'pill'
  /** Shown when `value` matches no option. */
  placeholder?: string
  /** Layout-only passthrough (width, margin). Never use to override control styling. */
  className?: string
}

/** Gap between the trigger and the popup, and the popup's minimum clearance from the viewport edge. */
const POPUP_GAP = 4
const VIEWPORT_MARGIN = 8
/** Never squeeze the popup below this; below it, flip instead. */
const MIN_POPUP_HEIGHT = 96
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
 * the popup has no artboard, so it borrows the panel vocabulary (glass fill,
 * `rgba(150,205,255,.x)` hairline, accent for the selected row).
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
  placeholder,
  className,
  ...aria
}: SelectProps<T>) {
  const listboxId = `${useId()}-listbox`
  const optionId = (index: number) => `${listboxId}-opt-${index}`

  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popupRef = useRef<HTMLDivElement | null>(null)
  const search = useRef({ query: '', at: 0 })

  const [open, setOpen] = useState(false)
  const selectedIndex = options.findIndex((o) => o.value === value)
  const [activeIndex, setActiveIndex] = useState(selectedIndex < 0 ? 0 : selectedIndex)

  const selected = selectedIndex < 0 ? undefined : options[selectedIndex]
  const label = selected?.label ?? placeholder ?? ''

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

    popup.style.minWidth = `${rect.width}px`
    const width = popup.offsetWidth
    const maxLeft = window.innerWidth - width - VIEWPORT_MARGIN
    popup.style.left = `${Math.max(VIEWPORT_MARGIN, Math.min(rect.left, maxLeft))}px`
  }, [])

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
  const triggerStyle: CSSProperties | undefined =
    isPill && selected?.dotColor ? { borderColor: tint(selected.dotColor, 40) } : undefined

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
          'relative inline-flex min-w-0 cursor-pointer items-center text-left text-text-bright disabled:cursor-not-allowed disabled:opacity-50',
          isPill
            ? // 1e's target-tag pill: 3px/9px inside a 999px hue-tinted border,
              // 11px/600 label, with the chevron living in the right gutter.
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
            className="mr-1.5 block h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: selected.dotColor }}
          />
        )}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span
          aria-hidden
          className={[
            'pointer-events-none absolute top-1/2 -translate-y-1/2',
            isPill ? 'right-2 text-[9px] text-text-muted' : 'right-2.5 text-[11px] text-[rgba(160,190,225,.6)]',
          ].join(' ')}
        >
          ▾
        </span>
      </button>

      {open &&
        createPortal(
          <div
            ref={popupRef}
            role="listbox"
            id={listboxId}
            aria-label={aria['aria-label']}
            aria-labelledby={aria['aria-labelledby']}
            aria-activedescendant={options.length > 0 ? optionId(activeIndex) : undefined}
            // Keeps DOM focus on the trigger through a click, so the control
            // never fires a focusout that an ancestor reads as "left the row".
            onMouseDown={(e) => e.preventDefault()}
            className={[
              'fixed z-[60] max-w-[calc(100vw-16px)] overflow-y-auto overscroll-contain py-1',
              // Panel vocabulary: the dense glass of the floating panels, the
              // standard hairline, and the field's own 8px radius.
              'rounded-lg border border-[rgba(150,205,255,.18)] bg-gradient-to-b from-[rgba(16,22,38,.94)] to-[rgba(8,12,22,.97)] backdrop-blur-[24px]',
              'shadow-[0_24px_60px_rgba(0,0,0,.6),inset_0_1px_0_rgba(255,255,255,.06)]',
              triggerFont[font],
            ].join(' ')}
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
                  className={[
                    'flex cursor-pointer items-center gap-2 px-2.5 py-2',
                    isActive ? 'bg-accent/10' : '',
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
                  {isSelected && (
                    <span aria-hidden className="shrink-0 text-[10px] text-accent">
                      ✓
                    </span>
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

/** A single printable character — anything else is a command key, not a search. */
function isTypeaheadKey(e: ReactKeyboardEvent): boolean {
  return e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey
}
