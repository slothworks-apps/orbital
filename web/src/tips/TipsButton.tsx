import { useEffect, useRef, useState } from 'react'
import { useOrbital } from '../store/store'
import { useEscapeLayer } from '../ui/escapeLayer'
import { Button } from '../ui/Button'
import { isTypingTarget } from '../lib/keymap'
import { nextTipIndex, previousTipIndex, tipOrder, tipPosition, type Tip } from '../lib/tips'
import { TIPS } from './tipList'
import { markTipsSeen, runTipAction, useSeenTips } from './useTips'

/**
 * The bulb (canvas `Feature - Tips` 68b THE GLYPH): a ring and two short
 * bars, 12 × 15, drawn in `currentColor` like the strip's icons.
 */
export function BulbGlyph() {
  return (
    <span aria-hidden className="relative block h-[15px] w-3">
      <span className="absolute left-px top-0 box-border h-2.5 w-2.5 rounded-full border-[1.5px] border-current" />
      <span className="absolute left-[3.5px] top-[11.2px] h-[1.5px] w-[5px] rounded-[1px] bg-current" />
      <span className="absolute left-[4.25px] top-[13.5px] h-[1.5px] w-[3.5px] rounded-[1px] bg-current" />
    </span>
  )
}

/**
 * The map column's 34px shell, shared by the bulb and the error log's `!`
 * (canvas 5a/5c, 68b): pressed while what it opens is open — accent frame and
 * ring — else the hairline that lights on hover.
 */
export function columnButtonClass(pressed: boolean, lit: boolean): string {
  return [
    'relative grid h-[34px] w-[34px] place-items-center rounded-[9px] border bg-panel/92 transition-colors',
    pressed
      ? 'border-accent/50 text-ink-100 shadow-[0_0_0_3px_color-mix(in_oklab,_var(--color-accent)_10%,_transparent)]'
      : [
          'border-line/16 hover:border-line/30 hover:bg-line/10 hover:text-ink-50',
          lit ? 'text-ink-100' : 'text-ink-500/60',
        ].join(' '),
  ].join(' ')
}

/**
 * The rest of the column while the error log or All tips is open (68b WITH
 * THE ERROR LOG): at half strength, all but the button that opened it.
 */
export function useColumnDim(): { tips: boolean; errors: boolean; zoom: boolean } {
  const dialog = useOrbital((s) => s.ui.dialog)
  const open = dialog === 'errors' || dialog === 'tips'
  return { tips: open && dialog !== 'tips', errors: open && dialog !== 'errors', zoom: open }
}

/** One open of the card: the order it offers and which of them were new when it opened. */
interface CardRun {
  order: Tip[]
  fresh: ReadonlySet<string>
  index: number
}

/**
 * The tips button at the top of the map's zoom column, above the error log
 * (spec 2026-11-16-tips-design § The button; canvas 68a, 68b), and the
 * one-tip card it opens beside the column (68c). Muted at rest; full ink and
 * the accent dot while a tip has not been shown on this Mac. It never opens by
 * itself.
 */
