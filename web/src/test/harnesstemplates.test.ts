import { describe, expect, it } from 'vitest'
import {
  defaultScope,
  filterPickerSessions,
  groupTemplates,
  inputUsage,
  keyedParts,
  projectOfCwd,
  ranAgo,
  stepsSummary,
} from '../panels/harnessTemplates/logic'
import { DEFAULT_HARNESS_OPTIONS, type HarnessStep, type HarnessTemplate } from '../lib/types'

const step = (over: Partial<HarnessStep>): HarnessStep => ({
  id: 's', title: '', instructions: '', mode: 'auto', doneWhen: '', ...over,
})

describe('inputUsage', () => {
  it('finds unused inputs and unknown keys across title, instructions, done when and verify', () => {
    const usage = inputUsage(
      [{ key: 'component', label: '' }, { key: 'figma', label: '' }, { key: 'callsites', label: '' }, { key: ' ', label: '' }],
      [
        step({ title: 'Build {{component}}', instructions: 'from {{ figma }}' }),
        step({ doneWhen: 'see {{compnent}}', verify: 'rg {{call-sites}}' }),
      ],
    )
    expect([...usage.unused]).toEqual(['callsites'])
    expect([...usage.unknown].sort()).toEqual(['call-sites', 'compnent'])
  })

  it('does not take single braces or empty braces for keys', () => {
    const usage = inputUsage([], [step({ instructions: 'a {component} and {{}} and {{ two words }}' })])
    expect(usage.unknown.size).toBe(0)
  })
})

describe('keyedParts', () => {
  it('cuts text into runs and marks the keys no input defines', () => {
    expect(keyedParts('Load {{a}} from {{b}}.', new Set(['a']))).toEqual([
      { text: 'Load ' },
      { text: '{{a}}', key: 'a', unknown: false },
      { text: ' from ' },
      { text: '{{b}}', key: 'b', unknown: true },
      { text: '.' },
    ])
    expect(keyedParts('', new Set())).toEqual([])
  })
})

describe('stepsSummary', () => {
  it('counts steps and gates in words', () => {
    expect(stepsSummary([step({}), step({ mode: 'gate' })])).toBe('2 steps · 1 gate')
    expect(stepsSummary([step({})])).toBe('1 step')
    expect(stepsSummary([step({ mode: 'gate' }), step({ mode: 'gate' })])).toBe('2 steps · 2 gates')
  })
})

describe('projectOfCwd', () => {
  const projects = [
    { root: '/w/orbital', name: 'orbital' },
    { root: '/w/orbital/packages/ui', name: 'ui' },
    { root: '/w/orb', name: 'orb' },
  ]
  it('takes the longest root the directory sits in', () => {
    expect(projectOfCwd('/w/orbital/.claude/worktrees/x', projects)).toEqual({ root: '/w/orbital', name: 'orbital' })
    expect(projectOfCwd('/w/orbital/packages/ui/src', projects)).toEqual({ root: '/w/orbital/packages/ui', name: 'ui' })
    expect(projectOfCwd('/w/orbital/', projects)).toEqual({ root: '/w/orbital', name: 'orbital' })
  })
  it('does not match a root that is only a string prefix', () => {
    expect(projectOfCwd('/w/orbit', projects)).toEqual({ root: null, name: 'orbit' })
    expect(projectOfCwd('/w/orbital-2/src', projects)).toEqual({ root: null, name: 'src' })
  })
})

describe('defaultScope', () => {
  const projects = [{ root: '/w/orbital', name: 'orbital', lastAt: 1, templates: 0 }]
  it('prefers the filter, then the session you came from, then Global', () => {
    const here = projectOfCwd('/w/orbital/src', projects)
    expect(defaultScope({ kind: 'project', root: '/w/orbital' }, { root: '/x', name: 'x' }, projects)).toEqual({ kind: 'project', root: '/w/orbital', name: 'orbital' })
    expect(defaultScope({ kind: 'all' }, here, projects)).toEqual({ kind: 'project', root: '/w/orbital', name: 'orbital' })
    expect(defaultScope({ kind: 'global' }, projectOfCwd('/w/elsewhere', projects), projects)).toEqual({ kind: 'global' })
    expect(defaultScope({ kind: 'all' }, null, projects)).toEqual({ kind: 'global' })
  })
})

describe('groupTemplates', () => {
  let id = 0
  const tpl = (name: string, scope: HarnessTemplate['scope']): HarnessTemplate => ({
    id: ++id, name, description: '', tags: [], inputs: [], steps: [], options: DEFAULT_HARNESS_OPTIONS,
    scope, draft: false, createdAt: 0, updatedAt: 0,
  })
  const all = [
    tpl('b', { kind: 'project', root: '/w/zeta', name: 'zeta' }),
    tpl('z', { kind: 'global' }),
    tpl('a', { kind: 'global' }),
    tpl('c', { kind: 'project', root: '/w/alpha', name: 'alpha' }),
  ]
  it('puts global first, then projects A→Z, names A→Z inside', () => {
    expect(groupTemplates(all, { kind: 'all' }).map((g) => [g.heading, g.templates.map((t) => t.name)])).toEqual([
      ['GLOBAL · OFFERED IN EVERY PROJECT', ['a', 'z']],
      ['PROJECT · ALPHA', ['c']],
      ['PROJECT · ZETA', ['b']],
    ])
  })
  it('narrows to the filter', () => {
    expect(groupTemplates(all, { kind: 'global' }).map((g) => g.key)).toEqual(['global'])
    expect(groupTemplates(all, { kind: 'project', root: '/w/zeta' }).map((g) => g.key)).toEqual(['project:/w/zeta'])
  })
})

describe('ranAgo', () => {
  const now = 1_000_000_000_000
  it('reads as 30l writes it', () => {
    expect(ranAgo(now - 3 * 3600_000, now)).toBe('ran 3 h ago')
    expect(ranAgo(now - 2 * 86_400_000, now)).toBe('ran 2 d ago')
    expect(ranAgo(now - 21 * 86_400_000, now)).toBe('ran 3 wk ago')
    expect(ranAgo(now - 31 * 86_400_000 * 2, now)).toBe('ran 2 mo ago')
    expect(ranAgo(now + 5000, now)).toBe('ran just now')
  })
})

describe('filterPickerSessions', () => {
  const rows = [
    { id: '1', title: 'Tooltip in apps/web', project: 'orbital', tags: [{ name: 'work', hue: 210 }], lastAt: 1 },
    { id: '2', title: 'Token refresh', project: 'auth-service', tags: [], lastAt: 3 },
    { id: '3', title: 'Recipe import', project: 'recipe-app', tags: [{ name: 'personal', hue: 330 }], lastAt: null },
  ]
  it('sorts by last run and matches title, project and tag', () => {
    expect(filterPickerSessions(rows, '').map((r) => r.id)).toEqual(['2', '1', '3'])
    expect(filterPickerSessions(rows, 'WORK').map((r) => r.id)).toEqual(['1'])
    expect(filterPickerSessions(rows, 'auth token').map((r) => r.id)).toEqual(['2'])
    expect(filterPickerSessions(rows, 'recipe personal').map((r) => r.id)).toEqual(['3'])
  })
})
