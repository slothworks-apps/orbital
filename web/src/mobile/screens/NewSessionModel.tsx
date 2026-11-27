import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api, ApiError } from '../../lib/api'
import { formatContextWindow } from '../../lib/format'
import { modelByValue, modelCardSlots, recentModelCards } from '../../lib/models'
import type { OrbitalModel } from '../../lib/types'
import { contextLabel } from '../../ui/ModelCards'
import { humanizeError } from '../composer'
import { BottomSheet, FieldLabel, SheetPresence } from '../ui'

/**
 * The row's width before it is measured (and in jsdom, which measures
 * nothing): canvas 72d's 390 px screen less its 16 px sides.
 */
const UNMEASURED_ROW_PX = 358

/** Canvas 72d's meta line: `DEFAULT · 1M` on the default, `1M CTX` on any other, nothing when unknown. */
function cardMeta(model: OrbitalModel, isDefault: boolean): string {
  if (!isDefault) return contextLabel(model) ?? ''
  return model.contextWindow !== null ? `DEFAULT · ${formatContextWindow(model.contextWindow).toUpperCase()}` : 'DEFAULT'
}

/** How many cards the row holds, Other included: measured, and again whenever it resizes. */
function useCardSlots(drawn: boolean) {
  const row = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = row.current
    if (!el) return
    setWidth(el.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setWidth(el.clientWidth))
    observer.observe(el)
    return () => observer.disconnect()
    // The row is drawn only once the catalog has rows; measured from then.
  }, [drawn])
  return { row, slots: modelCardSlots(width > 0 ? width : UNMEASURED_ROW_PX) }
}

/**
 * Why a custom id could not be checked — the check never ran, so it says
 * nothing about the id. `POST /api/models/validate` is behind the `manage`
 * grant, off for a paired phone by default.
 */
function checkFailure(err: unknown, mac: string): string {
  if (err instanceof ApiError && err.status === 403) {
    try {
      const body = JSON.parse(err.message) as { error?: unknown }
      if (body.error === 'not_granted') {
        return `${mac} does not let this phone check model IDs (Upkeep of this Mac, in its Settings → Devices).`
      }
    } catch {
      // Not the grant's refusal; said as it came.
    }
  }
  const message = err instanceof ApiError ? err.message || `HTTP ${err.status}` : err instanceof Error ? err.message : String(err)
  return `The ID could not be checked — ${humanizeError(message, mac).replace(/[.\s]+$/, '')}.`
}

/**
 * New session's MODEL on the phone (canvas 72d; spec
 * 2026-11-27-recent-model-cards-design § Phone): one row of cards that never
 * scrolls sideways — as many recent models as the width holds, then Other,
 * which opens the account's whole catalog and a custom ID in a bottom sheet.
 */
export function NewSessionModel({
  models,
  recent,
  value,
  preselected,
  defaultValue,
  lastLine,
  account,
  claudeDirId,
  machine,
  mac,
  onChange,
}: {
  models: OrbitalModel[]
  /** The account's models, newest first (`GET /api/models`); empty from an older Mac. */
  recent: string[]
  /** What the session launches with: a catalog `value` or a custom id. */
  value: string | null
  /** What the screen opens on (`preselectModel`): it always gets a card. */
  preselected: string | null
  /** The Mac's default model, marked DEFAULT. */
  defaultValue: string | null
  /** Canvas 72d's hint beside MODEL: `last used here: …`, or none. */
  lastLine?: string
  /** The Claude directory's name, for the sheet's head; null with one directory. */
  account: string | null
  claudeDirId: number | null
  machine: string | null
  mac: string
  onChange: (value: string) => void
}) {
  const { row, slots } = useCardSlots(models.length > 0)
  const [open, setOpen] = useState(false)
  // Inputs that tapping a card or the sheet never changes, so the set holds
  // still while the user taps within one visit.
  const cards = useMemo(
    () => recentModelCards({ models, recent, preselected, defaultValue, slots: slots - 1 }),
    [models, recent, preselected, defaultValue, slots],
  )

  if (models.length === 0) {
    return (
      <div className="flex flex-col gap-1.5">
        <FieldLabel>MODEL</FieldLabel>
        <p className="rounded-[12px] border border-line/18 bg-space/50 px-3.5 py-3 fs-11.5 leading-[1.4] text-ink-900/70">
          The model list could not be read. The session uses whatever model Claude Code is set to.
        </p>
      </div>
    )
  }

  const onCard = cards.some((c) => c.value === value)
  // Other holds whatever has no card: a model from the list, or a custom id.
  const holds = value !== null && !onCard
  const held = holds ? modelByValue(value, models) : undefined

  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel hint={lastLine}>MODEL</FieldLabel>
      <div
        ref={row}
        role="radiogroup"
        aria-label="Model"
        className="grid gap-2"
        style={{ gridTemplateColumns: `repeat(${cards.length + 1}, minmax(0, 1fr))` }}
      >
        {cards.map((m) => (
          <ModelCard
            key={m.value}
            name={m.shortVersion}
            meta={cardMeta(m, m.value === defaultValue)}
            selected={m.value === value}
            onClick={() => onChange(m.value)}
          />
        ))}
        <ModelCard
          other
          name={!holds ? 'Other' : held ? held.shortVersion : (value ?? '')}
          meta={!holds ? 'ALL MODELS' : held ? cardMeta(held, held.value === defaultValue) : 'CUSTOM ID'}
          selected={holds}
          opened={open}
          onClick={() => setOpen(true)}
        />
      </div>
      <SheetPresence>
        {open && (
          <ModelSheet
            models={models}
            cards={cards}
            value={value}
            defaultValue={defaultValue}
            account={account}
            claudeDirId={claudeDirId}
            machine={machine}
            mac={mac}
            onPick={(next) => {
              onChange(next)
              setOpen(false)
            }}
            onClose={() => setOpen(false)}
          />
        )}
      </SheetPresence>
    </div>
  )
}

