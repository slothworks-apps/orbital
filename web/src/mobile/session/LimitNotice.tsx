import type { SlotKeyProps, SlotProps } from './slot'

/**
 * The transcript's last row while the session waits for a plan limit: when
 * it continues, what it sends, Cancel / Undo, and the queued messages (spec
 * 2026-10-05-mobile-next § 5; canvas 10k). Slot stub — T5.1 builds it.
 */
export function LimitNotice(_props: SlotProps) {
  return null
}

/** As `useGateCardKey`, for the notice: null while there is none. */
export function useLimitNoticeKey(_props: SlotKeyProps): string | null {
  return null
}
