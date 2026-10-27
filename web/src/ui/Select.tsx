import { useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode, Ref } from 'react'
import { useEscapeLayer } from './escapeLayer'
import { POPUP_SHELL, usePopupPosition } from './usePopupPosition'

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
  /** Leading glyph (canvas 50g: the device's kind glyph), on the row and on the `device` trigger. */
  glyph?: ReactNode
  /** Mono line after the label (canvas 50g: `headless · Linux`, or why the device cannot be picked). */
  sub?: string
  /** Listed but not pickable (canvas 50g: an offline or too-old device): muted, and a click or ⏎ does nothing. */
  inert?: boolean
  /**
   * Mono value after the label, on the row's right and on the `field`
   * trigger (canvas `Feature - Text size` 6a: the percentage a text step
   * gives).
   */
  trail?: string
  /** The trigger's `trail`, where the chosen row's own would mislead (6a: the size that results, not the one saved). */
  triggerTrail?: string
}

export interface SelectProps<T> {
  options: ReadonlyArray<SelectOption<T>>
  value: T
  /** Fires only on commit (click, Enter, Space). Arrowing around and Escape never commit. */
  onChange: (value: T) => void
  id?: string
  'aria-label'?: string
  'aria-labelledby'?: string
  /** Native hover title on the trigger — where a control names the shortcut that opens it. */
  title?: string
  disabled?: boolean
  /** Typeface: mono for technical values (rules), sans for prose options (settings, canvas 1h). */
  font?: 'mono' | 'sans'
  /**
   * `field` is the boxed control of artboards 1h/1e; `pill` is 1e's
   * rounded-full target-tag pill, tinted with the selected option's hue;
   * `tag` is 1b's session-tag pill — the same hue, but FILLED and with the
   * chevron inline, so the trigger reads as the tag it carries; `ghost` is
   * 3a's origin filter — a bare label inside a list heading, which grows
   * chrome only while it is open or `active`; `device` is 50g's DEVICE
   * field — the glyph, the name and its sub-line on one roomier row;
   * `chip` is 61h's model chip in the report dialog (`Feature - Feedback`) — a
   * small mono pill whose menu hangs off its right edge, the ✓ leading each
   * row and the option's `sub` trailing it as a short description.
   */
  variant?: 'field' | 'pill' | 'tag' | 'ghost' | 'device' | 'chip'
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
  /** For a keyboard shortcut that opens the control from outside it (`session.tag`). */
  ref?: Ref<SelectHandle>
}

export interface SelectHandle {
  /** Focuses the trigger and opens the popup, exactly as pressing ↓ on it would. */
  open(): void
}

/** Gap between the trigger and the popup. The viewport margin and the height
 * floor live with the mechanics, in `usePopupPosition`. */
