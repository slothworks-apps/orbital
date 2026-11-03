import { describe, expect, it, vi } from 'vitest'
import type { UpdateChannel } from '@orbital/shared/updateChannel'
import {
  channelAction,
  channelSettingRead,
  createChannelFollower,
  startFollowingChannel,
  useAppliedChannel,
  type ChannelAction,
} from '../mobile/update/channel'

// Spec 2026-11-02-experimental-release-channel-design → On the phone.

describe('the channel action', () => {
  const cases: [UpdateChannel, UpdateChannel | null, UpdateChannel | null, ChannelAction][] = [
    // wanted, applied, failed this start → action
    ['experimental', 'stable', null, 'set'],
    ['stable', 'experimental', null, 'unset'],
    ['experimental', 'experimental', null, 'none'],
    ['stable', 'stable', null, 'none'],
    // A failure is not retried within the start…
    ['experimental', 'stable', 'experimental', 'none'],
    ['stable', 'experimental', 'stable', 'none'],
    // …but a failure towards the other channel does not block this one.
    ['experimental', 'stable', 'stable', 'set'],
    ['stable', 'experimental', 'experimental', 'unset'],
    // No record (never applied, or storage cleared): the plugin's channel is unknown, so it is applied.
    ['stable', null, null, 'unset'],
    ['experimental', null, null, 'set'],
    ['stable', null, 'stable', 'none'],
  ]
  it.each(cases)('wanted %s, applied %s, failed %s → %s', (wanted, applied, failed, action) => {
    expect(channelAction({ wanted, applied, failed })).toBe(action)
  })
})

function harness(initial: string | null = null) {
  let record = initial
  const apply = vi.fn<(action: Exclude<ChannelAction, 'none'>) => Promise<void>>(async () => {})
  const warn = vi.fn()
  const follower = createChannelFollower({
    apply,
    load: () => record,
    save: async (channel) => {
      record = channel
    },
    warn,
  })
  return { follower, apply, warn, record: () => record }
}

describe('following the group’s channel', () => {
  it('joins experimental once and records it; reads that agree call nothing', async () => {
    const h = harness()
    await h.follower.want('experimental')
    await h.follower.want('experimental')
    expect(h.apply.mock.calls).toEqual([['set']])
    expect(h.record()).toBe('experimental')
  })

  it('a stable read on a phone with a stable record calls nothing — an older shell is never asked', async () => {
    const h = harness('stable')
    await h.follower.want('stable')
    expect(h.apply).not.toHaveBeenCalled()
  })

  it('with no record, a stable read leaves experimental once (the plugin may still be on it), then calls nothing', async () => {
    const h = harness()
    await h.follower.want('stable')
    await h.follower.want('stable')
    expect(h.apply.mock.calls).toEqual([['unset']])
    expect(h.record()).toBe('stable')
    const next = harness(h.record())
    await next.follower.want('stable')
    expect(next.apply).not.toHaveBeenCalled()
  })

  it('leaves experimental when the setting goes back, and records stable', async () => {
    const h = harness('experimental')
    await h.follower.want('stable')
    expect(h.apply.mock.calls).toEqual([['unset']])
    expect(h.record()).toBe('stable')
  })

  it('says experimental only once the plugin took it', async () => {
    const h = harness('stable')
    expect(useAppliedChannel.getState().channel).toBe('stable')
    h.apply.mockRejectedValueOnce(new Error('disabled_by_config'))
    await h.follower.want('experimental')
    expect(useAppliedChannel.getState().channel).toBe('stable')
    await h.follower.want('stable')
    await h.follower.want('experimental')
    expect(useAppliedChannel.getState().channel).toBe('experimental')
  })

  it('records nothing on a refusal and does not retry on the next read of the same value', async () => {
    const h = harness('stable')
    h.apply.mockRejectedValue(new Error('disabled_by_config'))
    await h.follower.want('experimental')
    await h.follower.want('experimental')
    expect(h.apply).toHaveBeenCalledTimes(1)
    expect(h.warn).toHaveBeenCalledTimes(1)
    expect(h.record()).toBe('stable')
  })

  it('retries after a refusal once the setting changes and comes back', async () => {
    const h = harness('stable')
    h.apply.mockRejectedValueOnce(new Error('request_failed'))
    await h.follower.want('experimental')
    await h.follower.want('stable')
    await h.follower.want('experimental')
    expect(h.apply.mock.calls).toEqual([['set'], ['set']])
    expect(h.record()).toBe('experimental')
  })

  it('a new start retries what the last one could not do', async () => {
    const first = harness()
    first.apply.mockRejectedValue(new Error('request_failed'))
    await first.follower.want('experimental')
    const second = harness(first.record())
    await second.follower.want('experimental')
    expect(second.apply.mock.calls).toEqual([['set']])
  })

  it('a change during a call is applied after it, one call at a time', async () => {
    const h = harness()
    let release!: () => void
    h.apply.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)))
    const first = h.follower.want('experimental')
    const second = h.follower.want('stable')
    expect(h.apply).toHaveBeenCalledTimes(1)
    release()
    await first
    await second
    expect(h.apply.mock.calls).toEqual([['set'], ['unset']])
    expect(h.record()).toBe('stable')
  })
})

describe('the settings read', () => {
  it('a read without the key — a member too old to know it — changes nothing, so a mixed group does not flip', async () => {
    const h = harness('stable')
    startFollowingChannel(h.follower)
    channelSettingRead({ update_channel: 'experimental' })
    await vi.waitFor(() => expect(h.record()).toBe('experimental'))
    channelSettingRead({})
    channelSettingRead({ update_channel: 'experimental' })
    channelSettingRead({ questions_review_before_send: 'false' })
    await Promise.resolve()
    expect(h.apply.mock.calls).toEqual([['set']])
    expect(h.record()).toBe('experimental')
    channelSettingRead({ update_channel: 'stable' })
    await vi.waitFor(() => expect(h.record()).toBe('stable'))
    expect(h.apply.mock.calls).toEqual([['set'], ['unset']])
  })
})
