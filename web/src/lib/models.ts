import type { ApiSession, OrbitalModel } from './types'

/**
 * Denominator for the context bar when nothing in the catalog matches. The
 * smallest window any current model has — so an unknown model's bar can read
 * as fuller than it is, never as emptier.
 */
export const DEFAULT_CONTEXT_WINDOW = 200_000

/** Drops a trailing variant suffix: `claude-opus-5[1m]` -> `claude-opus-5`. */
function stripVariant(id: string): string {
  return id.replace(/\[[^\]]*\]$/, '')
}

export function modelByValue(value: string | null | undefined, models: OrbitalModel[]): OrbitalModel | undefined {
  if (!value) return undefined
  return models.find((m) => m.value === value)
}

/**
 * The name for the detail chip and the switcher rows — `Opus 5 (1M)`.
 *
 * The chip is the only place with no room for a separate context line, so it
 * is the only place that spells the variant out. Cards say `Opus 5` and put
 * the size on their own `1M CTX` line instead.
 */
export function modelChipLabel(model: OrbitalModel): string {
  return model.variant ? `${model.shortVersion} (${model.variant})` : model.shortVersion
}

/**
 * The catalog row a session should be LABELLED with.
 *
 * The suffix-stripping third pass exists because the transcript records
 * `claude-opus-5` even for a session launched as `opus[1m]`, so a terminal
 * session would otherwise have no name at all. It is only ever used for
 * naming — `contextWindowFor` deliberately does not reuse it.
 */
export function matchModel(session: ApiSession, models: OrbitalModel[]): OrbitalModel | undefined {
  const byValue = modelByValue(session.model, models)
  if (byValue) return byValue
  const resolved = session.resolvedModel
  if (!resolved) return undefined
  return (
    models.find((m) => m.resolvedModel === resolved) ??
    models.find((m) => stripVariant(m.resolvedModel) === stripVariant(resolved))
  )
}

/**
 * Tokens the context bar is drawn against. Matches by requested value or by
 * EXACT resolved model only: `claude-opus-5` must not inherit
 * `claude-opus-5[1m]`'s 1M, because that would draw a full 200k session at
 * 20%. When in doubt, the honest 200k fallback.
 */
export function contextWindowFor(session: ApiSession, models: OrbitalModel[]): number {
  const exact =
    modelByValue(session.model, models) ??
    (session.resolvedModel ? models.find((m) => m.resolvedModel === session.resolvedModel) : undefined)
  return exact?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
}
