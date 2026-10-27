import { useEffect, useRef, useState } from 'react'
import { FloatingTooltip } from '../ui/Tooltip'
import { PIN_TOOLTIP_DELAY_MS } from '../panels/UtilityStrip'

/**
 * Sloth's resting position, expressed as a percentage of the map viewport
 * rather than a fixed pixel offset — the original design artboard is a
 * fixed 1440x900 canvas (sloth at left:120/top:640), but `SpaceMap` is a
 * full-bleed, arbitrarily-sized viewport, so a literal pixel offset would
 * drift off-proportion (or off-screen) at other viewport sizes.
 */
const SLOTH_LEFT_PERCENT = (120 / 1440) * 100
const SLOTH_TOP_PERCENT = (640 / 900) * 100

/**
 * How far outside the sprite the pointer still counts as on it. The sprite is
 * small and moving; a target exactly its size is hard to land on.
 */
const HIT_SLOP_PX = 8

/**
 * How much faster the sloth turns while it speaks. Its drift stops then, and
 * the quicker turn keeps it alive in place; still slow enough to stay calm.
 */
const SPEAKING_TURN_RATE = 4

/** What the sloth says when the pointer finds it (issue #155). */
const SLOTH_QUOTES: readonly string[] = [
  'Open the pod bay doors, HAL.',
  'I’m sorry, Dave. I’m afraid I can’t do that.',
  'In space, no one can hear you scream.',
  'Houston, we have a problem.',
  'Failure is not an option.',
  'Do not go gentle into that good night.',
  'I’m going to have to science the heck out of this.',
  'Never tell me the odds.',
  'Do. Or do not. There is no try.',
  'That’s no moon.',
  'I’ve got a bad feeling about this.',
  'Hello there.',
  'To infinity and beyond!',
  'Resistance is futile.',
  'Live long and prosper.',
  'Space: the final frontier.',
  'Don’t Panic.',
  'So long, and thanks for all the fish.',
  'Forty-two.',
  'Ground control to Major Tom.',
  'We are made of star-stuff.',
  'Look at me. I’m the captain now.',
  'This is fine.',
  'One small step for a sloth.',
  'Slow and steady wins the race.',
  'You’re absolutely right!',
  'Smoke me a kipper, I’ll be back for breakfast.',
  'Everybody’s dead, Dave.',
  'Step up to Red Alert! — Are you sure, sir? It does mean changing the bulb.',
  'I’ve got an IQ of 6000. The same IQ as 6000 PE teachers.',
  'Gazpacho soup!',
  'Smeg.',
  'It’s a trap!',
  'These aren’t the droids you’re looking for.',
  'I am Groot.',
  'Make it so.',
  'Danger, Will Robinson!',
  'E.T. phone home.',
  'Just keep swimming.',
  'Hakuna matata.',
  'I love it when a plan comes together.',
]

/** A quote other than the one just shown, so hovering twice never repeats it. */
function nextQuote(previous: number | null): number {
  const pick = Math.floor(Math.random() * (SLOTH_QUOTES.length - 1))
  return previous !== null && pick >= previous ? pick + 1 : pick
}

/** The box, when the point lies on it or within `HIT_SLOP_PX` of it. */
function hit(r: DOMRect | undefined, x: number, y: number): DOMRect | null {
  if (!r) return null
  const inside =
    x >= r.left - HIT_SLOP_PX &&
    x <= r.right + HIT_SLOP_PX &&
    y >= r.top - HIT_SLOP_PX &&
    y <= r.bottom + HIT_SLOP_PX
  return inside ? r : null
}

/**
 * The sloth easter egg: it drifts and tumbles slowly across the planet map and,
 * when the pointer rests on it, stops drifting (it turns a little faster instead) and says a line from pop culture
 * (spec: 2026-10-26-sloth-quotes-design). It speaks only when asked — a bubble
 * that appeared on its own would pull the eye, which the map never does
 * (`docs/why-orbital.md` → Nothing blinks).
 *
 * The sloth never takes the pointer: it stays `pointer-events-none`, so a
 * planet it drifts over can still be hovered and clicked. Whether the pointer
 * is on it is worked out from the pointer's own moves instead — which also
 * means a sloth drifting under a pointer that is standing still never counts.
 */
export function Sloth({ paused }: { paused: boolean }) {
  const [quote, setQuote] = useState<number | null>(null)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const sprite = useRef<HTMLImageElement | null>(null)
  const tumble = useRef<HTMLDivElement | null>(null)
  const speaking = quote !== null && rect !== null

  // Through the running animation rather than its CSS duration: a new
  // duration would jump the turn to another angle, a new playback rate
  // carries on from where it is.
  useEffect(() => {
    for (const turn of tumble.current?.getAnimations?.() ?? []) {
      turn.updatePlaybackRate(speaking ? SPEAKING_TURN_RATE : 1)
    }
  }, [speaking])

  useEffect(() => {
    if (paused) return
    let x = 0
    let y = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    // The sprite's box when it began to speak. It keeps turning while it
    // speaks, which grows and shrinks its live box; the pointer is tested
    // against this one instead, so the turn alone never takes the bubble down.
    let held: DOMRect | null = null
    const box = () => held ?? sprite.current?.getBoundingClientRect()
    const cancel = () => {
      if (timer === null) return
      clearTimeout(timer)
      timer = null
    }
    const hush = () => {
      cancel()
      if (!held) return
      held = null
      setRect(null)
    }
    const onMove = (e: PointerEvent) => {
      x = e.clientX
      y = e.clientY
      // Only over the open map: the sloth's path runs under the sidebar,
      // and a pointer over a panel is not looking at the sloth.
      const onMap = e.target instanceof HTMLCanvasElement
      if (!onMap || !hit(box(), x, y)) return hush()
      if (held || timer !== null) return
      // The sloth answers a pointer that rests on it, not one crossing it on
      // the way to a planet — the same rest the header's tooltips wait for.
      timer = setTimeout(() => {
        timer = null
        const still = hit(box(), x, y)
        if (!still) return
        held = still
        setQuote((q) => nextQuote(q))
        // It stops drifting while it speaks (`data-speaking` below), so this
        // box stays where the sloth is for as long as the bubble is up.
        setRect(still)
      }, PIN_TOOLTIP_DELAY_MS)
    }
    const root = document.documentElement
    window.addEventListener('pointermove', onMove)
    root.addEventListener('pointerleave', hush)
    return () => {
      window.removeEventListener('pointermove', onMove)
      root.removeEventListener('pointerleave', hush)
      hush()
    }
  }, [paused])

  return (
    <div
      className="orbital-sloth pointer-events-none absolute"
      data-paused={paused ? '' : undefined}
      data-speaking={speaking ? '' : undefined}
      style={{ left: `${SLOTH_LEFT_PERCENT}%`, top: `${SLOTH_TOP_PERCENT}%`, width: 16 }}
    >
      <div className="orbital-sloth-bob">
        <div ref={tumble} className="orbital-sloth-tumble">
          <img
            ref={sprite}
            src="/sloth.png"
            alt=""
            style={{
              display: 'block',
              width: 16,
              height: 'auto',
              opacity: 0.7,
              filter: 'drop-shadow(0 0 4px oklch(80% .13 210 / .35))',
            }}
          />
        </div>
      </div>
      {speaking && <FloatingTooltip title={SLOTH_QUOTES[quote]} rect={rect} tail />}
    </div>
  )
}