const POPUP_GAP = 4
/** Width floor for the `tag` popup (canvas 1b) — its trigger is narrower. */
const TAG_POPUP_MIN_WIDTH = 168
/** Width floor for the `ghost` popup (canvas 3a) — its trigger is narrower still. */
const GHOST_POPUP_MIN_WIDTH = 186
/** The `chip` popup's width (canvas 61h's model menu). */
const CHIP_POPUP_MIN_WIDTH = 220
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
  mono: 'font-mono fs-12 leading-(--text-xs--line-height)',
  sans: 'font-sans fs-12.5',
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
  ref,
  title,
  ...aria
}: SelectProps<T>) {
  const baseId = useId()
  const listboxId = `${baseId}-listbox`
  const footerId = `${baseId}-footer`
  // Memoised so the scroll-into-view effect below can depend on it by name
  // rather than on the `listboxId` it closes over.
  const optionId = useCallback((index: number) => `${listboxId}-opt-${index}`, [listboxId])

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

  // Focus first: the popup's keyboard (arrows, type-ahead, ⏎) is the
  // trigger's own `onKeyDown`, so an open popup without a focused trigger
  // could only be driven by the mouse.
  useImperativeHandle(
    ref,
    () => ({
      open() {
        triggerRef.current?.focus()
        openPopup()
      },
    }),
    [openPopup],
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
      if (option?.inert) return
      closePopup(true)
      if (option && option.value !== value) onChange(option.value)
    },
    [closePopup, onChange, options, value],
  )

  // Portalled to `<body>` and positioned from the trigger's rect — see
  // `usePopupPosition`, which owns the flip/clamp/re-measure mechanics this
  // control and the composer's completion list share.
  //
  // The tag pill is narrower than its own menu, so 1b gives that popup a 168px
  // floor rather than letting it shrink to the trigger; 3a's origin trigger is
  // a word and a caret, and its menu is a sentence wide — and 3a hangs that
  // menu off the trigger's RIGHT edge, because the trigger sits at the right
  // end of a 300px panel and a left-aligned menu would spill onto the map.
  usePopupPosition(open, triggerRef, popupRef, {
    gap: POPUP_GAP,
    align: variant === 'ghost' || variant === 'chip' ? 'right' : 'left',
    minWidth:
      variant === 'tag'
        ? TAG_POPUP_MIN_WIDTH
        : variant === 'ghost'
          ? GHOST_POPUP_MIN_WIDTH
          : variant === 'chip'
            ? CHIP_POPUP_MIN_WIDTH
            : 0,
  })

  // Opening lands on the selected row even when the list is longer than the
  // popup. `scrollIntoView` is absent in jsdom, hence the optional call.
  useLayoutEffect(() => {
    if (!open) return
    const el = document.getElementById(optionId(activeIndex))
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [open, activeIndex, optionId])

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
  const isDevice = variant === 'device'
  const isChip = variant === 'chip'
  // 3a paints the ghost trigger in two states only: bare, or lit. Open and
  // "narrowing something" are the same state — both mean it has the floor.
  const lit = isGhost && (open || active)
  // Counts need a column that does not move between rows, so the ✓ gutter is
  // reserved for every row as soon as one option carries a count (3b).
  const reserveCheck = options.some((o) => o.count !== undefined || o.trail !== undefined)
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
        title={title}
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
          isGhost || isChip ? 'gap-[5px]' : isDevice ? 'gap-2.5' : 'gap-1.5',
          // The ghost branch owns its own ink in both states, so it must not
          // also inherit `text-text-bright` — two colour utilities on one
          // element are settled by stylesheet order, not by this array's.
          isGhost || isChip ? '' : 'text-text-bright',
          isChip
            ? // 61h's model chip: 4px/8px/4px/10px in a 999px hairline, mono
              // 10.5px; open lights the border to .3 over a .14 fill.
              [
                'whitespace-nowrap rounded-full border py-1 pl-2.5 pr-2 font-mono fs-10.5 text-[rgba(214,230,248,.85)]',
                'transition-[background-color,border-color] duration-[180ms] ease-out',
                open
                  ? 'border-[rgba(150,205,255,.3)] bg-[rgba(150,205,255,.14)]'
                  : 'border-[rgba(150,205,255,.14)] bg-transparent hover:bg-[rgba(150,205,255,.06)]',
              ].join(' ')
            : isGhost
            ? // 3a's origin trigger: 3px/7px inside a 6px radius, the heading's
              // own mono face at a looser .04em, transparent until it is lit.
              [
                'rounded-md border px-[7px] py-[3px] font-mono fs-10 tracking-[0.04em]',
                'transition-[background-color,border-color,color] duration-[180ms] ease-out',
                lit
                  ? 'border-[rgba(150,205,255,.22)] bg-[rgba(150,205,255,.12)] text-[oklch(90%_.06_205)]'
                  : 'border-transparent bg-transparent text-inherit hover:bg-[rgba(150,205,255,.1)]',
              ].join(' ')
            : isDevice
              ? // 50g's DEVICE field: 9px/12px inside a 9px radius over the
                // field fill; the border lights to the accent at .5 while open,
                // `border-color .18s ease`.
                [
                  'rounded-[9px] border bg-[rgba(4,8,16,.6)] px-3 py-[9px] font-sans',
                  'transition-[border-color] duration-[180ms] ease-[ease]',
                  open ? 'border-[oklch(85%_.12_205/.5)]' : 'border-[rgba(150,205,255,.18)]',
                ].join(' ')
            : isTag
              ? // 1b's session-tag pill: 4px/9px/4px/10px inside a 999px
                // hue-tinted border over a hue fill, 11px/600 label, chevron
                // inline rather than in a gutter.
                [
                  'rounded-full border py-1 pl-2.5 pr-[9px] fs-11 font-semibold',
                  'transition-[background-color,border-color] duration-[180ms] ease-out',
                  font === 'mono' ? 'font-mono' : 'font-sans',
                ].join(' ')
              : isPill
                ? // 1e's target-tag pill: 3px/9px inside a 999px hue-tinted
                  // border, 11px/600 label, chevron in the right gutter.
                  [
                    'rounded-full border border-panel-border py-[3px] pl-[9px] pr-6 fs-11 font-semibold',
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
        {isDevice ? (
          // 50g: glyph, the name at 13px/600, the sub-line in mono 11px, then
          // the caret pushed right.
          <>
            {selected?.glyph && <span aria-hidden className="flex shrink-0 text-text-bright">{selected.glyph}</span>}
            <span className="shrink-0 fs-13 font-semibold text-text-bright">{label}</span>
            {selected?.sub && (
              <span className="min-w-0 truncate font-mono fs-11 text-[rgba(160,190,225,.6)]">{selected.sub}</span>
            )}
            <span aria-hidden className="flex-1" />
          </>
        ) : (selected?.triggerTrail ?? selected?.trail) ? (
          // 6a: the choice at 600, the value it gives in mono after it.
          <>
            <span className="min-w-0 truncate font-semibold">{label}</span>
            <span className="shrink-0 font-mono fs-10.5 text-[rgba(160,190,225,.6)]">{selected.triggerTrail ?? selected.trail}</span>
            <span aria-hidden className="flex-1" />
          </>
        ) : (
          <span className="min-w-0 flex-1 truncate">{label}</span>
        )}
        <span
          aria-hidden
          data-caret
          className={
            isChip
              ? 'block shrink-0 fs-8 text-[rgba(160,190,225,.6)]'
              : isDevice
              ? // 50g: 8px, inline, flips while open (`transform .2s ease`).
                `block shrink-0 fs-8 text-[rgba(160,190,225,.6)] transition-transform duration-200 ease-[ease] ${open ? 'rotate-180' : ''}`
              : isTag || isGhost
              ? // Inline, and it flips while the popup is open (1b, 3a).
                `block shrink-0 fs-8 opacity-70 transition-transform duration-200 ease-out ${open ? 'rotate-180' : ''}`
              : [
                  'pointer-events-none absolute top-1/2 -translate-y-1/2',
                  isPill
                    ? 'right-2 fs-9 text-text-muted'
                    : 'right-2.5 fs-11 text-[rgba(160,190,225,.6)]',
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
              'orbital-no-drag orbital-popover-in fixed z-[60] flex max-w-[calc(100vw-16px)] flex-col p-[5px]',
              // Canvas 1b's shell, shared with `MenuButton` (see `POPUP_SHELL`).
              POPUP_SHELL,
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
                if (isChip) {
                  return (
                    <ChipRow
                      key={String(option.value)}
                      id={optionId(index)}
                      option={option}
                      selected={isSelected}
                      active={isActive}
                      onHover={() => setActiveIndex(index)}
                      onPick={() => commit(index)}
                    />
                  )
                }
                if (isDevice) {
                  return (
                    <DeviceRow
                      key={String(option.value)}
                      id={optionId(index)}
                      option={option}
                      selected={isSelected}
                      active={isActive}
                      onHover={() => setActiveIndex(index)}
                      onPick={() => commit(index)}
                    />
                  )
                }
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
                    aria-disabled={option.inert || undefined}
                    className={[
                      'flex shrink-0 items-center gap-2 rounded-[7px] px-[9px] py-[7px]',
                      option.inert ? 'cursor-default opacity-[.38]' : 'cursor-pointer',
                      isActive && !option.inert
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
                    {option.trail && (
                      <span className="shrink-0 font-mono fs-10 tracking-[0.04em] text-[rgba(160,190,225,.6)]">
                        {option.trail}
                      </span>
                    )}
                    {(isSelected || reserveCheck) && (
                      <span
                        aria-hidden
                        className={`shrink-0 fs-10 text-accent ${isSelected ? '' : 'opacity-0'}`}
                      >
                        ✓
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
            {footer && isChip ? (
              // 61h: 6px/9px/4px under a .08 rule, mono 10px at .5.
              <div
                id={footerId}
                className="mt-0.5 shrink-0 border-t border-[rgba(150,205,255,.08)] px-[9px] pb-1 pt-1.5 font-mono fs-10 leading-normal text-[rgba(160,190,225,.5)]"
              >
                {footer}
              </div>
            ) : footer && (
              <div
                id={footerId}
                className="mx-[5px] mt-[3px] mb-0.5 shrink-0 border-t border-[rgba(150,205,255,.1)] pt-1.5 font-mono fs-9.5 leading-[1.4] tracking-[.1em] text-[rgba(160,190,225,.5)]"
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

/**
 * One row of the `device` menu (canvas 50g `gOpts`): 8px/10px inside a 7px
 * radius, 10px gaps; the glyph, the name in sans 13px/600, the sub-line in
 * mono 10.5px filling the row, and the ✓ column. Inert rows are muted to
 * .5 and keep the default cursor. The selected row rests at .07, the active
 * one (hover or arrows) at .09 — 50g's hover tint.
 */
function DeviceRow<T>({
  id,
  option,
  selected,
  active,
  onHover,
  onPick,
}: {
  id: string
  option: SelectOption<T>
  selected: boolean
  active: boolean
  onHover: () => void
  onPick: () => void
}) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      aria-disabled={option.inert || undefined}
      data-label={option.label}
      data-active={active || undefined}
      onMouseMove={onHover}
      onClick={onPick}
      className={[
        'flex shrink-0 items-center gap-2.5 rounded-[7px] px-2.5 py-2',
        option.inert ? 'cursor-default text-[rgba(160,190,225,.5)]' : 'cursor-pointer text-text-bright',
        active ? 'bg-[rgba(150,205,255,.09)]' : selected ? 'bg-[rgba(150,205,255,.07)]' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {option.glyph && <span aria-hidden className="flex shrink-0">{option.glyph}</span>}
      <span className="shrink-0 font-sans fs-13 font-semibold">{option.label}</span>
      <span
        className={[
          'min-w-0 flex-1 truncate font-mono fs-10.5',
          option.inert ? 'text-[rgba(160,190,225,.5)]' : 'text-[rgba(160,190,225,.6)]',
        ].join(' ')}
      >
        {option.sub}
      </span>
      <span aria-hidden className={`shrink-0 font-mono fs-10 text-accent ${selected ? '' : 'opacity-0'}`}>
        ✓
      </span>
    </div>
  )
}

/** A single printable character — anything else is a command key, not a search. */
function isTypeaheadKey(e: ReactKeyboardEvent): boolean {
  return e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey
}

/**
 * One row of the `chip` menu (canvas 61h): 7px/9px inside a 7px radius, 8px
 * gaps on the baseline; a 10px ✓ column first, the name in mono 11.5px, and
 * the `sub` description pushed right in sans 11px.
 */
function ChipRow<T>({
  id,
  option,
  selected,
  active,
  onHover,
  onPick,
}: {
  id: string
  option: SelectOption<T>
  selected: boolean
  active: boolean
  onHover: () => void
  onPick: () => void
}) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      data-label={option.label}
      data-active={active || undefined}
      onMouseMove={onHover}
      onClick={onPick}
      className={[
        'flex shrink-0 cursor-pointer items-baseline gap-2 rounded-[7px] px-[9px] py-[7px] text-text-bright',
        active ? 'bg-[rgba(150,205,255,.08)]' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <span aria-hidden className="w-2.5 shrink-0 font-sans fs-11 text-accent">
        {selected ? '✓' : ''}
      </span>
      <span className="font-mono fs-11.5">{option.label}</span>
      <span aria-hidden className="flex-1" />
      {option.sub && <span className="whitespace-nowrap font-sans fs-11 text-[rgba(160,190,225,.6)]">{option.sub}</span>}
    </div>
  )
}
