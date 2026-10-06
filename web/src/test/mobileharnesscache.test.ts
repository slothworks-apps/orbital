import { beforeEach, describe, expect, it, vi } from 'vitest'

// Capacitor's storage as a plain map: these tests are about what the cache
// accepts and gives back, not about the plugin.
const store = vi.hoisted(() => new Map<string, string>())
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: store.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => {
      store.set(key, value)
    },
    remove: async ({ key }: { key: string }) => {
      store.delete(key)
    },
    keys: async () => ({ keys: [...store.keys()] }),
  },
}))

import { DEFAULT_HARNESS_OPTIONS, type SessionHarness } from '../lib/types'
import {
  acceptHarness,
  clearHarnessCache,
  HARNESS_PREFIX,
  readHarnessCache,
  writeHarnessCache,
} from '../mobile/harness/harnessCache'
import { CACHE_PREFIX } from '../mobile/platform/cache'

const harness: SessionHarness = {
  sessionId: 's1',
  templateId: null,
  name: 'Build a component',
  steps: [{ id: 'a', title: 'A', instructions: '', mode: 'gate', doneWhen: '' }],
  inputs: {},
  state: [{ status: 'awaiting_approval', summary: 'Done.' }],
  options: DEFAULT_HARNESS_OPTIONS,
  paused: false,
  pauseReason: null,
  pauseKind: null,
  pausedAt: null,
  removedAt: null,
  autoRounds: 0,
  idleNudges: 0,
  createdAt: 1,
  updatedAt: 1,
}

beforeEach(() => store.clear())

describe('harness cache', () => {
  it('lives under the caches\' prefix, so forgetting the Mac drops it', () => {
    expect(HARNESS_PREFIX.startsWith(CACHE_PREFIX)).toBe(true)
  })

  it('reads back what was written, with its age', async () => {
    const value = { harness, removed: null, events: [{ id: 1, sessionId: 's1', at: 2, kind: 'ticked' as const, detail: {} }] }
    await writeHarnessCache('s1', value, 1234)
    expect(await readHarnessCache('s1')).toEqual({ asOf: 1234, value })
    expect(await readHarnessCache('s2')).toBeNull()
  })

  it('bad JSON or a wrong shape is nothing', async () => {
    store.set(`${CACHE_PREFIX}harness:s1`, '{not json')
    expect(await readHarnessCache('s1')).toBeNull()
    store.set(`${CACHE_PREFIX}harness:s1`, JSON.stringify({ asOf: 'later', value: { harness, removed: null, events: [] } }))
    expect(await readHarnessCache('s1')).toBeNull()
    store.set(`${CACHE_PREFIX}harness:s1`, JSON.stringify({ asOf: 1, value: { harness, removed: null } }))
    expect(await readHarnessCache('s1')).toBeNull()
  })

  it('accepts a session with no harness, refuses a harness without steps', () => {
    expect(acceptHarness({ harness: null, removed: null, events: [] })).toEqual({ harness: null, removed: null, events: [] })
    expect(acceptHarness({ harness: { name: 'x' }, removed: null, events: [] })).toBeNull()
    expect(acceptHarness([])).toBeNull()
  })

  it('clearing drops every harness and nothing else', async () => {
    await writeHarnessCache('s1', { harness, removed: null, events: [] }, 1)
    store.set(`${CACHE_PREFIX}transcript:s1`, '[]')
    await clearHarnessCache()
    expect([...store.keys()]).toEqual([`${CACHE_PREFIX}transcript:s1`])
  })
})
