import { useEffect, useState, type CSSProperties } from 'react'
import { chordLabel, command } from '../lib/keymap'
import type { BottomIndicator } from './transcriptMotion'

/** The three places a transcript is drawn (canvas `Feature - Jump to bottom` 43a, 43b, 43c). */
export type JumpSurface = 'panel' | 'subagent' | 'phone'

/**
 * Geometry and the surface's own fill per surface, verbatim from 43e's parts
 * table. The fill is the transcript behind the control: it rings the button's
 * edge (so it stays clean over images and user bubbles) and colours the scrim.
 */
const SURFACES = {
  panel: {
    height: 28,
    newWidth: 106,
    arrowCell: 26,
    labelPad: 12,
    arrowPx: 12,
    labelPx: 9.5,
    right: 14,
    bottom: 12,
    hitPad: 0,
    scrim: 44,
    fill: 'oklch(13% .02 262)',
    shadow: '0 6px 18px oklch(0% 0 0 / .5)',
  },
  subagent: {
    height: 28,
    newWidth: 106,
    arrowCell: 26,
    labelPad: 12,
    arrowPx: 12,
    labelPx: 9.5,
    right: 12,
    bottom: 12,
    hitPad: 0,
    scrim: 40,
    fill: 'oklch(11% .02 262)',
    shadow: '0 6px 18px oklch(0% 0 0 / .5)',
  },
  // Bigger to the finger than to the eye: `hitPad` is transparent.
  phone: {
    height: 40,
    newWidth: 124,
    arrowCell: 36,
    labelPad: 14,
    arrowPx: 15,
    labelPx: 10.5,
    right: 12,
    bottom: 12,
    hitPad: 4,
    scrim: 56,
    fill: 'oklch(10% .015 262)',
    shadow: '0 8px 22px oklch(0% 0 0 / .55)',
  },
} as const satisfies Record<JumpSurface, unknown>

/** 43d/43e: arriving is slow and settles; leaving is quicker and symmetric. */
const EASE_IN = 'cubic-bezier(.22,.61,.36,1)'
const EASE_OUT = 'cubic-bezier(.45,0,.55,1)'
const TRANSITION_IN = [
  `opacity 420ms ${EASE_IN}`,
  `transform 420ms ${EASE_IN}`,
  `width 640ms ${EASE_IN}`,
  `border-color 640ms ${EASE_IN}`,
  `color 640ms ${EASE_IN}`,
].join(', ')
const TRANSITION_OUT = `opacity 320ms ${EASE_OUT}, transform 320ms ${EASE_OUT}`
/** Reduced motion: the transitions become opacity-only (43e, Scroll). */
const TRANSITION_REDUCED = 'opacity 200ms linear'
/** The label fades in after the button has started to widen (43a). */
const LABEL_TRANSITION = `opacity 420ms ${EASE_IN} 220ms`
/** NEW is forgotten this long after the indicator starts leaving, so it leaves
 * as it was rather than collapsing on the way out (43e, NEW rule). */
const FORGET_NEW_MS = 340

/** `oklch(13% .02 262)` → `oklch(13% .02 262 / .92)`. */
function withAlpha(oklch: string, alpha: number): string {
  return `${oklch.slice(0, -1)} / ${alpha})`
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
  )
  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!query) return
    const onChange = () => setReduced(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return reduced
}

interface JumpToBottomProps {
  state: BottomIndicator
  surface: JumpSurface
  onJump: () => void
}

/**
 * The way back to the bottom of a transcript the reader has scrolled away
 * from (spec 2026-10-04-transcript-jump-to-bottom-design). ABOVE is a round
 * ↓; NEW widens it leftwards to say "NEW BELOW", the arrow staying where it
 * is. Never a number, only neutral ink, and every transition runs once.
 *
 * Always mounted: it fades rather than unmounts, so the width can animate
 * from ABOVE to NEW and the label can leave as it came.
 */