export function TipsButton({ dim }: { dim: boolean }) {
  const { seen, dot } = useSeenTips()
  const dialog = useOrbital((s) => s.ui.dialog)
  const setDialog = useOrbital((s) => s.setDialog)
  const [run, setRun] = useState<CardRun | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const close = () => setRun(null)
  const shown = run ? run.order[run.index] : null

  // A tip counts as seen the moment it is on the card.
  useEffect(() => {
    if (shown) markTipsSeen([shown.id])
  }, [shown])

  // One thing open at a time: a dialog opening (the error log by its
  // shortcut, All tips from the card) closes the card.
  useEffect(() => {
    if (dialog !== null) setRun(null)
  }, [dialog])

  useEscapeLayer(run !== null, close)

  // `pointerdown`, like `Menu`: the map click that closes the card still
  // reaches the map. The bulb itself toggles, so it is left out.
  useEffect(() => {
    if (!run) return
    const onPointerDown = (e: PointerEvent) => {
      if (e.target instanceof Node && wrapRef.current?.contains(e.target)) return
      setRun(null)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [run])

  // 68c ORDER: → does what Next does, ← goes back. Not while typing.
  useEffect(() => {
    if (!run) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
      e.preventDefault()
      setRun((r) =>
        r && {
          ...r,
          index: e.key === 'ArrowRight' ? nextTipIndex(r.index, r.order.length) : previousTipIndex(r.index, r.order.length),
        },
      )
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [run])

  const toggle = () => {
    if (run) {
      setRun(null)
      return
    }
    if (dialog === 'errors' || dialog === 'tips') setDialog(null)
    const fresh = new Set(TIPS.filter((tip) => !seen.has(tip.id)).map((tip) => tip.id))
    setRun({ order: tipOrder(TIPS, seen), fresh, index: 0 })
  }

  const pressed = run !== null || dialog === 'tips'

  return (
    <div ref={wrapRef} className={['relative transition-opacity', dim ? 'opacity-50' : ''].join(' ')}>
      <button
        type="button"
        aria-label={dot ? 'Tips — new tips' : 'Tips'}
        aria-expanded={pressed}
        title="Tips"
        onClick={toggle}
        className={columnButtonClass(pressed, dot)}
      >
        <BulbGlyph />
      </button>
      {/* 68b SOMETHING NEW: a 7px accent dot at the corner — no number, no motion. */}
      {dot && (
        <span
          aria-hidden
          className="pointer-events-none absolute -right-[3px] -top-[3px] box-border h-[9px] w-[9px] rounded-full border border-space/90 bg-accent"
        />
      )}
      {run && shown && (
        <TipCard
          tip={shown}
          isNew={run.fresh.has(shown.id)}
          position={tipPosition(run.index, run.order.length)}
          onClose={close}
          onNext={() => setRun((r) => r && { ...r, index: nextTipIndex(r.index, r.order.length) })}
          onAll={() => setDialog('tips')}
          onAction={() => {
            close()
            if (shown.action) runTipAction(shown.action)
          }}
        />
      )}
    </div>
  )
}

/**
 * One tip (canvas 68c): 340px, bottom-aligned with the bulb and 10px to the
 * left of the column, so it follows the column when the session panel moves
 * it (68a). TIP, NEW while it had not been seen, the counter, ×; one or two
 * sentences; the outlined action; All tips and Next. Nothing animates: Next
 * replaces the text in place.
 */
function TipCard(props: {
  tip: Tip
  isNew: boolean
  position: string
  onClose: () => void
  onNext: () => void
  onAll: () => void
  onAction: () => void
}) {
  const { tip } = props
  return (
    <div
      role="dialog"
      aria-label="Tip"
      className="absolute bottom-0 right-[calc(100%+10px)] box-border flex w-[340px] flex-col rounded-xl border border-line/18 bg-panel/96 text-ink-100 shadow-[0_18px_50px_color-mix(in_oklab,_var(--color-shadow)_60%,_transparent)] backdrop-blur-[20px]"
    >
      <div className="flex items-center gap-2 pl-4 pr-2.5 pt-3 font-mono fs-9.5 tracking-[0.18em] text-ink-900/60">
        <span className="flex text-ink-500/75">
          <BulbGlyph />
        </span>
        TIP
        {props.isNew && (
          <span className="flex items-center gap-[5px] tracking-[0.1em] text-ink-400/80">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent" />
            NEW
          </span>
        )}
        <span className="flex-1" />
        <span className="tracking-[0.04em]">{props.position}</span>
        <button
          type="button"
          aria-label="Close tips"
          onClick={props.onClose}
          className="ml-0.5 grid h-6 w-6 place-items-center rounded-md text-ink-500/70 hover:bg-line/9 hover:text-ink-100"
        >
          <span aria-hidden className="relative block h-[9px] w-[9px]">
            <span className="absolute left-1/2 top-0 -ml-[0.7px] h-full w-[1.4px] rotate-45 rounded-[1px] bg-current" />
            <span className="absolute left-1/2 top-0 -ml-[0.7px] h-full w-[1.4px] -rotate-45 rounded-[1px] bg-current" />
          </span>
        </button>
      </div>
      <p className="m-0 px-4 pt-2 fs-14 leading-[1.55] text-pretty text-ink-100/95">
        {tip.text}
      </p>
      {tip.action && (
        <div className="px-4 pt-3">
          {/* 68c THE ACTION: outlined, never the accent fill. */}
          <Button variant="outline" size="labs" onClick={props.onAction}>
            <span className="inline-flex items-center gap-2 text-left">
              {tip.action.label}
              <span aria-hidden className="text-ink-900/60">
                →
              </span>
            </span>
          </Button>
        </div>
      )}
      <div className="mt-3.5 flex items-center gap-2 border-t border-line/8 py-[9px] pl-4 pr-2.5">
        <button type="button" onClick={props.onAll} className="font-mono fs-10.5 text-sky hover:text-sky-soft">
          All tips
        </button>
        <span className="flex-1" />
        <span aria-hidden className="font-mono fs-10 text-ink-900/45">
          →
        </span>
        <Button variant="outline" size="check" onClick={props.onNext}>
          Next
        </Button>
      </div>
    </div>
  )
}