/** Canvas 72d's card: 60 px tall, the name over one mono meta line, the dot in the corner when selected. */
function ModelCard({
  name,
  meta,
  selected,
  other = false,
  opened = false,
  onClick,
}: {
  name: string
  meta: string
  selected: boolean
  other?: boolean
  /** Other while its sheet is up: a fainter accent border, not the selection's. */
  opened?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      {...(other
        ? { 'aria-haspopup': 'dialog' as const, 'aria-expanded': opened, 'aria-pressed': selected, 'aria-label': `Other model: ${name}` }
        : { role: 'radio', 'aria-checked': selected })}
      title={name}
      onClick={onClick}
      className={[
        'relative h-15 min-w-0 rounded-[12px] border px-3 py-[11px] text-left text-ink-100',
        selected
          ? 'border-accent/70 bg-accent/8 shadow-[0_0_20px_color-mix(in_oklab,var(--color-accent)_15%,transparent)]'
          : opened
            ? 'border-accent/50 bg-space/40'
            : 'border-line/14 bg-space/40',
      ].join(' ')}
    >
      <span
        aria-hidden
        className={['absolute right-2.5 top-3 block h-[7px] w-[7px] rounded-full bg-accent', selected ? '' : 'opacity-0'].join(' ')}
      />
      <span className="block truncate pr-2.5 font-mono fs-12">{name}</span>
      <span
        className={[
          'mt-1.5 flex items-center gap-1 font-mono fs-9.5 tracking-[0.04em]',
          selected ? 'text-accent' : 'text-ink-900/50',
        ].join(' ')}
      >
        <span className="min-w-0 flex-1 truncate">{meta}</span>
        {other && (
          <span aria-hidden className="shrink-0 fs-9 text-ink-900/60">
            ▾
          </span>
        )}
      </span>
    </button>
  )
}

/**
 * Canvas 72d OTHER OPENS A SHEET, in the 50o / StopTask shell (the `device`
 * variant): the whole catalog in its own order, 46 px rows, Custom ID… last.
 */
