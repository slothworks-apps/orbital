import { useRef, useState } from 'react'
import { FloatingTooltip } from '../ui/Tooltip'

/**
 * Sloth's resting position, expressed as a percentage of the map viewport
 * rather than a fixed pixel offset — the original design artboard is a
 * fixed 1440x900 canvas (sloth at left:120/top:640), but `SpaceMap` is a
 * full-bleed, arbitrarily-sized viewport, so a literal pixel offset would
 * drift off-proportion (or off-screen) at other viewport sizes.
 */
const SLOTH_LEFT_PERCENT = (120 / 1440) * 100
const SLOTH_TOP_PERCENT = (640 / 900) * 100

/** What the sloth says when the pointer finds it (issue #155): a line and where it is from. */
export const SLOTH_QUOTES: ReadonlyArray<{ line: string; source: string }> = [
  { line: 'Open the pod bay doors, HAL.', source: '2001: A Space Odyssey' },
  { line: 'I’m sorry, Dave. I’m afraid I can’t do that.', source: '2001: A Space Odyssey' },
  { line: 'In space, no one can hear you scream.', source: 'Alien' },
  { line: 'Houston, we have a problem.', source: 'Apollo 13' },
  { line: 'Failure is not an option.', source: 'Apollo 13' },
  { line: 'Do not go gentle into that good night.', source: 'Interstellar' },
  { line: 'I’m going to have to science the heck out of this.', source: 'The Martian' },
  { line: 'Never tell me the odds.', source: 'The Empire Strikes Back' },
  { line: 'Do. Or do not. There is no try.', source: 'The Empire Strikes Back' },
  { line: 'That’s no moon.', source: 'A New Hope' },
  { line: 'I’ve got a bad feeling about this.', source: 'Star Wars' },
  { line: 'Hello there.', source: 'Revenge of the Sith' },
  { line: 'To infinity and beyond!', source: 'Toy Story' },
  { line: 'Resistance is futile.', source: 'Star Trek: The Next Generation' },
  { line: 'Live long and prosper.', source: 'Star Trek' },
  { line: 'Space: the final frontier.', source: 'Star Trek' },
  { line: 'Don’t Panic.', source: 'The Hitchhiker’s Guide to the Galaxy' },
  { line: 'So long, and thanks for all the fish.', source: 'The Hitchhiker’s Guide to the Galaxy' },
  { line: 'Forty-two.', source: 'The Hitchhiker’s Guide to the Galaxy' },
  { line: 'Ground control to Major Tom.', source: 'David Bowie, Space Oddity' },
  { line: 'We are made of star-stuff.', source: 'Carl Sagan, Cosmos' },
  { line: 'Look at me. I’m the captain now.', source: 'Captain Phillips' },
  { line: 'This is fine.', source: 'KC Green, On Fire' },
  { line: 'One small step for a sloth.', source: 'nearly Neil Armstrong' },
  { line: 'Slow and steady wins the race.', source: 'Aesop, more or less' },
  { line: 'You’re absolutely right!', source: 'Claude, often' },
]

/** A quote other than the one just shown, so hovering twice never repeats it. */
function nextQuote(previous: number | null): number {
  if (SLOTH_QUOTES.length < 2) return 0
  const pick = Math.floor(Math.random() * (SLOTH_QUOTES.length - 1))
  return previous !== null && pick >= previous ? pick + 1 : pick
}

/**
 * The sloth easter egg: it drifts slowly across the planet map and, when the
 * pointer finds it, stops and says a line from space pop culture (issue #155).
 * It speaks only when asked — a bubble that appeared on its own would pull the
 * eye, which the map never does (`docs/why-orbital.md` → Nothing blinks).
 */
export function Sloth({ paused }: { paused: boolean }) {
  const [quote, setQuote] = useState<number | null>(null)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const last = useRef<number | null>(null)
  const sprite = useRef<HTMLImageElement | null>(null)

  const speak = () => {
    const next = nextQuote(last.current)
    last.current = next
    setQuote(next)
    // Held still while it speaks (see `data-paused` below), so the rect read
    // now stays where the sloth is for as long as the bubble is up.
    setRect(sprite.current?.getBoundingClientRect() ?? null)
  }
  const hush = () => {
    setQuote(null)
    setRect(null)
  }
  const speaking = quote !== null && rect !== null

  return (
    <div
      className="orbital-sloth pointer-events-none absolute"
      data-paused={paused || speaking ? '' : undefined}
      style={{ left: `${SLOTH_LEFT_PERCENT}%`, top: `${SLOTH_TOP_PERCENT}%`, width: 16 }}
    >
      <div className="orbital-sloth-bob">
        {/* The sprite is 16px and moving; the padding gives the pointer a
            target it can land on, and the negative margin keeps the sprite
            where it was. */}
        <div className="pointer-events-auto -m-2 p-2" onMouseEnter={speak} onMouseLeave={hush}>
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
      {speaking && (
        <FloatingTooltip
          title={SLOTH_QUOTES[quote].line}
          description={SLOTH_QUOTES[quote].source}
          rect={rect}
        />
      )}
    </div>
  )
}
