import { beforeEach, describe, expect, it, vi } from 'vitest'
import { compareVersions } from '@orbital/shared/remote/version'
import {
  BUILTIN,
  MIN_APP_VERSION,
  belowFloor,
  nextHighWater,
  parseHighWater,
  revertTarget,
  type HighWater,
} from '../mobile/update/guard'
import { parseRestartStash } from '../mobile/update/restartStash'
import {
  downloadVerdict,
  usePhoneUpdate,
  type DownloadedBundle,
  type UpdateSource,
} from '../mobile/update/state'

// Spec 2026-10-09-phone-ota-updates-design → The app; canvas `Feature - Phone update`.
const b = (version: string, id = `id-${version}`): DownloadedBundle => ({ id, version })

describe('a finished download', () => {
  it('is offered when it is a version neither running nor answered', () => {
    expect(
      downloadVerdict({ bundle: b('0.8.1'), running: '0.8.0', answered: null, shown: null }),
    ).toBe('prompt')
    expect(
      downloadVerdict({ bundle: b('0.8.2'), running: '0.8.0', answered: '0.8.1', shown: null }),
    ).toBe('prompt')
  })

  it('is never taken when it is not newer than the version running: the same, builtin or older', () => {
    for (const version of ['0.8.0', 'builtin', '0.7.9', '0.8']) {
      expect(
        downloadVerdict({ bundle: b(version), running: '0.8.0', answered: null, shown: null }),
      ).toBe('not-newer')
    }
  })

  it('is offered once per version', () => {
    expect(
      downloadVerdict({ bundle: b('0.8.1'), running: '0.8.0', answered: '0.8.1', shown: null }),
    ).toBe('ignore')
  })

  it('replaces an unanswered offer of another version, and nothing while restarting', () => {
    const ready = { phase: 'ready' as const, bundle: b('0.8.1') }
    expect(
      downloadVerdict({ bundle: b('0.8.2'), running: '0.8.0', answered: null, shown: ready }),
    ).toBe('prompt')
    const restarting = { phase: 'restarting' as const, bundle: b('0.8.1') }
    expect(
      downloadVerdict({
        bundle: b('0.8.2'),
        running: '0.8.0',
        answered: '0.8.1',
        shown: restarting,
      }),
    ).toBe('ignore')
  })
})

describe('the prompt', () => {
  let source: { [K in keyof UpdateSource]: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    source = {
      restart: vi.fn(async () => {}),
      later: vi.fn(async () => {}),
      answered: vi.fn(async () => {}),
    }
    usePhoneUpdate.setState({ shown: null, answered: null })
    usePhoneUpdate.getState().connect(source as unknown as UpdateSource, null)
  })

  it('Restart answers the version and reloads into the bundle', async () => {
    usePhoneUpdate.getState().downloaded(b('0.8.1'), '0.8.0')
    usePhoneUpdate.getState().restart()
    expect(usePhoneUpdate.getState().shown?.phase).toBe('restarting')
    await vi.waitFor(() => expect(source.restart).toHaveBeenCalledWith(b('0.8.1')))
    expect(source.answered).toHaveBeenCalledWith('0.8.1')
    expect(source.later).not.toHaveBeenCalled()
  })

  it('a Restart that fails ends the prompt', async () => {
    source.restart.mockRejectedValueOnce(new Error('no such bundle'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    usePhoneUpdate.getState().downloaded(b('0.8.1'), '0.8.0')
    usePhoneUpdate.getState().restart()
    await vi.waitFor(() => expect(usePhoneUpdate.getState().shown).toBeNull())
  })

  it('× leaves the bundle for the next start and shows the receipt until OK', () => {
    usePhoneUpdate.getState().downloaded(b('0.8.1'), '0.8.0')
    usePhoneUpdate.getState().close()
    expect(usePhoneUpdate.getState().shown).toEqual({ phase: 'closed', bundle: b('0.8.1') })
    expect(source.later).toHaveBeenCalledWith(b('0.8.1'))
    expect(source.answered).toHaveBeenCalledWith('0.8.1')
    // The same version downloading again does not bring the offer back.
    usePhoneUpdate.getState().downloaded(b('0.8.1'), '0.8.0')
    expect(usePhoneUpdate.getState().shown?.phase).toBe('closed')
    usePhoneUpdate.getState().ok()
    expect(usePhoneUpdate.getState().shown).toBeNull()
    usePhoneUpdate.getState().downloaded(b('0.8.1'), '0.8.0')
    expect(usePhoneUpdate.getState().shown).toBeNull()
  })

  it('a download of the running or an older version is neither offered nor kept', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    usePhoneUpdate.getState().downloaded(b('0.8.0'), '0.8.0')
    usePhoneUpdate.getState().downloaded(b('0.7.0'), '0.8.0')
    expect(usePhoneUpdate.getState().shown).toBeNull()
    expect(source.later).not.toHaveBeenCalled()
  })
})

