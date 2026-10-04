import { useRef } from 'react'
import { usePresence } from '../ui/usePresence'
import type { BottomIndicator } from './transcriptMotion'

/**
 * How long appearing and disappearing take. Slow on purpose: the indicator
 * shows a state, it never asks to be looked at (`why-orbital`, "Nothing
 * blinks").
 *
 * PROVISIONAL until Claude Design has an artboard for this indicator (spec
 * 2026-10-04-transcript-jump-to-bottom-design, "Design brief"). Until then
 * the type is the model divider's (canvas 4a) and the fill and hairline are
 * the opaque docked panel's.
 */
const PRESENCE_MS = 300

interface JumpToBottomProps {
  state: BottomIndicator
  onJump: () => void
}

/**
 * The way back to the bottom of a transcript the reader has scrolled away
 * from. Two quiet states and never a number: *above* offers the way back,
 * *new* says that something arrived below since.
 */
export function JumpToBottom({ state, onJump }: JumpToBottomProps) {
  const presence = usePresence(state !== 'hidden', PRESENCE_MS, PRESENCE_MS)
  // While fading out the state is already `hidden`; keep the last label
  // rather than flipping it mid-fade.
  const lastShown = useRef<BottomIndicator>('above')
  if (state !== 'hidden') lastShown.current = state
  if (!presence.mounted) return null
  const shown = presence.state === 'entered'
  const fresh = lastShown.current === 'new'
  return (
    <button
      type="button"
      data-jump-to-bottom={state}
      aria-label={fresh ? 'Jump to the latest message — new messages below' : 'Jump to the latest message'}
      onClick={onJump}
      className={[
        'absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full',
        'border border-panel-border bg-panel-solid px-3 py-1.5 pointer-coarse:px-4 pointer-coarse:py-2.5',
        'font-mono text-[9.5px] tracking-[0.14em] shadow-[0_8px_24px_rgba(0,0,0,.45)]',
        'transition-[opacity,color] duration-300 ease-out motion-reduce:transition-none',
        fresh ? 'text-[rgba(200,220,245,.85)]' : 'text-[rgba(160,190,225,.55)] hover:text-[rgba(200,220,245,.85)]',
        shown ? 'opacity-100' : 'pointer-events-none opacity-0',
      ].join(' ')}
    >
      <span aria-hidden>↓</span>
      <span>{fresh ? 'NEW BELOW' : 'LATEST'}</span>
    </button>
  )
}
