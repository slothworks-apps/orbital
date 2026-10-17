import { useOrbital } from '../store/store'
import { sessionAsOf, sessionOffline, sessionReady, sessionRefusedLine } from './deviceList'
import { useMobile } from './state'

function useDeviceId(id: string | null): string | null {
  return useOrbital((s) => (id === null ? null : (s.sessions[id]?.machine?.id ?? null)))
}

/**
 * Whether session `id` is read only on the phone: the device it runs on is
 * asleep, or refuses this app (too old for it). Answering waits for that
 * device; every other device's sessions work as usual (canvas 50j ASLEEP,
 * PER DEVICE).
 */
export function useSessionAsleep(id: string | null): boolean {
  const deviceId = useDeviceId(id)
  return useMobile((s) => sessionOffline(s, deviceId))
}

/** The line that stands in for answering session `id` while its device refuses this app; null otherwise. */
export function useSessionRefusedLine(id: string | null): string | null {
  const deviceId = useDeviceId(id)
  return useMobile((s) => sessionRefusedLine(s, deviceId))
}

/** Whether requests about session `id` go through now: its device's channel is up. */
export function useSessionReady(id: string | null): boolean {
  const deviceId = useDeviceId(id)
  return useMobile((s) => sessionReady(s, deviceId))
}

/** The name of the device session `id` runs on, else the device the app means when it means one. */
export function useSessionDeviceName(id: string | null): string | null {
  const name = useOrbital((s) => (id === null ? null : (s.sessions[id]?.machine?.name ?? null)))
  const macName = useMobile((s) => s.macName)
  return name || macName
}

/** `useSessionDeviceName` outside React: for words built after a request returns. */
export function sessionDeviceName(id: string): string | null {
  return useOrbital.getState().sessions[id]?.machine?.name || useMobile.getState().macName
}

/** When the device of session `id` last sent anything, while it is away (`sessionAsOf`). */
export function useSessionAsOf(id: string | null): number | null {
  const deviceId = useDeviceId(id)
  return useMobile((s) => sessionAsOf(s, deviceId))
}
