import { awaitingSubagentLabel, type SessionStateKey } from './types'

/**
 * How each session state is drawn — the one mapping every state surface
 * reads (canvas `Feature - State colours` 24a–24e, spec
 * 2026-09-24-state-colours-design). `sessionStateKey` in `types.ts` decides
 * WHICH state a session is in; this decides its colour and its dot.
 *
 * Colour follows urgency, not the word: four tokens cover the seven states.
 * Shape carries the meaning and colour backs it up — solid / hollow / no dot
 * times breathing / pulsing / steady — so every state still reads in
 * greyscale.
 */

/** The four urgency levels plus the muted one, each a `--state-*` token in `theme.css`. */
export type StateTone = 'input' | 'interrupted' | 'done' | 'active' | 'neutral'

export const STATE_TONE: Record<SessionStateKey, StateTone> = {
  needs_input: 'input',
  interrupted: 'interrupted',
  done: 'done',
  waiting: 'active',
  working: 'active',
  idle: 'neutral',
  ended: 'neutral',
}

/** The CSS colour of a tone — always the token, so `theme.css` stays the one place a hex lives for the DOM. */
export const stateToneColor = (tone: StateTone): string => `var(--state-${tone})`

/** The CSS colour a state's word and dot take. */
export const stateColor = (key: SessionStateKey): string => stateToneColor(STATE_TONE[key])

/**
 * `--state-input` as a literal, for the one consumer that cannot read a CSS
 * variable: the planet's needs-input ripple ring, a three.js material. It
 * mirrors `--color-warning` in `theme.css`, which `--state-input` aliases —
 * change one, change the other.
 */
export const STATE_INPUT_HEX = '#ffbb7b'

/**
 * A state colour's border: the colour mixed toward transparent by one of the
 * `--state-border-a*` shares (24d: "Borders use color-mix(in oklch,
 * var(--state-x) 50%, transparent)").
 */
export const stateBorder = (color: string, share: 'chip' | 'map' | 'map-rest'): string => {
  const alpha =
    share === 'chip'
      ? 'var(--state-border-a)'
      : share === 'map'
        ? 'var(--state-border-a-map)'
        : 'var(--state-border-a-map-rest)'
  return `color-mix(in oklch, ${color} ${alpha}, transparent)`
}

export type DotShape = 'solid' | 'hollow' | 'none'
/** `breathe` is `orbital-breathe` (2.4s, to .45); `pulse` is `orbital-pulse` (1.6s, to .3). */
export type DotMotion = 'breathe' | 'pulse' | 'steady'
export interface StateDot {
  shape: DotShape
  motion: DotMotion
}

/**
 * Where a state is drawn, as far as its dot is concerned:
 *
 * - `label` — the map pill in label mode (24a), and the sidebar row and the
 *   summary line, which spell the word out beside the same dots.
 * - `dot` — the map pill in dot mode (24e). The word is gone at rest, so the
 *   dot alone has to carry the state and every pill state gets one,
 *   INTERRUPTED and DONE included.
 * - `chip` — the detail header's chip (24c), which also draws WORKING's
 *   pulsing dot and IDLE's steady one.
 */
export type StateSurface = 'label' | 'dot' | 'chip'

const NONE: StateDot = { shape: 'none', motion: 'steady' }

const LABEL_DOTS: Record<SessionStateKey, StateDot> = {
  needs_input: { shape: 'solid', motion: 'breathe' },
  waiting: { shape: 'hollow', motion: 'pulse' },
  interrupted: NONE,
  done: NONE,
  working: NONE,
  idle: NONE,
  ended: NONE,
}

const DOT_MODE_DOTS: Record<SessionStateKey, StateDot> = {
  ...LABEL_DOTS,
  interrupted: { shape: 'solid', motion: 'steady' },
  done: { shape: 'hollow', motion: 'steady' },
}

const CHIP_DOTS: Record<SessionStateKey, StateDot> = {
  ...LABEL_DOTS,
  working: { shape: 'solid', motion: 'pulse' },
  idle: { shape: 'solid', motion: 'steady' },
}

const DOTS: Record<StateSurface, Record<SessionStateKey, StateDot>> = {
  label: LABEL_DOTS,
  dot: DOT_MODE_DOTS,
  chip: CHIP_DOTS,
}

/** The dot a state wears on a given surface. */
export const stateDot = (key: SessionStateKey, surface: StateSurface): StateDot => DOTS[surface][key]

/** The CSS class that animates a dot, or none for a steady one. */
export const dotMotionClass = (motion: DotMotion): string | undefined =>
  motion === 'breathe' ? 'orbital-breathe' : motion === 'pulse' ? 'orbital-pulse' : undefined

/** Settings → Appearance → MAP: how the map's state pills are drawn (ADR state-labels-are-dots-first-on-the-map). */
export type MapStatePills = 'dot' | 'label'

/** A hollow dot's ring, CSS px — the same on every surface (24a–24e: `border: 1.5px solid`). */
export const STATE_DOT_RING_PX = 1.5

const FULL_WORD: Record<Exclude<SessionStateKey, 'waiting'>, string> = {
  needs_input: 'NEEDS INPUT',
  interrupted: 'INTERRUPTED',
  done: 'DONE',
  working: 'WORKING',
  idle: 'IDLE',
  ended: 'ENDED',
}

/**
 * A state's word. `awaiting` is the subagent count a WAITING session waits
 * on (`awaitingSubagentCount`). `short` is the sidebar row's form (24c): the
 * row has room for about eleven characters, so NEEDS INPUT becomes `INPUT`
 * and WAITING carries the moon count instead of the grammar (`WAITING · 2`).
 */
export function stateWord(key: SessionStateKey, awaiting: number, short = false): string {
  if (key === 'waiting') return short ? `WAITING · ${awaiting}` : awaitingSubagentLabel(awaiting)
  if (short && key === 'needs_input') return 'INPUT'
  return FULL_WORD[key]
}