function ModelSheet({
  models,
  cards,
  value,
  defaultValue,
  account,
  claudeDirId,
  machine,
  mac,
  onPick,
  onClose,
}: {
  models: OrbitalModel[]
  cards: OrbitalModel[]
  value: string | null
  defaultValue: string | null
  account: string | null
  claudeDirId: number | null
  machine: string | null
  mac: string
  onPick: (value: string) => void
  onClose: () => void
}) {
  const custom = value !== null && !modelByValue(value, models) ? value : null
  const [typing, setTyping] = useState(false)
  const [draft, setDraft] = useState('')
  const [checking, setChecking] = useState(false)
  const [line, setLine] = useState<string | null>(null)
  /** An id whose check could not run: Use again takes it unchecked, and Claude Code says at launch if it is wrong. */
  const [unchecked, setUnchecked] = useState<string | null>(null)
  /** Bumped by every edit and every check; an answer for an older one is dropped. */
  const seq = useRef(0)

  const edit = (text: string) => {
    seq.current += 1
    setDraft(text)
    setChecking(false)
    setLine(null)
    setUnchecked(null)
  }

  const use = async () => {
    const id = draft.trim()
    if (!id || checking) return
    // An id the catalog lists is a pick from the list, with nothing to check.
    if (modelByValue(id, models) || id === unchecked) return onPick(id)
    const mine = ++seq.current
    setChecking(true)
    setLine(null)
    try {
      const result = await api.validateModel(id, claudeDirId ?? undefined, machine ?? undefined)
      if (mine !== seq.current) return
      setChecking(false)
      if (result.ok) onPick(id)
      else setLine(result.reason)
    } catch (err) {
      if (mine !== seq.current) return
      setChecking(false)
      setUnchecked(id)
      setLine(`${checkFailure(err, mac)} Use it again to start with it unchecked.`)
    }
  }

  return (
    <BottomSheet label="Model" onDismiss={onClose} variant="device" swipeToDismiss>
      <div className="flex items-baseline gap-2.5 px-1 pb-2">
        <h2 className="fs-18 font-bold">Model</h2>
        <span className="min-w-0 truncate font-mono fs-10.5 text-ink-900/60">
          {account ? `${account} · all models` : 'all models'}
        </span>
      </div>
      <div role="listbox" aria-label="All models" data-sheet-scroll className="flex max-h-[470px] flex-col overflow-y-auto overscroll-contain">
        {models.map((m) => {
          const selected = m.value === value
          const mark = m.value === defaultValue ? 'DEFAULT' : cards.includes(m) ? 'ON A CARD' : ''
          return (
            <button
              key={m.value}
              type="button"
              role="option"
              aria-selected={selected}
              onClick={() => onPick(m.value)}
              className={[
                'flex h-[46px] shrink-0 items-center gap-2.5 border-b border-line/6 px-1.5 text-left text-ink-100',
                selected ? 'bg-line/8' : '',
              ].join(' ')}
            >
              <span className="min-w-0 truncate font-mono fs-13.5">{m.shortVersion}</span>
              <span className="shrink-0 font-mono fs-11 text-ink-900/60">{contextLabel(m) ?? ''}</span>
              <span className="flex-1" />
              <span className="shrink-0 font-mono fs-10 tracking-[0.08em] text-ink-900/45">{mark}</span>
              <span
                aria-hidden
                className={['block h-[7px] w-[7px] shrink-0 rounded-full bg-accent', selected ? '' : 'opacity-0'].join(' ')}
              />
            </button>
          )
        })}
      </div>
      {/* Canvas 72d: Custom ID… under a hairline, last, never scrolled away. */}
      <div className="mt-1 border-t border-line/12">
        {typing ? (
          // The field has no 72d frame; 72b's (TYPING A CUSTOM ID) at the row's mono size, 40 px for a finger.
          <form
            className="flex h-13 items-center gap-1.5 px-0.5"
            onSubmit={(e) => {
              e.preventDefault()
              void use()
            }}
          >
            <input
              autoFocus
              aria-label="Custom model ID"
              placeholder="model ID"
              value={draft}
              onChange={(e) => edit(e.target.value)}
              enterKeyHint="done"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="h-10 min-w-0 flex-1 rounded-[7px] border border-accent/50 bg-space/60 px-2.5 font-mono fs-13 text-ink-100 shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-accent)_10%,transparent)] outline-none placeholder:text-ink-900/60"
            />
            <button
              type="submit"
              disabled={!draft.trim() || checking}
              className="h-10 shrink-0 rounded-[7px] border border-line/18 px-3 fs-12 font-semibold text-ink-100 disabled:opacity-40"
            >
              {checking ? 'Checking…' : 'Use'}
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => {
              edit(custom ?? '')
              setTyping(true)
            }}
            className={['flex h-13 w-full items-center gap-2.5 px-1.5 text-left', custom ? 'bg-line/8' : ''].join(' ')}
          >
            <span className={['min-w-0 flex-1 truncate font-mono fs-13', custom ? 'text-ink-100' : 'text-ink-500/85'].join(' ')}>
              {custom ?? 'Custom ID…'}
            </span>
            <span className="shrink-0 font-mono fs-10 tracking-[0.1em] text-ink-900/45">ANY ID ›</span>
          </button>
        )}
        {line && (
          <p role="status" className="px-1.5 pb-1 font-mono fs-11 leading-[1.4] text-ink-900/70 [overflow-wrap:anywhere]">
            {line}
          </p>
        )}
      </div>
    </BottomSheet>
  )
}
