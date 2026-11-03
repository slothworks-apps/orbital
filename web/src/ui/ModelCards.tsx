import { formatContextWindow } from '../lib/format'
import type { OrbitalModel } from '../lib/types'

export interface ModelCardsProps {
  models: OrbitalModel[]
  /** SDK `value` of the selected model, or null when nothing is chosen yet. */
  value: string | null
  onChange: (value: string) => void
  /** SDK `value` of the Settings default — marked `DEFAULT` when it is not the selection. */
  defaultValue?: string | null
  disabled?: boolean
  /** Settings variant (canvas 4c): short version + context line, no blurb. */
  compact?: boolean
  /**
   * New session's column variant (canvas 63a): four to a row in half the
   * dialog — the short version over one mono meta line (`DEFAULT · 200K CTX`),
   * 10px by 8px inside a 10px radius, the selection still glowing with its pip.
   */
  dense?: boolean
  /**
   * Appends an `Other` card for a model id the catalog does not list. While
   * it is active no catalog card is, whatever `value` says.
   */
  other?: { active: boolean; onSelect: () => void }
}

const OTHER_BLURB = 'Any model id Claude Code accepts'

function cardClassName(active: boolean, compact: boolean, dense = false): string {
  return [
    'relative min-w-0 text-left transition-colors',
    'disabled:cursor-not-allowed disabled:opacity-40',
    // canvas 4c: padding 10px 12px on a 9px radius. canvas 4b: padding 12px 14px on a 10px radius.
    // canvas 63a: 10px down, 10px radius — but 8px across, not the canvas's 10: the
    // app's mono runs wider than the canvas's, and at four cards to a half-width
    // column a name like "Sonnet 5.5" would be cut off with 10.
    dense ? 'rounded-[10px] border px-2 py-2.5' : compact ? 'rounded-[9px] border px-3 py-2.5' : 'rounded-[10px] border px-3.5 py-3',
    active
      ? compact
        ? // canvas 4c selected: border .7 / bg .08, no glow, no dot.
          'border-accent/70 bg-accent/8'
        : // canvas 4b selected: border .7 / bg .08, plus a 20px .15-alpha glow.
          'border-accent/70 bg-accent/8 shadow-[0_0_20px_color-mix(in_oklab,_var(--color-accent)_15%,_transparent)]'
      : 'border-line/14 bg-space/40 hover:bg-ink-50/5',
  ].join(' ')
}

/**
 * canvas 4b: 7px accent dot with a glow, 10px inset from the corner. `meta`
 * is the dense card's (63a): at the end of the meta line, 8px in, since the
 * name needs the whole first row.
 */
function ActiveDot({ position = 'corner' }: { position?: 'corner' | 'meta' }) {
  return (
    <span
      aria-hidden
      className={[
        'absolute h-[7px] w-[7px] rounded-full bg-accent shadow-[0_0_8px_var(--color-accent)]',
        position === 'meta' ? 'bottom-[13px] right-2' : 'right-2.5 top-2.5',
      ].join(' ')}
    />
  )
}

/** The dense card's mono meta line (63a: `DEFAULT · 200K CTX`), accent on the selected card. */
function metaLineClassName(active: boolean): string {
  return ['mt-[5px] block truncate font-mono fs-9.5 tracking-[0.08em]', active ? 'text-accent' : 'text-ink-900/50'].join(' ')
}

function cardTitleClassName(compact: boolean): string {
  return ['block truncate font-mono text-ink-100', compact ? 'fs-11.5' : 'fs-12 leading-(--text-xs--line-height)'].join(' ')
}

function blurbClassName(active: boolean): string {
  // canvas 4b body: 5px top margin.
  return [
    'mt-[5px] block fs-11.5 leading-[1.4] [text-wrap:pretty]',
    active ? 'text-ink-500/85' : 'text-ink-900/70',
  ].join(' ')
}

/**
 * Selectable model cards, shared between `NewSessionDialog` (canvas 4b) and
 * `Settings` (4c) — the same "build it once" arrangement `ui/ModeCards.tsx`
 * uses for permission modes.
 *
 * The grid is `auto-fit`, not the canvas's fixed four columns: the list comes
 * from the SDK, so a fifth model must wrap rather than overflow.
 *
 * 4b's `SLOWEST · $$$$` line is replaced by the context window. `ModelInfo`
 * carries no price or speed, and a hand-maintained table of either would be
 * wrong within weeks — see `docs/decisions/models-come-from-the-sdk.md`.
 *
 * 4c lays its compact row out as `display:flex;gap:8px` with each card
 * `flex:1`, which assumes exactly four cards. Ours stays the same
 * `auto-fit`/`minmax` grid as the full variant instead of switching to flex:
 * with a dynamic model list, `flex:1` would squeeze every card narrower to
 * fit the 320px settings column rather than wrapping — the same overflow
 * the 4b grid departure above already exists to avoid.
 */
