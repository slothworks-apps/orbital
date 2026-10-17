import { useOrbital } from '../store/store'
import { sessionAsleep, sessionReady } from './deviceList'
import { useMobile } from './state'

/**
 * Whether the device session `id` runs on is asleep: what it shows is read
 * only, and answering waits for that device; every other device's sessions
 * work as usual (canvas 50j ASLEEP, PER DEVICE).
 */
export function useSessionAsleep(id: string | null): boolean {
  const deviceId = useOrbital((s) => (id === null ? null : (s.sessions[id]?.machine?.id ?? null)))
  return useMobile((s) => sessionAsleep(s, deviceId))
}

/** Whether requests about session `id` go through now: its device's channel is up. */
export function useSessionReady(id: string | null): boolean {
  const deviceId = useOrbital((s) => (id === null ? null : (s.sessions[id]?.machine?.id ?? null)))
  return useMobile((s) => sessionReady(s, deviceId))
}

/** The name of the device session `id` runs on, else the device the app means when it means one. */
export function useSessionDeviceName(id: string | null): string | null {
  const name = useOrbital((s) => (id === null ? null : (s.sessions[id]?.machine?.name ?? null)))
  const macName = useMobile((s) => s.macName)
  return name || macName
}

/** When the device of session `id` last sent anything, while it is away; else when live data last arrived. */
export function useSessionAsOf(id: string | null): number | null {
  const asOf = useOrbital((s) => (id === null ? null : (s.sessions[id]?.machine?.asOf ?? null)))
  const anyAsOf = useMobile((s) => s.asOf)
  return asOf ?? anyAsOf
}
