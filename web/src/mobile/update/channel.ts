import { create } from 'zustand'
import { UPDATE_CHANNEL_KEY, parseUpdateChannel, type UpdateChannel } from '@orbital/shared/updateChannel'

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
 * starts offline keeps its channel; nor on a read without the key, which
 * comes from a member too old to know the setting (every server that knows
 * it seeds `stable`), so a mixed group does not flip the phone back and forth.
 */

/** The channel name on Beam for experimental; stable is Beam's `production`. */
export const BEAM_EXPERIMENTAL_CHANNEL = 'experimental'

/** What the plugin is asked to do: join Beam's experimental channel, leave it, or nothing. */
export type ChannelAction = 'set' | 'unset' | 'none'

/**
 * The call that brings the plugin from the channel recorded to the one the
 * group wants. `failed` is the channel an attempt in this start already
 * failed to reach (an older shell refusing `setChannel`, Beam down): it is
 * not tried again until the setting changes or the app starts again. With
 * no record, the plugin's channel is not known, so either is applied once;
 * leaving experimental makes no request, and the record written after it
 * ends the calls.
 */
export function channelAction(input: {
  wanted: UpdateChannel
  applied: UpdateChannel | null
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
  /** Writes the record; both channels are written, so that a missing one means unknown. */
  save(channel: UpdateChannel): Promise<void>
  warn(err: unknown): void
}

export interface ChannelFollower {
  /** The group's channel, from a settings read a member answered. */
  want(channel: UpdateChannel): Promise<void>
}

/**
 * The channel the plugin last took, as recorded: what Settings → About says
 * (canvas `Feature - Experimental updates` 1g), not the group's setting —
 * an older shell that refused experimental says nothing. Null while unknown.
 */
export const useAppliedChannel = create<{ channel: UpdateChannel | null }>(() => ({ channel: null }))

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
  // No record is unknown: a phone that never applied a channel, or whose
  // storage was cleared while the plugin may still sit on experimental.
  const applied = (): UpdateChannel | null => {
    const raw = effects.load()
    return raw === null ? null : parseUpdateChannel(raw)
  }
  useAppliedChannel.setState({ channel: applied() })

  async function run(): Promise<void> {
    if (running || wanted === null) return
    const target = wanted
    const action = channelAction({ wanted: target, applied: applied(), failed })
    if (action === 'none') return
    running = true
    try {
      await effects.apply(action)
      await effects.save(target)
      useAppliedChannel.setState({ channel: target })
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

/**
 * A settings read a member answered. Before the updater is on, only
 * remembered. A read without the key is from a member that does not know
 * the setting, and changes nothing.
 */
export function channelSettingRead(settings: Record<string, string | undefined>): void {
  const value = settings[UPDATE_CHANNEL_KEY]
  if (value === undefined) return
  lastRead = parseUpdateChannel(value)
  if (follower) void follower.want(lastRead)
}

/** The updater is on: from now on, every settings read is followed, the one already made first. */
export function startFollowingChannel(next: ChannelFollower): void {
  follower = next
  if (lastRead) void next.want(lastRead)
}
