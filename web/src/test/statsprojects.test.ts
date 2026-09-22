import { describe, it, expect } from 'vitest'
import { projectDirFor, projectOptions } from '../stats/projects'

describe('projectDirFor', () => {
  it('encodes a cwd the way the CLI names its transcript directory', () => {
    expect(projectDirFor('/Users/t/Projects/orbital')).toBe('-Users-t-Projects-orbital')
  })

  it('replaces every character that is not a letter or a digit', () => {
    // A dotted directory and a dot-prefixed one are both real: `slothworks.io`
    // and `<repo>/.claude/worktrees/<name>`.
    expect(projectDirFor('/Users/t/Projects/slothworks.io')).toBe(
      '-Users-t-Projects-slothworks-io'
    )
    expect(projectDirFor('/Users/t/orbital/.claude/worktrees/stats')).toBe(
      '-Users-t-orbital--claude-worktrees-stats'
    )
    expect(projectDirFor('/tmp/my_project (2)')).toBe('-tmp-my-project--2-')
  })
})

describe('projectOptions', () => {
  const projects = [{ cwd: '/Users/t/Projects/orbital' }, { cwd: '/Users/t/Projects/api' }]

  it('offers "all" first, then one option per project, valued by transcript directory', () => {
    const options = projectOptions(projects)
    expect(options[0]).toMatchObject({ value: '' })
    expect(options.map((o) => o.value)).toContain('-Users-t-Projects-orbital')
  })

  it('counts the projects in the "all" label, as the filter bar reads it', () => {
    expect(projectOptions(projects)[0].label).toBe('all (2)')
    expect(projectOptions([])[0].label).toBe('all')
  })

  it('labels a project by its readable path, never by the encoded directory', () => {
    const option = projectOptions(projects).find(
      (o) => o.value === '-Users-t-Projects-orbital'
    )
    expect(option?.label).not.toContain('-Users')
    expect(option?.label).toContain('orbital')
  })
})
