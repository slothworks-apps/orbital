/**
 * Settings → Mobile's pure derivations (spec 2026-10-01-settings-mobile-design
 * §§ 3, 6): the relay status line, the pairing code's countdown and what
 * committing a relay URL or a relay secret has to do.
 */
import type { RemoteStatus } from './types'

/**
 * Failed attempts before "connecting" turns into "can't reach". Below it, the
 * first retry still reads as connecting: one dropped socket that comes
 * straight back must not flash a failure.
 */
export const RELAY_UNREACHABLE_AFTER_ATTEMPTS = 2

/**
 * How long a pairing code is open, for the draining bar's full length.
 * Mirrors `PAIRING_TOKEN_TTL_MS` in `shared/src/remote/relayApi.ts`, which the
 * web does not import (it would pull the crypto in with it).
 */
export const PAIRING_WINDOW_MS = 120_000

/** How long Settings → Mobile's "Try again" waits for the relay to answer (canvas 11a/11b: one bounded check). */
export const RELAY_CHECK_WINDOW_MS = 5_000

export type RelayLineKind = 'off' | 'connecting' | 'online' | 'unreachable' | 'failed'

export interface RelayLine {
  kind: RelayLineKind
  text: string
  /** The server's reason, verbatim — only on `failed`. */
  detail?: string
}

/** The relay as the status line names it: its hostname, or the URL as written when it does not parse. */
export function relayHostname(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** A relay's version as the readouts print it (canvas 11d): "relay 0.3.1", or "an older relay" when it announced none. */
export function relayVersionLabel(version: string | null): string {
  return version === null ? 'an older relay' : `relay ${version}`
}

/**
 * The status Settings → Mobile draws while its "Try again" runs on a relay
 * too old (canvas 11b): the restart passes through `connecting`, which would
 * swap the card for "Waiting for the relay" mid-check. While `held` (the
 * too-old status the check started from) is set, an in-between status shows
 * as `held`; one the check settled on — too old again, online, a failure —
 * shows as itself.
 */
export function statusDuringCheck(live: RemoteStatus, held: RemoteStatus | null): RemoteStatus {
  if (held === null || live.error !== null || !live.enabled) return live
  return live.relay === 'connecting' || live.relay === 'off' ? held : live
}

/**
 * Whether a status ends Settings → Mobile's bounded relay check: the relay
 * answered one way or the other, or the start failed. `connecting` keeps it
 * waiting.
 */
export function relayCheckSettled(status: RemoteStatus): boolean {
  return status.error !== null || !status.enabled || status.relay === 'online' || status.relay === 'too_old'
}

/** The status line under the switch (canvas 9q). A start error wins over whatever the relay says. */
export function relayLine(status: RemoteStatus): RelayLine {
  if (status.error !== null) return { kind: 'failed', text: "couldn't start", detail: status.error }
  // canvas 11b, 11d A: the host as `online` names it, both versions underneath.
  if (status.relay === 'too_old') {
    const host = status.relayUrl.trim() === '' ? '' : relayHostname(status.relayUrl)
    const tooOld = status.relayTooOld
    return {
      kind: 'failed',
      text: host === '' ? 'relay too old' : `relay too old · ${host}`,
      ...(tooOld ? { detail: `${relayVersionLabel(tooOld.relayVersion)} · Orbital needs ≥ ${tooOld.needed}` } : {}),
    }
  }
  if (status.relay === 'online') {
    // Online implies a URL, but the status is the server's word: an empty one
    // must not leave a dangling separator.
    const host = status.relayUrl.trim() === '' ? '' : relayHostname(status.relayUrl)
    return { kind: 'online', text: host === '' ? 'online' : `online · ${host}` }
  }
  if (status.relay === 'connecting') {
    return status.relayAttempts >= RELAY_UNREACHABLE_AFTER_ATTEMPTS
      ? { kind: 'unreachable', text: "can't reach the relay" }
      : { kind: 'connecting', text: 'connecting to relay…' }
  }
  return { kind: 'off', text: 'off' }
}

export interface CodeLeft {
  /** `m:ss`, part seconds rounded up so an open code never reads 0:00. */
  label: string
  /** What is left of `PAIRING_WINDOW_MS`, 0..1. */
  fraction: number
  expired: boolean
}

export function codeLeft(expiresAt: number, now: number): CodeLeft {
  const left = Math.max(0, expiresAt - now)
  const seconds = Math.ceil(left / 1000)
  const label = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  return { label, fraction: Math.min(1, left / PAIRING_WINDOW_MS), expired: left === 0 }
}

/**
 * What committing the Relay URL field does: nothing when the trimmed value is
 * what is saved, save it when no phone is paired, and otherwise ask first —
 * the paired phones are removed with the change. With the count unknown (no
 * status yet) a change is `unknown`: it can neither skip the confirm nor ask
 * about phones it cannot count, so it waits.
 */
export function relayUrlCommit(
  saved: string,
  typed: string,
  pairedCount: number | null,
): 'none' | 'unknown' | 'save' | 'ask' {
  if (typed.trim() === saved.trim()) return 'none'
  if (pairedCount === null) return 'unknown'
  return pairedCount === 0 ? 'save' : 'ask'
}

/**
 * What committing the Relay secret field does (ADR
 * the-relay-takes-a-shared-secret): as `relayUrlCommit`, except that clearing
 * it saves without asking — a relay without `RELAY_SECRET` accepts the secret
 * the paired phones still send, so nothing strands them.
 */
export function relaySecretCommit(
  saved: string,
  typed: string,
  pairedCount: number | null,
): 'none' | 'unknown' | 'save' | 'ask' {
  if (typed.trim() !== saved.trim() && typed.trim() === '') return 'save'
  return relayUrlCommit(saved, typed, pairedCount)
}
