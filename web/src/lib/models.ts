import { formatTokens } from './format'
import type { ApiSession, OrbitalModel } from './types'

/** Drops a trailing variant suffix: `claude-opus-5[1m]` -> `claude-opus-5`. */
function stripVariant(id: string): string {
  return id.replace(/\[[^\]]*]$/, '')
}

export function modelByValue(value: string | null | undefined, models: OrbitalModel[]): OrbitalModel | undefined {
  if (!value) return undefined
  return models.find((m) => m.value === value)
}

/**
 * The catalog row for an id that might be EITHER an SDK `value` (`opus[1m]`,
 * what Orbital itself launched with) OR a resolved model id (`claude-opus-5`,
 * all a terminal-launched session ever has). Tries a `value` match first,
 * then the naming-only resolved-model match: exact, then with a trailing
 * `[…]` stripped from both sides, because the transcript records
 * `claude-opus-5` even for a session launched as `opus[1m]`.
 *
 * Shared by `modelNameForId` (name a raw resolved id) and the New session
 * dialog's "last used here" (a project's newest session may have no `value`
 * at all) — one lookup rather than two that could drift apart.
 */
export function modelByAnyId(id: string | null | undefined, models: OrbitalModel[]): OrbitalModel | undefined {
  if (!id) return undefined
  return (
    modelByValue(id, models) ??
    models.find((m) => m.resolvedModel === id) ??
    models.find((m) => stripVariant(m.resolvedModel) === stripVariant(id))
  )
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
 * Names a raw resolved model id for display — `claude-opus-5` -> `Opus 5`.
 *
 * Uses `modelByAnyId`'s resolved-model matching (exact, then with a trailing
 * `[…]` stripped from both sides), because a transcript records
 * `claude-opus-5` even for a session launched as `opus[1m]`. Falls back to the
 * id itself: an unknown model should read as something rather than vanish.
 */
export function modelNameForId(resolvedId: string, models: OrbitalModel[]): string {
  return modelByAnyId(resolvedId, models)?.shortVersion ?? resolvedId
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
 * Whether `matchModel`'s row for this session is an EXACT one — matched by
 * the session's own requested value, or by an exact resolved-model id — as
 * opposed to the naming-only variant-stripped fallback.
 *
 * The stripped fallback exists so a terminal session has a name at all; it
 * does not tell us the variant actually running. Appending one anyway would
 * have the chip claim a context size (`(1M)`) the read-out beside it cannot
 * back up, which is the one thing `docs/decisions/models-come-from-the-sdk.md`
 * says this feature must never do.
 */
export function isExactModelMatch(session: ApiSession, model: OrbitalModel): boolean {
  return model.value === session.model || model.resolvedModel === session.resolvedModel
}


/**
 * What a model switch costs, as the confirm before it says it — the desktop's
 * `SwitchDialog` and the phone's model sheet
 * (docs/decisions/a-model-switch-always-asks.md). `name` is the model switched to.
 */
export function modelSwitchCost(name: string, contextTokens: number | null | undefined): string {
  const amount = contextTokens ? `all ${formatTokens(contextTokens)} tokens of it` : 'all of it'
  return (
    `The conversation is kept, but ${name} reads it from scratch on your next message — ${amount}. ` +
    'The cache that makes a turn cheap belongs to the current model, so that turn uses noticeably more of your limit than usual.'
  )
}

/**
 * What a session's model reads as in a header — the desktop's model chip
 * (`ModelSwitcher`) and the phone's 9b. The variant only belongs on the label
 * when the match is exact (F2): the stripped-suffix fallback exists so a
 * terminal session has a name at all, and letting it also claim a variant
 * would promise a context size nothing can back up.
 */
export function sessionModelLabel(session: ApiSession, models: OrbitalModel[]): string {
  const current = matchModel(session, models)
  if (current) return isExactModelMatch(session, current) ? modelChipLabel(current) : current.shortVersion
  return session.resolvedModel ?? session.model ?? 'unknown model'
}

/**
 * Tokens the context bar is drawn against, or `null` when we do not
 * genuinely know. Matches by requested value or by EXACT resolved model
 * only: `claude-opus-5` must not inherit `claude-opus-5[1m]`'s 1M, because
 * that would draw a full 200k session at 20%.
 *
 * Deliberately does NOT fall back to a stripped-id match the way the
 * server's seed does (`server/src/models/catalog.ts`) — that stripping is
 * the server's, made once, against a documented table it owns. Doing it
 * again here on the client would let an inexact match silently disagree
 * with the row's own `contextWindow`, so an unmatched session stays
 * unknown rather than guessing. When null, the caller draws no bar at all
 * (per `docs/decisions/models-come-from-the-sdk.md`) rather than inventing
 * a number.
 *
 * `learned` is the server's measured wire-id → window map, tried by EXACT
 * resolved id when no catalog row matches. It exists because a session can
 * resolve to an id no row carries at all — a revived terminal session's
 * init reports `claude-fable-5` while the catalog's Fable row says
 * `claude-fable-5-1` — and the measured map is then the only honest
 * denominator (fix: revived-session-shows-no-context-gauge). Still an
 * exact match of a measured value, so the ADR's "no invented denominator"
 * holds.
 */
export function contextWindowFor(
  session: ApiSession,
  models: OrbitalModel[],
  learned: Record<string, number> = {}
): number | null {
  const exact =
    modelByValue(session.model, models) ??
    (session.resolvedModel ? models.find((m) => m.resolvedModel === session.resolvedModel) : undefined)
  return exact?.contextWindow ?? (session.resolvedModel ? (learned[session.resolvedModel] ?? null) : null)
}

/** The narrowest a model card gets (canvas 72c). */
export const MODEL_CARD_MIN_PX = 96
/** The gap between model cards (canvas 72c). */
export const MODEL_CARD_GAP_PX = 8

/**
 * How many cards a row of `width` px holds, Other included: as many
 * `MODEL_CARD_MIN_PX` cards as fit with `MODEL_CARD_GAP_PX` between them,
 * never fewer than two (canvas 72c: ⌊(column + 8) / 104⌋).
 */
export function modelCardSlots(width: number): number {
  return Math.max(2, Math.floor((width + MODEL_CARD_GAP_PX) / (MODEL_CARD_MIN_PX + MODEL_CARD_GAP_PX)))
}

/**
 * The models that get a card of their own in front of Other — spec
 * 2026-11-27-recent-model-cards-design § Which models are recent.
 *
 * `recent` is the account's history, newest first, as `GET /api/models`
 * gives it: requested values or resolved ids, so each is matched with
 * `modelByAnyId`. An id the catalog no longer lists gets no card. Free
 * slots fill with the default, then the catalog's own order — which is all
 * there is with no history. The `preselected` model always has a card: one
 * that would not make the cut takes the last slot.
 */
export function recentModelCards({
  models,
  recent,
  preselected,
  defaultValue,
  slots,
}: {
  models: OrbitalModel[]
  recent: string[]
  preselected: string | null
  defaultValue: string | null
  /** Cards in front of Other. */
  slots: number
}): OrbitalModel[] {
  const picked: OrbitalModel[] = []
  const add = (row: OrbitalModel | undefined) => {
    if (row && !picked.includes(row)) picked.push(row)
  }
  for (const id of recent) add(modelByAnyId(id, models))
  add(modelByValue(defaultValue, models))
  for (const row of models) add(row)
  const cards = picked.slice(0, Math.max(0, slots))
  const pre = modelByAnyId(preselected, models)
  if (pre && cards.length > 0 && !cards.includes(pre)) cards[cards.length - 1] = pre
  return cards
}
