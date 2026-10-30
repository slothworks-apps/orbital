import { describe, expect, it } from 'vitest'
import { TunnelError } from '@orbital/shared/remote/client'
import { ApiError } from '../lib/api'
import type { OrbitalModel, SessionDefaults } from '../lib/types'
import {
  noSuchDirectory,
  preselectClaudeDir,
  preselectMode,
  preselectModel,
  startFailureLine,
  type DirectoryRow,
} from '../mobile/newSession'

const row = (cwd: string, lastAt = 0, lastModel: string | null = null): DirectoryRow => ({ cwd, lastModel, lastAt })

const model = (value: string, resolvedModel: string): OrbitalModel => ({
  value,
  resolvedModel,
  family: 'x',
  version: '1',
  shortVersion: value,
  variant: null,
  blurb: '',
  contextWindow: null,
})

const MODELS = [model('opus', 'claude-opus-5'), model('sonnet', 'claude-sonnet-5'), model('haiku', 'claude-haiku-5')]

const defaults = (patch: Partial<SessionDefaults> = {}): SessionDefaults => ({
  permissionMode: 'acceptEdits',
  model: null,
  rememberModelPerProject: true,
  ...patch,
})

describe('preselectModel', () => {
  const project = row('/w/web', 1, 'claude-haiku-5')

  it("takes the directory's last model when the flag is on", () => {
    expect(preselectModel({ defaults: defaults({ model: 'sonnet' }), project, models: MODELS })).toBe('haiku')
  })

  it('takes the default when the flag is off, the directory has no last model, or it names no catalog row', () => {
    expect(
      preselectModel({ defaults: defaults({ model: 'sonnet', rememberModelPerProject: false }), project, models: MODELS }),
    ).toBe('sonnet')
    expect(preselectModel({ defaults: defaults({ model: 'sonnet' }), project: row('/w/api'), models: MODELS })).toBe('sonnet')
    expect(preselectModel({ defaults: defaults({ model: 'sonnet' }), project: undefined, models: MODELS })).toBe('sonnet')
    expect(
      preselectModel({ defaults: defaults({ model: 'sonnet' }), project: row('/w/x', 1, 'gone'), models: MODELS }),
    ).toBe('sonnet')
  })

  it('falls back to the first model, and to null with no catalog', () => {
    expect(preselectModel({ defaults: defaults({ model: 'unknown' }), project: undefined, models: MODELS })).toBe('opus')
    expect(preselectModel({ defaults: defaults(), project: undefined, models: [] })).toBeNull()
  })
})

describe('preselectMode', () => {
  it('never preselects bypassPermissions', () => {
    expect(preselectMode(defaults({ permissionMode: 'bypassPermissions' }))).toBe('acceptEdits')
    expect(preselectMode(defaults({ permissionMode: 'plan' }))).toBe('plan')
  })
})

describe('preselectClaudeDir', () => {
  const claudeDirs = [
    { id: 1, name: 'Personal' },
    { id: 2, name: 'Work' },
  ]

  it("opens on the last launch's directory, else the Mac's default", () => {
    expect(preselectClaudeDir(defaults({ claudeDirs, defaultClaudeDir: 1, lastClaudeDir: 2 }))).toBe(2)
    expect(preselectClaudeDir(defaults({ claudeDirs, defaultClaudeDir: 2, lastClaudeDir: null }))).toBe(2)
  })

  it('lets a removed directory fall through', () => {
    expect(preselectClaudeDir(defaults({ claudeDirs, defaultClaudeDir: 1, lastClaudeDir: 9 }))).toBe(1)
  })

  it('has none from a Mac from before directories', () => {
    expect(preselectClaudeDir(defaults())).toBeNull()
  })
})

describe('noSuchDirectory', () => {
  it("is the route's 400 no_such_directory and nothing else", () => {
    const body = JSON.stringify({ error: 'no_such_directory' })
    expect(noSuchDirectory(new ApiError(body, 400))).toBe(true)
    expect(noSuchDirectory(new ApiError(body, 500))).toBe(false)
    expect(noSuchDirectory(new ApiError(JSON.stringify({ error: 'bad_request' }), 400))).toBe(false)
    expect(noSuchDirectory(new ApiError('Bad Request', 400))).toBe(false)
    expect(noSuchDirectory(new Error(body))).toBe(false)
  })
})

describe('startFailureLine', () => {
  it('words a refused Start as one sentence, the reason humanised', () => {
    expect(startFailureLine(new ApiError(JSON.stringify({ error: 'bad_request' }), 400), 'studio')).toBe(
      "Couldn't start the session — bad request.",
    )
    expect(startFailureLine(new TunnelError('lost'), 'studio')).toBe(
      "Couldn't start the session — studio is unreachable — try again.",
    )
  })

  it('says something even for an error with no words', () => {
    expect(startFailureLine(new ApiError('', 500), null)).toBe("Couldn't start the session — HTTP 500.")
    expect(startFailureLine('boom', null)).toBe("Couldn't start the session — boom.")
  })
})
