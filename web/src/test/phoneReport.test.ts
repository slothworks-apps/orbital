import { describe, it, expect } from 'vitest'
import { ISSUE_REPO_URL, issueUrl, phoneReport } from '../lib/issueReport'

const env = { app: '0.16.0', os: 'iOS 18.1', model: 'iPhone15,4' }

function form(kind: 'broke' | 'idea', facts = env) {
  const { title, body } = phoneReport(kind, facts)
  const url = new URL(issueUrl(title, body).url)
  return { url, title: url.searchParams.get('title'), body: url.searchParams.get('body') ?? '' }
}

describe('the phone report', () => {
  it('something broke: an empty title, the bug headings and the phone in the environment', () => {
    const { url, title, body } = form('broke')
    expect(`${url.origin}${url.pathname}`).toBe(`${ISSUE_REPO_URL}/issues/new`)
    expect(title).toBe('')
    expect(body).toContain('## What happened\n')
    expect(body).toContain('## How to reproduce\n')
    expect(body).toContain('## Environment\nOrbital mobile 0.16.0 · iOS 18.1 · iPhone15,4\n')
    expect(body).not.toContain('macOS')
    expect(body).not.toContain('Claude Code')
  })

  it('a model the system does not report is left out, not left blank', () => {
    const { body } = form('broke', { ...env, os: 'Android 15', model: '' })
    expect(body).toContain('## Environment\nOrbital mobile 0.16.0 · Android 15\n')
  })

  it('an idea: an empty title and the feature-request headings, no environment', () => {
    const { title, body } = form('idea')
    expect(title).toBe('')
    expect(body).toContain('## What gets in the way\n')
    expect(body).toContain('## What I would like\n')
    expect(body).not.toContain('## Environment')
  })

  it('leaves the sections empty to type in on GitHub, not marked as not given', () => {
    expect(phoneReport('idea', { app: '1.0.0', os: 'iOS 18.1', model: '' }).body).toBe('## What gets in the way\n\n\n## What I would like\n\n')
  })
})
