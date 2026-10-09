import { beforeEach, describe, expect, it, vi } from 'vitest'
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

  it('of the version already running — a store install offered its own bundle — is taken quietly at the next start', () => {
    expect(
      downloadVerdict({ bundle: b('0.8.0'), running: '0.8.0', answered: null, shown: null }),
    ).toBe('quietly-later')
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

  it('a quiet download of the running version leaves it for the next start without a prompt', () => {
    usePhoneUpdate.getState().downloaded(b('0.8.0'), '0.8.0')
    expect(usePhoneUpdate.getState().shown).toBeNull()
    expect(source.later).toHaveBeenCalledWith(b('0.8.0'))
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