export function ModelCards({
  models,
  value,
  onChange,
  defaultValue = null,
  disabled = false,
  compact = false,
  dense = false,
  other,
}: ModelCardsProps) {
  if (models.length === 0) {
    return (
      <p className="rounded-[10px] border border-line/14 bg-space/40 px-3.5 py-3 fs-11.5 leading-[1.4] text-ink-900/70">
        The model list could not be read from Claude Code. Sessions still launch — they use whatever
        model Claude Code is configured with.
      </p>
    )
  }

  return (
    <div
      role="radiogroup"
      aria-label="Model"
      className="grid w-full gap-2"
      style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${dense ? 90 : compact ? 120 : 150}px, 1fr))` }}
    >
      {models.map((model) => {
        const active = !other?.active && value === model.value
        const isDefault = !active && defaultValue === model.value
        if (dense) {
          // 63a: `DEFAULT · $$` under the name; ours carries the context window for the price.
          const meta = [
            defaultValue === model.value ? 'DEFAULT' : null,
            model.contextWindow !== null ? `${formatContextWindow(model.contextWindow).toUpperCase()} CTX` : null,
          ].filter(Boolean)
          return (
            <button
              key={model.value}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={model.shortVersion}
              title={model.blurb}
              data-active={active}
              data-model={model.value}
              disabled={disabled}
              onClick={() => onChange(model.value)}
              className={cardClassName(active, false, true)}
            >
              {/* 63a draws the pip top right, beside the name. The app's mono runs wider
                  than the canvas's, so a name like "Sonnet 5.5" needs the whole row:
                  the pip sits at the end of the second line instead. */}
              {active && <ActiveDot position="meta" />}
              <span className="block truncate font-mono fs-11 text-ink-100">{model.shortVersion}</span>
              <span className={`${metaLineClassName(active)} ${active ? 'pr-3' : ''}`}>
                {meta.length > 0 ? meta.join(' · ') : '\u00a0'}
              </span>
            </button>
          )
        }
        return (
          <button
            key={model.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={model.shortVersion}
            data-active={active}
            data-model={model.value}
            disabled={disabled}
            onClick={() => onChange(model.value)}
            className={cardClassName(active, compact)}
          >
            {active && !compact && <ActiveDot />}
            <span className={cardTitleClassName(compact)}>{model.shortVersion}</span>
            {compact
              ? model.contextWindow !== null && (
                  <span className="mt-1 block fs-11 leading-[1.4] text-ink-900/70">
                    {formatContextWindow(model.contextWindow)} ctx
                  </span>
                )
              : <span className={blurbClassName(active)}>{model.blurb}</span>}
            {!compact && (model.contextWindow !== null || isDefault) && (
              // canvas 4b meta line: 8px top margin, 9.5px mono, .1em tracking.
              <span
                className={[
                  'mt-2 flex items-center gap-2 font-mono fs-9.5 tracking-[0.1em]',
                  active ? 'text-accent' : 'text-ink-900/50',
                ].join(' ')}
              >
                {isDefault && <span>DEFAULT</span>}
                {model.contextWindow !== null && (
                  <span>{formatContextWindow(model.contextWindow).toUpperCase()} CTX</span>
                )}
              </span>
            )}
            {compact && isDefault && (
              <span className="mt-1 block font-mono fs-9.5 tracking-[0.1em] text-ink-900/50">
                DEFAULT
              </span>
            )}
          </button>
        )
      })}
      {other && (
        <button
          type="button"
          role="radio"
          aria-checked={other.active}
          aria-label="Other"
          data-active={other.active}
          disabled={disabled}
          onClick={other.onSelect}
          title={dense ? OTHER_BLURB : undefined}
          className={cardClassName(other.active, compact, dense)}
        >
          {other.active && !compact && <ActiveDot />}
          <span className={dense ? 'block truncate pr-3 font-mono fs-11.5 text-ink-100' : cardTitleClassName(compact)}>Other</span>
          {dense && <span className={metaLineClassName(other.active)}>ANY ID</span>}
          {!compact && !dense && <span className={blurbClassName(other.active)}>{OTHER_BLURB}</span>}
        </button>
      )}
    </div>
  )
}
