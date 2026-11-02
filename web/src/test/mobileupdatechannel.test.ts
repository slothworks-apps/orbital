import { describe, expect, it, vi } from 'vitest'
import type { UpdateChannel } from '../lib/updateChannel'
import {
  channelAction,
  createChannelFollower,
  parseChannelRecord,
  type ChannelAction,
} from '../mobile/update/channel'

// Spec 2026-11-02-experimental-release-channel-design → On the phone.

describe('the channel record', () => {
  it('is experimental only for the exact word; absent or anything else is the shell’s production', () => {
    expect(parseChannelRecord('experimental')).toBe('experimental')
    for (const raw of [null, '', 'stable', 'production', 'Experimental', '"experimental"']) {
      expect(parseChannelRecord(raw)).toBe('stable')
    }
  })
})

describe('the channel action', () => {
  const cases: [UpdateChannel, UpdateChannel, UpdateChannel | null, ChannelAction][] = [
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
      record = channel === 'experimental' ? channel : null
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

  it('a stable read on a phone that never joined calls nothing — an older shell is never asked', async () => {
    const h = harness()
    await h.follower.want('stable')
    expect(h.apply).not.toHaveBeenCalled()
  })

  it('leaves experimental when the setting goes back, and records production', async () => {
    const h = harness('experimental')
    await h.follower.want('stable')
    expect(h.apply.mock.calls).toEqual([['unset']])
    expect(h.record()).toBeNull()
  })

  it('records nothing on a refusal and does not retry on the next read of the same value', async () => {
    const h = harness()
    h.apply.mockRejectedValue(new Error('disabled_by_config'))
    await h.follower.want('experimental')
    await h.follower.want('experimental')
    expect(h.apply).toHaveBeenCalledTimes(1)
    expect(h.warn).toHaveBeenCalledTimes(1)
    expect(h.record()).toBeNull()
  })

  it('retries after a refusal once the setting changes and comes back', async () => {
    const h = harness()
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
    expect(h.record()).toBeNull()
  })
})
