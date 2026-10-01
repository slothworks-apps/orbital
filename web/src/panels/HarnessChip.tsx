import { useEffect } from 'react'
import { useOrbital } from '../store/store'
import { harnessEnabled } from '../lib/experimental'
import { harnessProgress } from '../lib/harness'
import { stateBorder, stateToneColor } from '../lib/stateStyle'

/**
 * The header's way into the Harness panel: `harness 2/5`, in the needs-input
 * colour while a gate waits for the user, or `+ harness` when the session
 * has none. Reads the harness the first time the session is shown.
 */
export function HarnessChip({ sessionId }: { sessionId: string }) {
  const enabled = useOrbital((s) => harnessEnabled(s.settings))
  const harness = useOrbital((s) => s.harnesses[sessionId])
  const open = useOrbital((s) => s.openHarness)

  useEffect(() => {
    if (enabled && harness === undefined) void useOrbital.getState().loadHarness(sessionId)
  }, [enabled, harness, sessionId])

  if (!enabled || harness === undefined) return null

  const progress = harness ? harnessProgress(harness.state) : null
  const color = stateToneColor(progress?.awaiting ? 'input' : progress && progress.done === progress.total ? 'done' : 'neutral')
  return (
    <button
      type="button"
      onClick={() => open(sessionId)}
      className="inline-flex items-center gap-1.5 rounded-full border px-[9px] py-[3px] font-mono text-[9.5px] tracking-[0.16em] transition-colors hover:bg-[rgba(150,205,255,.08)]"
      style={{ color, borderColor: stateBorder(color, 'chip') }}
    >
      {progress ? `HARNESS ${progress.done}/${progress.total}` : '+ HARNESS'}
    </button>
  )
}
