import { describe, expect, it } from 'vitest'
import { TunnelError } from '@orbital/shared/remote/client'
import { ApiError } from '../lib/api'
import type { OrbitalModel, SessionDefaults } from '../lib/types'
import {
  RECENT_DIRECTORIES,
  filterDirectories,
  isTypedPath,
  noSuchDirectory,
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

describe('filterDirectories', () => {
  const twelve = Array.from({ length: 12 }, (_, i) => row(`/w/p${i}`, 100 - i))

  it('lists the most recent directories for an empty or blank query', () => {
    expect(filterDirectories(twelve, '')).toEqual({ kind: 'rows', rows: twelve.slice(0, RECENT_DIRECTORIES) })
    expect(filterDirectories(twelve, '   ')).toEqual({ kind: 'rows', rows: twelve.slice(0, RECENT_DIRECTORIES) })
  })

  it('finds every directory with a path segment containing the query, case-insensitive, in the input order', () => {
    const projects = [row('/w/auth-service'), row('/w/web'), row('/w/x/AUTH'), row('/w/author'), row('/w/oauth/web')]
    expect(filterDirectories(projects, ' auth ')).toEqual({
      kind: 'rows',
      rows: [row('/w/auth-service'), row('/w/x/AUTH'), row('/w/author'), row('/w/oauth/web')],
    })
  })

  it('does not match across a segment boundary unless the query is a prefix of the full path', () => {
    expect(filterDirectories([row('/w/x')], 'w/x')).toEqual({ kind: 'no-match', query: 'w/x' })
  })

  it('matches a full-path prefix', () => {
    const projects = [row('~/lab/voice-notes'), row('~/other/lab')]
    expect(filterDirectories(projects, '~/lab')).toEqual({ kind: 'rows', rows: [row('~/lab/voice-notes')] })
  })

  it('offers a typed path that matches nothing as is', () => {
    expect(filterDirectories([row('/w/web')], ' /nowhere ')).toEqual({ kind: 'use-as-is', path: '/nowhere' })
    expect(filterDirectories([], '~/new')).toEqual({ kind: 'use-as-is', path: '~/new' })
  })

  it('says nothing matches for other text', () => {
    expect(filterDirectories([row('/w/web')], 'zzz')).toEqual({ kind: 'no-match', query: 'zzz' })
  })

  it('lists a typed path that names a known directory as a row', () => {
    expect(filterDirectories([row('/w/web'), row('/w/api')], '/w/web')).toEqual({ kind: 'rows', rows: [row('/w/web')] })
  })
})

describe('isTypedPath', () => {
  it('is a path from ~/ or /, after trimming', () => {
    expect(isTypedPath(' ~/lab')).toBe(true)
    expect(isTypedPath('/Users')).toBe(true)
    expect(isTypedPath('~')).toBe(false)
    expect(isTypedPath('lab/x')).toBe(false)
    expect(isTypedPath('')).toBe(false)
  })
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
