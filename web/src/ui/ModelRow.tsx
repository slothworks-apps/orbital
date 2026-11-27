import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { KeyboardEvent as ReactKeyboardEvent, Ref } from 'react'
import { formatContextWindow } from '../lib/format'
import { modelByValue, modelCardSlots, recentModelCards } from '../lib/models'
import type { OrbitalModel } from '../lib/types'
import { CustomModelField } from './CustomModelField'
import { ModelsUnread, contextLabel } from './ModelCards'
import { useEscapeLayer } from './escapeLayer'
import { usePresence } from './usePresence'
import { POPUP_SHELL, usePopupPosition } from './usePopupPosition'

export interface ModelRowProps {
  /** The account's whole catalog, in its own order: what Other lists. */
  models: OrbitalModel[]
  /** The account's recently used model ids, newest first (`GET /api/models`' `recentModels`). */
  recent: string[]
  /** The model the dialog preselected: it always has a card of its own. */
  preselected: string | null
  /** SDK `value` of the Settings default — `DEFAULT` leads its context line. */
  defaultValue: string | null
  /** The selection: a catalog `value`, an id the catalog does not list (a custom ID), or null. */
  value: string | null
  /** A catalog model was picked, from a card or from Other's list. */
  onChange: (value: string) => void
  /** A custom ID was typed in Other's list and validated. */
  onCustom: (id: string) => void
  /** The Claude directory a custom ID is checked under; absent, the server's default. */
  claudeDir?: number
}

/** canvas 72c: the gap between cards, and the list's distance under the row (top 64 = the 56 px row + 8). */
const ROW_GAP_PX = 8
/** canvas 72b: Other's list scrolls its model rows past this height; Custom ID… stays pinned under them. */
const LIST_ROWS_MAX_HEIGHT = 306

/**
 * New session's MODEL field (canvas 72a–72c, spec
 * 2026-11-27-recent-model-cards-design): one 56 px row of cards at every
 * width — the account's recent models, newest first, and Other last. Width
 * decides how many (`modelCardSlots`), never the size of the catalog.
 *
 * Other opens the whole catalog as a list hanging under the row, its width,
 * with Custom ID… pinned last; that row turns into a mono field in place.
 * A model picked there that has a card selects the card; any other shows in
 * the Other card, selected. The list keeps `Select`'s behaviour — focus
 * stays on its trigger, the arrows walk the rows, an outside press or Escape
 * closes it — and `Select`'s shell, but fades in and out rather than
 * unrolling (72c: "the list opens and closes with the same fade").
 */
