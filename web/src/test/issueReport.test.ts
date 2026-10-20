import { describe, it, expect } from 'vitest'
import {
  brokeBody,
  errorReport,
  fenced,
  ideaBody,
  issueTitle,
  issueUrl,
  MAX_ISSUE_TITLE_CHARS,
  MAX_ISSUE_URL_CHARS,
} from '../lib/issueReport'

const env = { orbital: '0.9.0', runs: 'Desktop app', cli: '1.9.0', os: '15.1' }

describe('the bodies', () => {
  it('an error: kind and message as the title, the record fenced, and the environment', () => {
    const { title, body } = errorReport({ kind: 'api_request', message: 'boom' }, 'line ``` inside', 'orbital 0.9.0')
    expect(title).toBe('API request: boom')
    expect(body).toBe('## What happened\nboom\n\n## Record\n````text\nline ``` inside\n````\n\n## Environment\norbital 0.9.0\n')
  })

  it('something broke: an empty field says so, and an empty environment field is left out', () => {
    const body = brokeBody({ what: 'Panel blank', repro: ' ' }, { ...env, cli: '' })
    expect(body).toContain('## How to reproduce\n_not given_')
    expect(body).toContain('## Environment\nOrbital 0.9.0 · Desktop app · macOS 15.1')
  })

  it('an idea opens with the heading the labelling workflow reads', () => {
    expect(ideaBody({ way: 'w', like: 'l' }).startsWith('## What gets in the way\nw')).toBe(true)
  })
})

describe('issueTitle', () => {
  it('keeps the first line only', () => {
    expect(issueTitle('  boom\n    at x.ts:1')).toBe('boom')
  })

  it('cuts a title GitHub would refuse, without splitting a character', () => {
    const title = issueTitle('😀'.repeat(MAX_ISSUE_TITLE_CHARS + 10))
    expect(Array.from(title)).toHaveLength(MAX_ISSUE_TITLE_CHARS)
    expect(title.endsWith('😀…')).toBe(true)
  })
})

describe('fenced', () => {
  it('uses a fence longer than any backtick run inside', () => {
    expect(fenced('a ```` b')).toBe('`````\na ```` b\n`````')
    expect(fenced('plain', 'text')).toBe('```text\nplain\n```')
  })
})

describe('issueUrl', () => {
  it('fills the title and body as they are when they fit', () => {
    const { url, truncated } = issueUrl('t', 'b')
    expect(truncated).toBe(false)
    const params = new URL(url).searchParams
    expect([params.get('title'), params.get('body')]).toEqual(['t', 'b'])
  })

  it('cuts the record and keeps what comes before and after it whole', () => {
    const record = 'ž/é '.repeat(5000)
    const { body } = errorReport({ kind: 'render_crash', message: 'boom' }, record, 'orbital 0.9.0')
    const { url, truncated } = issueUrl('t', body)
    expect(truncated).toBe(true)
    expect(url.length).toBeLessThanOrEqual(MAX_ISSUE_URL_CHARS)
    const sent = new URL(url).searchParams.get('body')!
    expect(sent.startsWith('## What happened\nboom\n\n## Record\n```text\nž/é ')).toBe(true)
    expect(sent.endsWith('paste it here.\n```\n\n## Environment\norbital 0.9.0\n')).toBe(true)
  })

  it('cuts the end of a body without a record', () => {
    const { url, truncated } = issueUrl('t', ideaBody({ way: 'x'.repeat(9000), like: 'l' }))
    expect(truncated).toBe(true)
    expect(url.length).toBeLessThanOrEqual(MAX_ISSUE_URL_CHARS)
    expect(new URL(url).searchParams.get('body')!.startsWith('## What gets in the way\nxxx')).toBe(true)
  })
})
