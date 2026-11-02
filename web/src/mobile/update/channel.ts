import { updateChannel, type UpdateChannel } from '../../lib/updateChannel'

/**
 * The phone's Beam channel follows the group's `update_channel` (spec
 * 2026-11-02-experimental-release-channel-design → On the phone).
 * Experimental is Beam's channel `experimental`, set through the plugin's
 * `setChannel`, which asks Beam and persists the choice on the device;
 * stable is Beam's `production`, the shell's own default, which
 * `unsetChannel` goes back to without a request.
 *
 * The phone keeps its own record of the channel it last applied and calls
 * the plugin only when the setting differs from it. The plugin's
 * `getChannel` is not used: it is a network call, and its answer can be an
 * admin's per-device assignment, which Orbital does not use. Nothing
 * happens before a member answered the settings read, so a phone that
 * starts offline keeps its channel.
 */

/** The channel name on Beam for experimental; stable is Beam's `production`. */
export const BEAM_EXPERIMENTAL_CHANNEL = 'experimental'

/** What the plugin is asked to do: join Beam's experimental channel, leave it, or nothing. */
export type ChannelAction = 'set' | 'unset' | 'none'

/**
 * The record of the channel last applied. Absent, or anything but
 * `experimental`, is stable: a shell starts on `production` and stays
 * there until `setChannel` succeeds.
 */
export function parseChannelRecord(raw: string | null): UpdateChannel {
  return raw === 'experimental' ? 'experimental' : 'stable'
}

/**
 * The call that brings the plugin from the channel recorded to the one the
 * group wants. `failed` is the channel an attempt in this start already
 * failed to reach (an older shell refusing `setChannel`, Beam down): it is
 * not tried again until the setting changes or the app starts again.
 */
export function channelAction(input: {
  wanted: UpdateChannel
  applied: UpdateChannel
  failed: UpdateChannel | null
}): ChannelAction {
  const { wanted, applied, failed } = input
  if (wanted === applied || wanted === failed) return 'none'
  return wanted === 'experimental' ? 'set' : 'unset'
}

export interface ChannelEffects {
  /** `setChannel` or `unsetChannel` on the plugin; rejects when it refuses. */
  apply(action: Exclude<ChannelAction, 'none'>): Promise<void>
  /** The record, as stored; null when none. */
  load(): string | null
  save(channel: UpdateChannel): Promise<void>
  warn(err: unknown): void
}

export interface ChannelFollower {
  /** The group's channel, from a settings read a member answered. */
  want(channel: UpdateChannel): Promise<void>
}

/**
 * Applies the wanted channel one call at a time, recording it only after
 * the plugin took it. A failure is logged and left for the next change of
 * the setting or the next start; a change that arrives during a call is
 * applied after it.
 */
export function createChannelFollower(effects: ChannelEffects): ChannelFollower {
  let wanted: UpdateChannel | null = null
  let failed: UpdateChannel | null = null
  let running = false

  async function run(): Promise<void> {
    if (running || wanted === null) return
    const target = wanted
    const action = channelAction({ wanted: target, applied: parseChannelRecord(effects.load()), failed })
    if (action === 'none') return
    running = true
    try {
      await effects.apply(action)
      await effects.save(target)
      failed = null
    } catch (err) {
      failed = target
      effects.warn(err)
    } finally {
      running = false
    }
    if (wanted !== target) await run()
  }

  return {
    want(channel) {
      if (channel !== wanted) failed = null
      wanted = channel
      return run()
    },
  }
}

// The settings read (`questionSetting.ts`) and the updater (`platform.ts`)
// start independently; whichever comes second hands over.
let follower: ChannelFollower | null = null
let lastRead: UpdateChannel | null = null

/** A settings read a member answered. Before the updater is on, only remembered. */
export function channelSettingRead(settings: Record<string, string | undefined>): void {
  lastRead = updateChannel(settings)
  if (follower) void follower.want(lastRead)
}

/** The updater is on: from now on, every settings read is followed, the one already made first. */
export function startFollowingChannel(next: ChannelFollower): void {
  follower = next
  if (lastRead) void next.want(lastRead)
}
