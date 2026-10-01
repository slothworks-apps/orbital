/**
 * Settings → Mobile's pure derivations (spec 2026-10-01-settings-mobile-design
 * §§ 3, 6): the relay status line, the pairing code's countdown and what
 * committing a relay URL has to do.
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

export type RelayLineKind = 'off' | 'connecting' | 'online' | 'unreachable' | 'failed'

export interface RelayLine {
  kind: RelayLineKind
  text: string
  /** The server's reason, verbatim — only on `failed`. */
  detail?: string
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** The status line under the switch (canvas 9q). A start error wins over whatever the relay says. */
export function relayLine(status: RemoteStatus): RelayLine {
  if (status.error !== null) return { kind: 'failed', text: "couldn't start", detail: status.error }
  if (status.relay === 'online') return { kind: 'online', text: `online · ${hostOf(status.relayUrl)}` }
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