export function ModelRow({
  models,
  recent,
  preselected,
  defaultValue,
  value,
  onChange,
  onCustom,
  claudeDir,
}: ModelRowProps) {
  const rowRef = useRef<HTMLDivElement | null>(null)
  const otherRef = useRef<HTMLButtonElement | null>(null)
  const popupRef = useRef<HTMLDivElement | null>(null)
  const listboxId = `${useId()}-models`
  const optionId = useCallback((index: number) => `${listboxId}-${index}`, [listboxId])

  const [width, setWidth] = useState(0)
  const hasModels = models.length > 0
  useLayoutEffect(() => {
    const el = rowRef.current
    if (!el) return
    setWidth(el.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width
      if (next !== undefined) setWidth(next)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasModels])
  const slots = modelCardSlots(width)

  // Depends on nothing a click changes, so picking a card never reshuffles the row.
  const cards = useMemo(
    () => recentModelCards({ models, recent, preselected, defaultValue, slots: slots - 1 }),
    [models, recent, preselected, defaultValue, slots],
  )

  const pickedRow = modelByValue(value, models)
  const custom = value !== null && !pickedRow
  /** Other holds the selection: a catalog model with no card, or a custom ID. */
  const holds = value !== null && !cards.some((c) => c.value === value)

  const [open, setOpen] = useState(false)
  const [typing, setTyping] = useState(false)
  // canvas 72b `ddIn .16s ease-out` / `ddOut .12s ease-in`.
  const presence = usePresence(open, 160, 120)
  /** The row the arrows are on; `models.length` is Custom ID…. */
  const [activeIndex, setActiveIndex] = useState(0)
  const customIndex = models.length

  const selectedIndex = custom ? customIndex : Math.max(0, models.findIndex((m) => m.value === value))
  const openList = (index = selectedIndex) => {
    setActiveIndex(index)
    setOpen(true)
  }
  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false)
    setTyping(false)
    if (restoreFocus) otherRef.current?.focus()
  }, [])

  useEscapeLayer(open, () => close(true))
  // Registered after the list's, so it outranks it: Escape in the field goes back to the row (72b).
  useEscapeLayer(open && typing, () => {
    setTyping(false)
    otherRef.current?.focus()
  })

  const commit = (index: number) => {
    if (index === customIndex) {
      setActiveIndex(index)
      setTyping(true)
      return
    }
    const row = models[index]
    close(true)
    if (row && row.value !== value) onChange(row.value)
  }

  usePopupPosition(presence.mounted, rowRef, popupRef, { gap: ROW_GAP_PX, matchAnchorWidth: true })

  useLayoutEffect(() => {
    if (!open) return
    document.getElementById(optionId(activeIndex))?.scrollIntoView?.({ block: 'nearest' })
  }, [open, activeIndex, optionId])

  // `pointerdown`, as `Select` does: a click would land after the next control had been pressed.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent | MouseEvent) => {
      const target = e.target
      if (!(target instanceof Node)) return
      if (otherRef.current?.contains(target) || popupRef.current?.contains(target)) return
      setOpen(false)
      setTyping(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open])

  function handleOtherKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>) {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        openList(e.key === 'ArrowUp' ? customIndex : undefined)
      }
      return
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setActiveIndex((i) => Math.min(customIndex, i + 1))
        return
      case 'ArrowUp':
        e.preventDefault()
        setActiveIndex((i) => Math.max(0, i - 1))
        return
      case 'Home':
        e.preventDefault()
        setActiveIndex(0)
        return
      case 'End':
        e.preventDefault()
        setActiveIndex(customIndex)
        return
      case 'Enter':
      case ' ':
        e.preventDefault()
        e.stopPropagation()
        commit(activeIndex)
        return
      case 'Tab':
        close(false)
        return
    }
  }

  if (!hasModels) return <ModelsUnread />

  const otherName = !holds ? 'Other' : custom ? value : pickedRow!.shortVersion
  const otherSub = !holds ? 'ALL MODELS' : custom ? 'CUSTOM ID' : cardSub(pickedRow!, defaultValue)
  const otherTitle = !holds
    ? 'All models on this account, or a custom ID'
    : custom
      ? `${value} · custom ID`
      : `${pickedRow!.shortVersion} · from the full list`
  const listOpen = open && presence.state !== 'exiting'

  return (
    <>
      <div
        ref={rowRef}
        role="radiogroup"
        aria-label="Model"
        className="grid w-full gap-2"
        style={{ gridTemplateColumns: `repeat(${cards.length + 1}, minmax(0, 1fr))` }}
      >
        {cards.map((model) => (
          <RowCard
            key={model.value}
            name={model.shortVersion}
            sub={cardSub(model, defaultValue)}
            title={cardTitle(model)}
            on={value === model.value}
            dataModel={model.value}
            onClick={() => {
              if (open) close(false)
              if (model.value !== value) onChange(model.value)
            }}
          />
        ))}
        <RowCard
          ref={otherRef}
          name={otherName}
          sub={otherSub}
          title={otherTitle}
          ariaLabel="Other"
          on={holds}
          lit={listOpen}
          caret={listOpen ? 'up' : 'down'}
          aria={{
            'aria-haspopup': 'listbox',
            'aria-expanded': open,
            'aria-controls': listboxId,
            'aria-activedescendant': open && !typing ? optionId(activeIndex) : undefined,
          }}
          onClick={() => (open ? close(true) : openList())}
          onKeyDown={handleOtherKeyDown}
        />
      </div>

      {presence.mounted &&
        createPortal(
          <div
            ref={popupRef}
            // Keeps focus on the Other card through a press in the list, as `Select`'s popup does; the field's own press is its.
            onMouseDown={(e) => {
              if (!(e.target instanceof HTMLInputElement)) e.preventDefault()
            }}
            inert={presence.state === 'exiting' || undefined}
            className={[
              'orbital-no-drag fixed z-[60] flex flex-col p-[5px]',
              POPUP_SHELL,
              'motion-safe:transition-opacity',
              presence.state === 'entered'
                ? 'opacity-100 motion-safe:duration-[160ms] motion-safe:ease-out'
                : presence.state === 'exiting'
                  ? 'pointer-events-none opacity-0 motion-safe:duration-[120ms] motion-safe:ease-in'
                  : 'opacity-0',
            ].join(' ')}
          >
            <div role="listbox" id={listboxId} aria-label="All models" className="flex min-h-0 flex-col">
              {/* 72b hides the scrollbar: the cut row says there is more. */}
              <div
                className="flex min-h-0 flex-col gap-0.5 overflow-y-auto overscroll-contain"
                style={{ maxHeight: LIST_ROWS_MAX_HEIGHT, scrollbarWidth: 'none' }}
              >
                {models.map((model, index) => {
                  const selected = !custom && value === model.value
                  return (
                    <div
                      key={model.value}
                      id={optionId(index)}
                      role="option"
                      aria-selected={selected}
                      data-model={model.value}
                      onMouseMove={() => setActiveIndex(index)}
                      onClick={() => commit(index)}
                      className={listRowClassName(index === activeIndex, selected)}
                    >
                      {/* 72b's cost column is left out: the catalog carries no price (ADR models-come-from-the-sdk). */}
                      <span className="shrink-0 font-mono fs-12">{model.shortVersion}</span>
                      <span className="min-w-0 truncate font-mono fs-10.5 text-ink-900/60">{contextLabel(model)}</span>
                      <span aria-hidden className="flex-1" />
                      <span className="shrink-0 font-mono fs-9.5 tracking-[0.1em] text-ink-900/45">
                        {model.value === defaultValue ? 'DEFAULT' : cards.includes(model) ? 'ON A CARD' : ''}
                      </span>
                      <Dot on={selected} />
                    </div>
                  )
                })}
              </div>
              {/* 72b: Custom ID… pinned under a hairline, 4px either side of it. */}
              <div className="mt-1 shrink-0 border-t border-line/10 pt-1">
                {typing ? (
                  <CustomModelField
                    variant="in-list"
                    autoFocus
                    initial={custom && value ? { id: value, trusted: true } : undefined}
                    onValidated={(id) => {
                      close(true)
                      if (id !== value) onCustom(id)
                    }}
                    onCleared={() => {}}
                    claudeDir={claudeDir}
                  />
                ) : (
                  <div
                    id={optionId(customIndex)}
                    role="option"
                    aria-selected={custom}
                    onMouseMove={() => setActiveIndex(customIndex)}
                    onClick={() => commit(customIndex)}
                    className={listRowClassName(activeIndex === customIndex, custom)}
                  >
                    <span
                      className={[
                        'min-w-0 flex-1 truncate font-mono fs-12',
                        custom ? 'text-ink-100' : 'text-ink-500/80',
                      ].join(' ')}
                    >
                      {custom ? value : 'Custom ID…'}
                    </span>
                    <span className="shrink-0 font-mono fs-9.5 tracking-[0.1em] text-ink-900/45">ANY ID</span>
                    {custom && <Dot on />}
                  </div>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

/** The card's context line (72c): `DEFAULT` leads it, so it is never the part an ellipsis cuts. */
function cardSub(model: OrbitalModel, defaultValue: string | null): string {
  if (model.value !== defaultValue) return contextLabel(model) ?? ' '
  return model.contextWindow !== null ? `DEFAULT · ${formatContextWindow(model.contextWindow).toUpperCase()}` : 'DEFAULT'
}

function cardTitle(model: OrbitalModel): string {
  return model.contextWindow !== null
    ? `${model.shortVersion} · ${formatContextWindow(model.contextWindow)} context`
    : model.shortVersion
}

/**
 * canvas 72b's list row: at least 34 px, 10px sides inside a 7px radius, 10px
 * gaps. Selected at .08, the row under the pointer or the arrows at .09.
 */
function listRowClassName(active: boolean, selected: boolean): string {
  return [
    'flex min-h-[34px] shrink-0 cursor-pointer items-center gap-2.5 rounded-[7px] px-2.5 text-ink-100',
    active ? 'bg-line/9' : selected ? 'bg-line/8' : '',
  ].join(' ')
}

/** canvas 72b: the 7px accent dot marking the selection, on a card and on a row. */
function Dot({ on, corner = false }: { on: boolean; corner?: boolean }) {
  return (
    <span
      aria-hidden
      className={[
        'block h-[7px] w-[7px] shrink-0 rounded-full bg-accent',
        corner ? 'absolute right-2 top-2.5 transition-opacity duration-[180ms] ease-[ease]' : '',
        on ? 'opacity-100' : 'opacity-0',
      ].join(' ')}
    />
  )
}

interface RowCardProps {
  name: string
  sub: string
  title: string
  on: boolean
  /** Other while its list is open: the accent edge at .5, not yet selected. */
  lit?: boolean
  /** Other's ▾, turned over while its list is open. */
  caret?: 'down' | 'up'
  ariaLabel?: string
  dataModel?: string
  aria?: Record<string, string | boolean | undefined>
  onClick: () => void
  onKeyDown?: (e: ReactKeyboardEvent<HTMLButtonElement>) => void
  ref?: Ref<HTMLButtonElement>
}

/**
 * One card of the row (canvas 72b): 56 px tall, 10px inside a 10px radius,
 * the name in mono 11 over the context line in mono 9 at .04em, the dot in
 * the top right corner. Selected: the accent edge at .7 over an .08 wash
 * and a 20px glow, the context line in the accent.
 */
function RowCard({ name, sub, title, on, lit = false, caret, ariaLabel, dataModel, aria, onClick, onKeyDown, ref }: RowCardProps) {
  return (
    <button
      ref={ref}
      type="button"
      role="radio"
      aria-checked={on}
      aria-label={ariaLabel ?? name}
      title={title}
      data-active={on}
      data-model={dataModel}
      onClick={onClick}
      onKeyDown={onKeyDown}
      {...aria}
      className={[
        'relative box-border h-14 min-w-0 rounded-[10px] border p-2.5 text-left text-ink-100',
        'transition-[border-color,background-color,box-shadow] duration-[180ms] ease-[ease]',
        on
          ? 'border-accent/70 bg-accent/8 shadow-[0_0_20px_color-mix(in_oklab,_var(--color-accent)_15%,_transparent)]'
          : lit
            ? 'border-accent/50 bg-space/40'
            : 'border-line/14 bg-space/40 hover:bg-ink-50/5',
      ].join(' ')}
    >
      <Dot on={on} corner />
      <span className="block truncate pr-2 font-mono fs-11">{name}</span>
      <span
        className={[
          'mt-[5px] flex items-center gap-1 font-mono fs-9 tracking-[0.04em]',
          on ? 'text-accent' : 'text-ink-900/50',
        ].join(' ')}
      >
        <span className="min-w-0 flex-1 truncate">{sub}</span>
        {caret && (
          <span
            aria-hidden
            className={[
              'block flex-none fs-8 text-ink-900/60 transition-transform duration-200 ease-[ease]',
              caret === 'up' ? 'rotate-180' : '',
            ].join(' ')}
          >
            ▾
          </span>
        )}
      </span>
    </button>
  )
}
