import { describe, expect, it } from 'vitest'
import { TunnelError } from '@orbital/shared/remote/client'
import { ApiError } from '../lib/api'
import { DEFAULT_HARNESS_OPTIONS, type HarnessTemplate, type OrbitalModel, type SessionDefaults } from '../lib/types'
import {
  harnessLaunch,
  harnessStartBlock,
  launchRequest,
  noSuchDirectory,
  offersHarness,
  templateSheetLines,
  preselectClaudeDir,
  preselectMode,
  preselectModel,
  startFailureLine,
} from '../mobile/newSession'
import type { DirectoryRow } from '../lib/directorySearch'

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

const template = (id: number, patch: Partial<HarnessTemplate> = {}): HarnessTemplate => ({
  id,
  name: `T${id}`,
  description: '',
  tags: [],
  inputs: [],
  steps: [],
  options: DEFAULT_HARNESS_OPTIONS,
  scope: { kind: 'global' },
  draft: false,
  createdAt: 0,
  updatedAt: 0,
  ...patch,
})

describe('offersHarness', () => {
  const on = { harness_enabled: 'true' }

  it('offers With harness… only from a Mac that accepts a harness on launch', () => {
    expect(offersHarness(on, '0.49.0')).toBe(true)
    expect(offersHarness(on, '0.48.9')).toBe(false)
    // No hello yet: nothing is asked of a device not yet known.
    expect(offersHarness(on, null)).toBe(false)
  })

  it('needs the Harness switch on', () => {
    expect(offersHarness({}, '0.49.0')).toBe(false)
    expect(offersHarness({ harness_enabled: 'false' }, '0.49.0')).toBe(false)
  })
})

describe('harnessStartBlock', () => {
  const task = template(1, { inputs: [{ key: 'task', label: 'Task link', hint: 'Linear or GitHub issue' }] })

  it('names the empty required input in the button', () => {
    expect(harnessStartBlock({ templates: [task], template: task, inputs: {} })).toBe('Add a task link to start')
    expect(harnessStartBlock({ templates: [task], template: task, inputs: { task: '   ' } })).toBe('Add a task link to start')
    expect(harnessStartBlock({ templates: [task], template: task, inputs: { task: 'ORB-412' } })).toBeNull()
  })

  it('skips an input whose hint says optional, and keeps an acronym', () => {
    const t = template(2, {
      inputs: [
        { key: 'note', label: 'Notes', hint: 'optional' },
        { key: 'pr', label: 'PR URL' },
        { key: 'area', label: 'Area' },
      ],
    })
    expect(harnessStartBlock({ templates: [t], template: t, inputs: {} })).toBe('Add a PR URL to start')
    expect(harnessStartBlock({ templates: [t], template: t, inputs: { pr: 'x' } })).toBe('Add an area to start')
  })

  it('says there is nothing to start with when no template is offered', () => {
    expect(harnessStartBlock({ templates: [], template: null, inputs: {} })).toBe('No template to start with')
    expect(harnessStartBlock({ templates: [task], template: null, inputs: {} })).toBe('Pick a template to start')
  })
})

describe('launchRequest with a harness', () => {
  const base = { cwd: '~/web', prompt: '', files: [], mode: 'acceptEdits' as const, model: null, claudeDirId: null, refs: [], machine: 'build' }

  it('carries the harness, the template inputs only, with an empty prompt', () => {
    const t = template(7, { inputs: [{ key: 'task', label: 'Task link' }] })
    const body = launchRequest({ ...base, harness: harnessLaunch(t, { task: ' ORB-412 ', stale: 'x' }, true) })
    expect(body).toMatchObject({ prompt: '', machine: 'build', harness: { templateId: 7, inputs: { task: 'ORB-412' }, lucky: true } })
  })

  it('leaves the field out of a plain launch', () => {
    expect(launchRequest(base)).not.toHaveProperty('harness')
  })
})

describe('templateSheetLines', () => {
  const project = { root: '/w/orbital', name: 'orbital' }
  const own = template(1, { name: 'Fix a bug', scope: { kind: 'project', root: '/w/orbital', name: 'orbital' } })
  const global = template(2, { name: 'Release' })

  it("lists this project's templates first, then the global ones, under their captions", () => {
    const lines = templateSheetLines([global, own], project, 1, '')
    expect(lines.map((l) => (l.kind === 'caption' ? l.label : l.template.id))).toEqual(['ORBITAL · THIS PROJECT', 1, 'GLOBAL', 2])
    expect(lines[1]).toMatchObject({ meta: '0 steps · 0 gates · last used here' })
  })

  it('drops a group the search empties', () => {
    expect(templateSheetLines([global, own], project, null, 'rel').map((l) => (l.kind === 'caption' ? l.label : l.template.id))).toEqual([
      'GLOBAL',
      2,
    ])
  })
})
