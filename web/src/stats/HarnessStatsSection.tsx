import { useEffect } from 'react'
import { useOrbital } from '../store/store'
import { harnessEnabled } from '../lib/experimental'
import { HarnessRecordView } from '../panels/HarnessPanel'
import { readHarnessOnce } from '../panels/HarnessPill'

/**
 * Session stats → Harness (spec 2026-10-02-harness-redesign-design § 6, the
 * 30b Remove dialog: "You can still read them from session stats →
 * Harness"): the session's harness, live or removed, as the panel draws its
 * record (`HarnessRecordView`, read-only once removed). Present only when the
 * session has had one.
 */
export function HarnessStatsSection({ sessionId }: { sessionId: string }) {
  const enabled = useOrbital((s) => harnessEnabled(s.settings))
  const live = useOrbital((s) => s.harnesses[sessionId])
  const removed = useOrbital((s) => s.harnessRemoved[sessionId])
  useEffect(() => {
    if (enabled && (live === undefined || removed === undefined)) readHarnessOnce(sessionId)
  }, [enabled, live, removed, sessionId])

  if (!enabled || !(live ?? removed)) return null
  return (
    <section aria-label="Harness" className="border-t border-[rgba(150,205,255,.1)] pt-4">
      <div className="font-mono text-[9.5px] tracking-[0.18em] text-[rgba(160,190,225,.6)]">HARNESS</div>
      {/* The record scrolls inside its own column, as it does in the side slot. */}
      <div className="mt-2.5 h-[480px] overflow-hidden rounded-xl border border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.45)]">
        <HarnessRecordView key={sessionId} sessionId={sessionId} />
      </div>
    </section>
  )
}
