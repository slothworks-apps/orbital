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
 */
export function ModelCards({
  models,
  value,
  onChange,
  defaultValue = null,
  disabled = false,
  compact = false,
}: ModelCardsProps) {
  if (models.length === 0) {
    return (
      <p className="rounded-[10px] border border-panel-border bg-[rgba(4,8,16,.4)] px-3.5 py-3 text-[11.5px] leading-[1.4] text-[rgba(160,190,225,.7)]">
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
      style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${compact ? 120 : 150}px, 1fr))` }}
    >
      {models.map((model) => {
        const active = value === model.value
        const isDefault = !active && defaultValue === model.value
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
            className={[
              'relative min-w-0 text-left transition-colors',
              'disabled:cursor-not-allowed disabled:opacity-40',
              compact ? 'rounded-[9px] border px-3 py-2.5' : 'rounded-[10px] border px-3.5 py-3',
              active
                ? compact
                  ? 'border-accent/70 bg-accent/8'
                  : 'border-accent/70 bg-accent/8 shadow-[0_0_20px_rgba(89,228,243,.15)]'
                : 'border-panel-border bg-[rgba(4,8,16,.4)] hover:bg-white/5',
            ].join(' ')}
          >
            {active && !compact && (
              <span
                aria-hidden
                className="absolute right-2.5 top-2.5 h-[7px] w-[7px] rounded-full bg-accent shadow-[0_0_8px_rgba(89,228,243,1)]"
              />
            )}
            <span
              className={[
                'block truncate font-mono text-text-bright',
                compact ? 'text-[11.5px]' : 'text-xs',
              ].join(' ')}
            >
              {model.shortVersion}
            </span>
            {compact
              ? model.contextWindow !== null && (
                  <span className="mt-1 block text-[11px] leading-[1.4] text-[rgba(160,190,225,.7)]">
                    {formatContextWindow(model.contextWindow)} ctx
                  </span>
                )
              : (
                  <span
                    className={[
                      'mt-[5px] block text-[11.5px] leading-[1.4] [text-wrap:pretty]',
                      active ? 'text-[rgba(200,220,245,.85)]' : 'text-[rgba(160,190,225,.7)]',
                    ].join(' ')}
                  >
                    {model.blurb}
                  </span>
                )}
            {!compact && (model.contextWindow !== null || isDefault) && (
              <span
                className={[
                  'mt-2 flex items-center gap-2 font-mono text-[9.5px] tracking-[0.1em]',
                  active ? 'text-accent' : 'text-[rgba(160,190,225,.5)]',
                ].join(' ')}
              >
                {isDefault && <span>DEFAULT</span>}
                {model.contextWindow !== null && (
                  <span>{formatContextWindow(model.contextWindow).toUpperCase()} CTX</span>
                )}
              </span>
            )}
            {compact && isDefault && (
              <span className="mt-1 block font-mono text-[9.5px] tracking-[0.1em] text-[rgba(160,190,225,.5)]">
                DEFAULT
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
