import { tagColor } from '../../lib/types'
import { useOrbital } from '../../store/store'
import type { SlotProps } from './slot'

/** 9b's header draws at most this many moons before the count. */
const MOONS_SHOWN = 3

/**
 * Header row 2, after the harness progress: the session's moons. Slot — T3.1
 * turns it into the chip "3 · ▣ 1" that opens the subagents and tasks sheet
 * (spec 2026-10-05-mobile-next § 3; canvas 10f). Until then it draws 9b's
 * moon dots and count, as the header did before the slots.
 */
export function MoonsChip({ session, offline }: SlotProps) {
  const tag = useOrbital((s) => s.tags.find((t) => t.id === session.tagIds[0]))
  const tagHue = tag ? tagColor(tag.hue) : 'var(--state-neutral)'
  if (session.subagents.length === 0) return null
  return (
    <span
      aria-label={`${session.subagents.length} ${session.subagents.length === 1 ? 'subagent' : 'subagents'}`}
      className="flex shrink-0 items-center gap-[5px] px-2 font-mono text-[10.5px] text-[rgba(200,220,245,.75)]"
    >
      {session.subagents.slice(0, MOONS_SHOWN).map((agent) => (
        <span
          key={agent.id}
          aria-hidden
          className={[
            'block h-2 w-2 rounded-full border bg-[oklch(30%_.05_220)]',
            !offline && agent.state !== 'ended' ? 'orbital-pulse' : '',
          ].join(' ')}
          style={{ borderColor: tagHue }}
        />
      ))}
      {session.subagents.length}
    </span>
  )
}
