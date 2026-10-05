import type { SlotKeyProps, SlotProps } from './slot'

/**
 * The transcript's last row while a harness gate stands: the card and its
 * answers, folded to one line once answered (spec 2026-10-05-mobile-next
 * § 1; canvas 10b, 10c). Slot stub — T1.1 builds it.
 */
export function GateCard(_props: SlotProps) {
  return null
}

/**
 * Changes whenever the card's content does — it appearing, folding, its
 * step moving on — so a reader at the bottom is kept there
 * (`TranscriptView`'s `footerKey`). Null while there is no card.
 */
export function useGateCardKey(_props: SlotKeyProps): string | null {
  return null
}
