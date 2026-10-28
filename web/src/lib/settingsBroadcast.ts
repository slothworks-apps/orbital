/**
 * A setting saved in one window, told to the app's other windows. The
 * server does not publish a local PATCH (the `settings` topic carries only
 * what another member of the group changed), so a detached session window
 * would keep its old value until reloaded. Windows of one origin share a
 * `BroadcastChannel`; a channel never hears its own messages.
 */

const CHANNEL = 'orbital-settings'

let channel: BroadcastChannel | null | undefined

function shared(): BroadcastChannel | null {
  if (channel === undefined) channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null
  return channel
}

export function broadcastSettings(patch: Record<string, string>): void {
  shared()?.postMessage(patch)
}

export function onBroadcastSettings(apply: (patch: Record<string, string>) => void): void {
  shared()?.addEventListener('message', (event: MessageEvent) => {
    const patch: unknown = event.data
    if (patch && typeof patch === 'object') apply(patch as Record<string, string>)
  })
}
