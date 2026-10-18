import type { CSSProperties } from 'react'

/** A device group member's state as its dot draws it. */
export type MemberDotState = 'online' | 'offline' | 'linking' | 'notLinked' | 'update'

/**
 * A member's state dot (canvas 50a ROWS, 50i, 50k MEMBER STATE, 50f
 * `fbDot`/`fbDotBd`; logic.js `DOT`): the accent while online, every other
 * state neutral — a hollow ring offline, a dashed one while linking, a faint
 * one while not linked; an ink dot while its Orbital is too old. Nothing moves.
 */
const MEMBER_DOT: Record<MemberDotState, CSSProperties> = {
  online: { background: 'var(--color-accent)' },
  offline: { border: '1.3px solid rgba(200,215,235,.6)' },
  linking: { border: '1.3px dashed rgba(200,215,235,.6)' },
  notLinked: { border: '1.3px solid rgba(200,215,235,.32)' },
  update: { background: 'rgba(232,238,248,.85)' },
}

/**
 * The one dot every device surface draws a member with — Settings → Devices
 * on the desktop and the phone, and the device pill's RUNS ON card. Only the
 * size differs per surface; each passes its canvas's own.
 */
export function MemberDot({ state, sizePx }: { state: MemberDotState; sizePx: number }) {
  return (
    <span
      aria-hidden
      className="box-border block shrink-0 rounded-full"
      style={{ width: sizePx, height: sizePx, ...MEMBER_DOT[state] }}
    />
  )
}