describe('the restart stash', () => {
  it('keeps only non-empty drafts and refuses anything malformed', () => {
    expect(
      parseRestartStash(JSON.stringify({ version: '0.8.1', drafts: { a: 'hello', b: '', c: 3 } })),
    ).toEqual({
      version: '0.8.1',
      drafts: { a: 'hello' },
    })
    expect(parseRestartStash(null)).toBeNull()
    expect(parseRestartStash('{')).toBeNull()
    expect(parseRestartStash(JSON.stringify({ drafts: {} }))).toBeNull()
    expect(parseRestartStash(JSON.stringify({ version: '0.8.1', drafts: null }))).toBeNull()
  })
})

describe('the replay guard', () => {
  const hw = (version: string, bundleId = `id-${version}`): HighWater => ({ version, bundleId })

  it('lets a bundle run at or above the highest version run and the minimum', () => {
    expect(belowFloor('0.8.0', null, '0.8.0')).toBe(false)
    expect(belowFloor('0.9.1', hw('0.9.1'), '0.8.0')).toBe(false)
    expect(belowFloor('0.9.2', hw('0.9.1'), '0.8.0')).toBe(false)
  })

  it('refuses a bundle below either', () => {
    expect(belowFloor('0.9.0', hw('0.9.1'), '0.8.0')).toBe(true)
    expect(belowFloor('0.8.3', null, '0.8.4')).toBe(true)
    expect(belowFloor('0.8.5', hw('0.8.5'), '0.9.0')).toBe(true)
  })

  it('raises the mark only upwards', () => {
    expect(nextHighWater(null, '0.8.0', 'builtin')).toEqual(hw('0.8.0', 'builtin'))
    expect(nextHighWater(hw('0.8.0'), '0.8.1', 'x')).toEqual(hw('0.8.1', 'x'))
    expect(nextHighWater(hw('0.8.1'), '0.8.1', 'y')).toBeNull()
    expect(nextHighWater(hw('0.8.1'), '0.8.0', 'z')).toBeNull()
  })

  it('reads a stored mark or nothing', () => {
    expect(parseHighWater(JSON.stringify(hw('0.8.1')))).toEqual(hw('0.8.1'))
    expect(parseHighWater('{')).toBeNull()
    expect(parseHighWater(JSON.stringify({ version: '0.8.1' }))).toBeNull()
  })

  it('goes back to the bundle the mark ran in while the plugin holds it as good', () => {
    const bundles = [
      { id: 'id-0.9.1', status: 'success' },
      { id: 'old', status: 'pending' },
    ]
    expect(
      revertTarget({ highWater: hw('0.9.1'), bundles, currentId: 'old', builtinVersion: null }),
    ).toEqual({
      kind: 'set',
      id: 'id-0.9.1',
    })
  })

  it('goes back to the built-in bundle when the mark ran there, or when its version reaches the floor', () => {
    expect(
      revertTarget({
        highWater: hw('0.9.1', BUILTIN),
        bundles: [],
        currentId: 'old',
        builtinVersion: null,
      }),
    ).toEqual({ kind: 'reset' })
    expect(
      revertTarget({
        highWater: hw('0.9.1'),
        bundles: [],
        currentId: 'old',
        builtinVersion: '0.9.1',
      }),
    ).toEqual({ kind: 'reset' })
  })

  it('otherwise leaves it to the plugin, never to a bundle marked bad or one too old', () => {
    const bundles = [{ id: 'id-0.9.1', status: 'error' }]
    expect(
      revertTarget({ highWater: hw('0.9.1'), bundles, currentId: 'old', builtinVersion: '0.8.0' }),
    ).toEqual({ kind: 'wait' })
    expect(
      revertTarget({ highWater: null, bundles: [], currentId: 'old', builtinVersion: null }),
    ).toEqual({
      kind: 'wait',
    })
  })

  it('never names a minimum above the app version it ships in', () => {
    const pkg = JSON.parse(
      fs.readFileSync(new URL('../../../mobile/package.json', here), 'utf8'),
    ) as {
      version: string
    }
    expect(compareVersions(MIN_APP_VERSION, pkg.version)).toBeLessThanOrEqual(0)
  })
})

type Fs = { readFileSync(path: URL, encoding: 'utf8'): string }
// As in mobilebundle.test.ts: web/'s tsconfig carries no Node types, and the URL goes through a local.
const fs = (
  globalThis as unknown as { process: { getBuiltinModule(id: 'node:fs'): Fs } }
).process.getBuiltinModule('node:fs')
const here = import.meta.url
