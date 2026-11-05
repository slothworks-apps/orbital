import { describe, expect, it } from 'vitest'
import {
  deliverTarget,
  isLastFocusedWindow,
  outcomeFor,
  parseLastFocused,
  parseSentBrowserSelection,
  promptWithBrowserSelection,
} from '../lib/browserBridge'
import { IDE_SELECTION_MAX_CHARS, parseSentSelection, promptWithOpenFile, promptWithSelection } from '../lib/ideSelection'
import { MAX_ATTACHMENTS } from '../lib/attachments'

/** The browser bridge's block and its delivery rules (spec 2026-11-05-browser-bridge-design). */

const page = { title: 'Technical spec: Billing v2', url: 'https://app.clickup.com/t/86c1', text: 'selected text' }

describe('promptWithBrowserSelection', () => {
  it('writes the head, the fenced text and the typed words after', () => {
    expect(promptWithBrowserSelection('is this consistent?', page)).toBe(
      [
        'Selected in the browser — Technical spec: Billing v2 (https://app.clickup.com/t/86c1):',
        '',
        '```',
        'selected text',
        '```',
        '',
        'is this consistent?',
      ].join('\n'),
    )
  })

  it('fences longer than any backtick run in the text', () => {
    const prompt = promptWithBrowserSelection('', { ...page, text: 'a\n`````\nb' })
    expect(prompt.split('\n')[2]).toBe('``````')
  })

  it('cuts at the editor cap and says so', () => {
    const prompt = promptWithBrowserSelection('q', { ...page, text: 'x'.repeat(IDE_SELECTION_MAX_CHARS + 50) })
    expect(prompt).toContain(`${'x'.repeat(IDE_SELECTION_MAX_CHARS)}\n… (selection truncated)\n\`\`\``)
    expect(prompt).not.toContain('x'.repeat(IDE_SELECTION_MAX_CHARS + 1))
  })

  it('keeps a title with newlines on the head line and names an untitled page by its URL', () => {
    expect(promptWithBrowserSelection('', { ...page, title: 'Two\n  lines' }).split('\n')[0]).toBe(
      'Selected in the browser — Two lines (https://app.clickup.com/t/86c1):',
    )
    expect(promptWithBrowserSelection('', { ...page, title: '  ' }).split('\n')[0]).toBe(
      'Selected in the browser — https://app.clickup.com/t/86c1 (https://app.clickup.com/t/86c1):',
    )
  })
})

describe('parseSentBrowserSelection', () => {
  const roundTrip = (over: Partial<typeof page>, typed = 'what is this?') =>
    parseSentBrowserSelection(promptWithBrowserSelection(typed, { ...page, ...over }))

  it('reads back the title, the URL, the count and the typed words', () => {
    expect(roundTrip({})).toEqual({
      title: page.title,
      url: page.url,
      chars: page.text.length,
      text: 'what is this?',
    })
  })

  it('reads a title that carries parentheses and a URL that does', () => {
    const parsed = roundTrip({ title: 'Docs (beta) — API (v2)', url: 'https://en.wikipedia.org/wiki/Foo_(bar)' })
    expect(parsed?.title).toBe('Docs (beta) — API (v2)')
    expect(parsed?.url).toBe('https://en.wikipedia.org/wiki/Foo_(bar)')
  })

  it('reads fenced markdown inside the selection without ending early', () => {
    const parsed = roundTrip({ text: '```js\nconst a = 1\n```' }, 'explain')
    expect(parsed?.text).toBe('explain')
    expect(parsed?.chars).toBe('```js\nconst a = 1\n```'.length)
  })

  it('reads an empty selection and a turn with no typed words', () => {
    expect(roundTrip({ text: '' }, '')).toMatchObject({ chars: 0, text: '' })
  })

  it('is null for a turn that does not open with the block', () => {
    expect(parseSentBrowserSelection('hello')).toBeNull()
    expect(parseSentBrowserSelection('Selected in the browser — no fence here')).toBeNull()
    expect(parseSentBrowserSelection(null)).toBeNull()
  })

  it('reads behind the editor block, which rides first', () => {
    const sent = promptWithSelection(
      promptWithBrowserSelection('both?', page),
      '/p',
      { filePath: '/p/a.ts', lineStart: 1, lineCount: 2, text: 'x\ny' },
    )
    const ide = parseSentSelection(sent)
    expect(ide?.path).toBe('a.ts')
    expect(parseSentBrowserSelection(ide?.text)?.text).toBe('both?')
  })

  it('reads behind the open-file sentence', () => {
    const sent = promptWithOpenFile(promptWithBrowserSelection('hm', page), '/p', '/p/a.ts')
    const rest = sent.slice(sent.indexOf('Selected in the browser'))
    expect(parseSentBrowserSelection(rest)?.text).toBe('hm')
  })
})

describe('the last-focused window', () => {
  const self = { windowId: 'w1', isMainWindow: false }

  it('answers when it wrote the record, and only then', () => {
    expect(isLastFocusedWindow({ windowId: 'w1', at: 1 }, self)).toBe(true)
    expect(isLastFocusedWindow({ windowId: 'w2', at: 1 }, self)).toBe(false)
  })

  it('falls to the main window when no window holds the record', () => {
    expect(isLastFocusedWindow(null, self)).toBe(false)
    expect(isLastFocusedWindow(null, { ...self, isMainWindow: true })).toBe(true)
  })

  it('reads a malformed record as none', () => {
    expect(parseLastFocused('{"windowId":"w1","at":5}')).toEqual({ windowId: 'w1', at: 5 })
    expect(parseLastFocused('not json')).toBeNull()
    expect(parseLastFocused('{"windowId":"","at":5}')).toBeNull()
    expect(parseLastFocused(null)).toBeNull()
  })
})

describe('deliverTarget', () => {
  const base = {
    isLastFocusedWindow: true,
    openSessionId: 's1',
    sessionIsForeign: false,
    kind: 'browser_selection' as const,
    attachmentCount: 0,
  }

  it('stays silent in a window that was not focused last', () => {
    expect(deliverTarget({ ...base, isLastFocusedWindow: false })).toBeNull()
  })

  it('reaches the open session', () => {
    expect(deliverTarget(base)).toEqual({ sessionId: 's1' })
  })

  it('drops with no session open, and for a session on another Mac', () => {
    expect(deliverTarget({ ...base, openSessionId: null })).toEqual({ drop: 'no-session' })
    expect(deliverTarget({ ...base, sessionIsForeign: true })).toEqual({ drop: 'foreign' })
  })

  it('drops a screenshot on a full composer, never a selection', () => {
    const full = { ...base, attachmentCount: MAX_ATTACHMENTS }
    expect(deliverTarget({ ...full, kind: 'browser_screenshot' })).toEqual({ drop: 'composer-full' })
    expect(deliverTarget(full)).toEqual({ sessionId: 's1' })
    expect(deliverTarget({ ...base, kind: 'browser_screenshot', attachmentCount: MAX_ATTACHMENTS - 1 })).toEqual({
      sessionId: 's1',
    })
  })

  it('answers the server in the outcome shape', () => {
    expect(outcomeFor('e1', { sessionId: 's1' })).toEqual({ eventId: 'e1', delivered: true, sessionId: 's1' })
    expect(outcomeFor('e1', { drop: 'foreign' })).toEqual({ eventId: 'e1', delivered: false, reason: 'foreign' })
  })
})