export function JumpToBottom({ state, surface, onJump }: JumpToBottomProps) {
  const s = SURFACES[surface]
  const reduced = usePrefersReducedMotion()
  const shown = state !== 'hidden'

  const [fresh, setFresh] = useState(false)
  useEffect(() => {
    if (state === 'new') {
      setFresh(true)
      return
    }
    if (state === 'above') {
      setFresh(false)
      return
    }
    const timer = setTimeout(() => setFresh(false), FORGET_NEW_MS)
    return () => clearTimeout(timer)
  }, [state])

  const label = fresh ? 'Jump to the latest message — new messages below' : 'Jump to the latest message'
  const width = fresh ? s.newWidth : s.height

  const scrimStyle: CSSProperties = {
    height: s.scrim,
    background: `linear-gradient(180deg, ${withAlpha(s.fill, 0)}, ${withAlpha(s.fill, 0.92)})`,
    opacity: shown ? 1 : 0,
    transition: reduced
      ? TRANSITION_REDUCED
      : shown
        ? `opacity 420ms ${EASE_IN}`
        : `opacity 320ms ${EASE_OUT}`,
  }

  const buttonStyle: CSSProperties = {
    right: s.right - s.hitPad,
    bottom: s.bottom - s.hitPad,
    padding: s.hitPad,
    opacity: shown ? 1 : 0,
    transform: shown || reduced ? 'translateY(0)' : 'translateY(8px)',
    transition: reduced ? TRANSITION_REDUCED : shown ? TRANSITION_IN : TRANSITION_OUT,
  }

  const pillStyle: CSSProperties = {
    height: s.height,
    width,
    boxShadow: `0 0 0 1px ${s.fill}, ${s.shadow}`,
    transition: reduced ? undefined : TRANSITION_IN,
  }

  return (
    <>
      {/* The rows fade into the panel under the control, so it never reads
          as sitting on top of a line of text. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 z-[2]"
        style={scrimStyle}
      />
      <button
        type="button"
        data-jump-to-bottom={state}
        aria-label={label}
        aria-hidden={!shown || undefined}
        tabIndex={shown ? undefined : -1}
        title={surface === 'phone' ? undefined : `Jump to the latest message  ${chordLabel(command('session.latest').chords[0])}`}
        onClick={onJump}
        className={[
          'group absolute z-[3] block appearance-none border-0 bg-transparent focus-visible:outline-none',
          shown ? 'cursor-pointer' : 'pointer-events-none',
        ].join(' ')}
        style={buttonStyle}
      >
        <span
          className={[
            'flex items-center justify-end overflow-hidden rounded-full border bg-[oklch(20%_.022_258)] group-hover:bg-[oklch(23%_.025_255)]',
            'group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-accent group-focus-visible:outline-solid',
            fresh
              ? 'border-[oklch(82%_.085_236_/_.34)] text-[oklch(94%_.012_255)]'
              : 'border-[oklch(82%_.085_236_/_.22)] text-[oklch(80%_.035_245)] group-hover:border-[oklch(82%_.085_236_/_.34)]',
          ].join(' ')}
          style={pillStyle}
        >
          <span
            className="shrink-0 whitespace-nowrap font-mono tracking-[0.14em]"
            style={{
              paddingLeft: s.labelPad,
              fontSize: s.labelPx,
              opacity: fresh ? 1 : 0,
              transition: reduced ? undefined : LABEL_TRANSITION,
            }}
          >
            NEW BELOW
          </span>
          <span
            aria-hidden
            className="grid shrink-0 place-items-center font-mono leading-none"
            style={{ width: s.arrowCell, fontSize: s.arrowPx }}
          >
            ↓
          </span>
        </span>
      </button>
      {/* One polite announcement per departure, when NEW starts (43e, Accessibility). */}
      <span className="sr-only" aria-live="polite">
        {state === 'new' ? 'New messages below' : ''}
      </span>
    </>
  )
}
