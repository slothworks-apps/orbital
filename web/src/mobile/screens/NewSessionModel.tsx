import { useMemo, useState } from 'react'
import { ApiError } from '../../lib/api'
import { useCustomModel } from '../../lib/customModel'
import { modelByValue, recentModelCards } from '../../lib/models'
import type { OrbitalModel } from '../../lib/types'
import { CustomModelListField } from '../../ui/CustomModelField'
import { ModelsUnread, cardMetaLabel, contextLabel } from '../../ui/ModelCards'
import { RowCard } from '../../ui/ModelRow'
import { useCardSlots } from '../../ui/useCardSlots'
import { humanizeError } from '../composer'
import { BottomSheet, FieldLabel, SheetPresence } from '../ui'

/**
 * The row's width before it is measured (and in jsdom, which measures
 * nothing): canvas 72d's 390 px screen less its 16 px sides.
 */
const UNMEASURED_ROW_PX = 358

/** A grant of Settings → Devices, as its switch there names it. */
const GRANT_NAMES: Record<string, string> = { spawn: 'Start sessions', manage: 'Upkeep of this Mac' }

/**
 * Why a custom id could not be checked — the check never ran, so it says
 * nothing about the id. `POST /api/models/validate` is behind the `spawn`
 * grant this screen already needs; a Mac older than the recent-model cards
 * keeps it behind `manage`, off for a paired phone by default. The refusal
 * names the grant it wants, so the line names that one.
 */
function checkFailure(err: unknown, mac: string): string {
  if (err instanceof ApiError && err.status === 403) {
    try {
      const body = JSON.parse(err.message) as { error?: unknown; grant?: unknown }
      if (body.error === 'not_granted') {
        const grant = typeof body.grant === 'string' ? GRANT_NAMES[body.grant] : undefined
        return grant
          ? `${mac} does not let this phone check model IDs (${grant}, in its Settings → Devices).`
          : `${mac} does not let this phone check model IDs (in its Settings → Devices).`
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
  const { ref: row, slots } = useCardSlots(models.length > 0, UNMEASURED_ROW_PX)
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
        <ModelsUnread />
      </div>
    )
  }

  const onCard = cards.some((c) => c.value === value)
  // Other holds whatever has no card: a model from the list, or a custom id.
  const holds = value !== null && !onCard
  const held = holds ? modelByValue(value, models) : undefined
  const otherName = !holds ? 'Other' : held ? held.shortVersion : (value ?? '')

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
          <RowCard
            key={m.value}
            size="touch"
            name={m.shortVersion}
            sub={cardMetaLabel(m, defaultValue)}
            title={m.shortVersion}
            on={m.value === value}
            dataModel={m.value}
            onClick={() => onChange(m.value)}
          />
        ))}
        <RowCard
          size="touch"
          radio={false}
          name={otherName}
          sub={!holds ? 'ALL MODELS' : held ? cardMetaLabel(held, defaultValue) : 'CUSTOM ID'}
          title={otherName}
          ariaLabel={`Other model: ${otherName}`}
          on={holds}
          lit={open}
          caret="down"
          aria={{ 'aria-haspopup': 'dialog', 'aria-expanded': open, 'aria-pressed': holds }}
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
  // A check still out when the sheet closes never lands: dropped on every
  // way out, since the sheet stays mounted while it slides away.
  const field = useCustomModel({
    onValidated: (id) => onPick(id),
    onCleared: () => {},
    claudeDir: claudeDirId ?? undefined,
    machine: machine ?? undefined,
    describeFailure: (err) => `${checkFailure(err, mac)} Use it again to start with it unchecked.`,
  })

  const use = () => {
    const id = field.text.trim()
    if (!id || field.status === 'checking') return
    // An id the catalog lists is a pick from the list, with nothing to check;
    // one already taken is taken again; one whose check could not run is
    // taken unchecked on the second Use, and Claude Code says at launch if it is wrong.
    if (modelByValue(id, models) || field.status === 'valid' || field.checkFailed) return pick(id)
    void field.validate()
  }
  const pick = (next: string) => {
    field.cancel()
    onPick(next)
  }
  const dismiss = () => {
    field.cancel()
    onClose()
  }

  return (
    <BottomSheet label="Model" onDismiss={dismiss} variant="device" swipeToDismiss>
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
              onClick={() => pick(m.value)}
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
          <CustomModelListField field={field} onTake={use} autoFocus touch />
        ) : (
          <button
            type="button"
            onClick={() => {
              field.seed(custom ?? '', custom !== null)
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
      </div>
    </BottomSheet>
  )
}
