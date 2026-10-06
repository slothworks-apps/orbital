import { useState } from 'react'
import { tagColor } from '../../lib/types'
import { useOrbital } from '../../store/store'
import { chipLabel } from '../subagents/model'
import { MoonsSheet, takeReturnToSheet } from '../subagents/MoonsSheet'
import type { SlotProps } from './slot'

/** 9b's header draws at most this many moons before the count. */
const MOONS_SHOWN = 3

/**
 * Header row 2, after the harness progress: the session's moons and tasks,
 * "3 · ▣ 1", which opens SUBAGENTS & BACKGROUND TASKS (spec
 * 2026-10-05-mobile-next § 3; canvas 9b at rest, 10f pressed while its sheet
 * is open). Nothing when the session has neither.
 */
export function MoonsChip({ session, offline }: SlotProps) {
  const tag = useOrbital((s) => s.tags.find((t) => t.id === session.tagIds[0]))
  const [open, setOpen] = useState(() => takeReturnToSheet(session.id))
  const tagHue = tag ? tagColor(tag.hue) : 'var(--state-neutral)'
  const tasks = session.backgroundTasks ?? []
  const label = chipLabel(session.subagents, tasks)
  if (label === null) return null

  return (
    <>
      <button
        type="button"
        aria-label={`Subagents and background tasks: ${label}`}
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="flex h-11 shrink-0 items-center"
      >
        {/* canvas 9b at rest; canvas 10f the pressed pill while the sheet is up. */}
        <span
          className={[
            'flex items-center gap-[5px] font-mono text-[10.5px]',
            open
              ? 'h-8 rounded-[8px] border border-[rgba(150,205,255,.3)] bg-[rgba(150,205,255,.14)] px-[9px] text-text-bright'
              : 'px-2 text-[rgba(200,220,245,.75)]',
          ].join(' ')}
        >
          {session.subagents.slice(0, MOONS_SHOWN).map((agent) => (
            <span
              key={agent.id}
              aria-hidden
              className={[
                'box-border block h-2 w-2 rounded-full border bg-[oklch(30%_.05_220)]',
                !offline && agent.state !== 'ended' ? 'orbital-pulse' : '',
              ].join(' ')}
              style={{ borderColor: tagHue }}
            />
          ))}
          {label}
        </span>
      </button>
      {open && <MoonsSheet session={session} tagHue={tagHue} offline={offline} onClose={() => setOpen(false)} />}
    </>
  )
}
