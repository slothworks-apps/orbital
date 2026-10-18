import { useAsOfNow } from '../lib/asOfClock'
import { asOfLabel } from '../lib/devices'
import type { MachineRef } from '../lib/types'

/**
 * A label line closed by its offline device's age (`as of 2 h`, canvas
 * 50e/50h): `text`, then the age. The age ticks on its own clock, so the
 * minute passing (`useAsOfNow`) re-renders this text and nothing else — the scene model is
 * rebuilt only when the sessions change. Mounted only for a line that is
 * dated (`ScenePlanet.dated`).
 */
export function WithAge({ text, machine }: { text: string | null; machine: MachineRef | undefined }) {
  const now = useAsOfNow(true)
  return <>{[text, asOfLabel(machine, now)].filter(Boolean).join(' · ')}</>
}
