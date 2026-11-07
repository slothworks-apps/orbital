import { describe, expect, it } from 'vitest'
import {
  composerSendable,
  deliverTarget,
  needsRecordAlive,
  outcomeFor,
  parseLastFocused,
  parseSentBrowserScreenshots,
  screenshotLineBudget,
  userTurnImageCounts,
  windowActs,
  parseSentBrowserSelection,
  parseToolScreenshotPage,
  promptWithBrowserScreenshots,
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

describe('promptWithBrowserScreenshots', () => {
  const shot = { title: 'Onboarding — Summary', url: 'http://localhost:5173/onboarding/summary' }

  it('names each page on a line before the typed words, and reads them back', () => {
    const prompt = promptWithBrowserScreenshots('same on the summary step', [shot, { title: '', url: 'https://x.test/a b' }])
    expect(prompt).toBe(
      'Screenshot of Onboarding — Summary — http://localhost:5173/onboarding/summary\n' +
        'Screenshot of https://x.test/a b — https://x.test/ab\n\nsame on the summary step',
    )
    expect(parseSentBrowserScreenshots(prompt, 2)).toEqual({
      shots: [
        { title: 'Onboarding — Summary', url: 'http://localhost:5173/onboarding/summary' },
        { title: 'https://x.test/a b', url: 'https://x.test/ab' },
      ],
      text: 'same on the summary step',
    })
  })

  it('reads an image-only turn, and leaves a prompt with no screenshot as it is', () => {
    expect(parseSentBrowserScreenshots(promptWithBrowserScreenshots('', [shot]), 1)).toEqual({ shots: [shot], text: '' })
    expect(promptWithBrowserScreenshots('hello', [])).toBe('hello')
  })

  it('reads behind a browser selection, which rides first', () => {
    const prompt = promptWithBrowserSelection(promptWithBrowserScreenshots('look', [shot]), page)
    const selection = parseSentBrowserSelection(prompt)
    expect(parseSentBrowserScreenshots(selection!.text, 1)).toEqual({ shots: [shot], text: 'look' })
  })

  it('is null for words that only start the same way', () => {
    expect(parseSentBrowserScreenshots('Screenshot of the login page please', 1)).toBeNull()
    expect(parseSentBrowserScreenshots('Screenshot of X — https://x.test/\nand more on the next line', 1)).toBeNull()
  })

  it('reads the line as typed in a turn that carried no screenshot', () => {
    expect(parseSentBrowserScreenshots('Screenshot of X — https://x.test/', 0)).toBeNull()
  })

  it('reads only as many lines as the turn carried screenshots', () => {
    const typed = 'Screenshot of Y — https://y.test/'
    const prompt = promptWithBrowserScreenshots(typed, [shot])
    expect(parseSentBrowserScreenshots(prompt, 1)).toEqual({ shots: [shot], text: typed })
    // Two lines in a row, one screenshot: the second is not a blank line, so
    // the first cannot be the caption block either.
    expect(parseSentBrowserScreenshots(`${prompt.split('\n')[0]}\n${typed}`, 1)).toBeNull()
  })
})

describe('screenshotLineBudget', () => {
  const image = (ref: string) => ({ ref, w: 1, h: 1, bytes: 1 })

  it('counts the browser screenshots of a turn this tab sent, not a pasted image beside them', () => {
    const message = {
      images: [image('a'), image('b')],
      imageProvenance: {
        a: { name: 'Spec', source: 'file' as const, fromBrowser: true as const },
        b: { name: 'paste.png', source: 'clipboard' as const },
      },
    }
    expect(screenshotLineBudget(message, undefined)).toBe(1)
  })

  it('counts the images of the entry for a turn read back, its own when it has no entry', () => {
    expect(screenshotLineBudget({}, 2)).toBe(2)
    expect(screenshotLineBudget({ images: [image('a')] }, undefined)).toBe(1)
    expect(screenshotLineBudget({}, undefined)).toBe(0)
  })

  it('adds up the images the CLI split off a turn, by its uuid', () => {
    const counts = userTurnImageCounts([
      { role: 'user', uuid: 'u1', images: [] },
      { role: 'user', uuid: 'u1', images: [image('a')] },
      { role: 'user', uuid: 'u1', images: [image('b')] },
      { role: 'assistant', uuid: 'u2', images: [image('c')] },
      { role: 'user', images: [image('d')] },
    ])
    expect([...counts]).toEqual([['u1', 2]])
  })
})

describe('composerSendable', () => {
  it('sends typed words, an armed chip, or a browser selection on its own', () => {
    expect(composerSendable({ text: '  ', armed: false, browserSelection: false })).toBe(false)
    expect(composerSendable({ text: 'hi', armed: false, browserSelection: false })).toBe(true)
    expect(composerSendable({ text: '', armed: true, browserSelection: false })).toBe(true)
    expect(composerSendable({ text: '', armed: false, browserSelection: true })).toBe(true)
  })
})

describe('parseToolScreenshotPage', () => {
  it('reads the page off the tool result, untitled and URL-less pages included', () => {
    expect(parseToolScreenshotPage('The active tab: Issue #1288 — acme/web — https://github.com/acme/web/issues/1288')).toEqual({
      title: 'Issue #1288 — acme/web',
      url: 'https://github.com/acme/web/issues/1288',
    })
    expect(parseToolScreenshotPage('The active tab: (untitled) — (no URL)')).toEqual({ title: '', url: '' })
    expect(parseToolScreenshotPage('No browser is connected to Orbital.')).toBeNull()
  })
})

describe('the window that answers', () => {
  const detached = { windowId: 'w1', isMainWindow: false, shown: true }
  const main = { windowId: 'm', isMainWindow: true, shown: true }
  const mine = { windowId: 'w1', at: 1 }
  const other = { windowId: 'w2', at: 1 }

  it('answers when it wrote the record, and only then', () => {
    expect(windowActs({ record: mine, self: detached, recordAlive: true })).toBe(true)
    expect(windowActs({ record: other, self: detached, recordAlive: true })).toBe(false)
    expect(windowActs({ record: other, self: main, recordAlive: true })).toBe(false)
  })

  it('falls to the main window when no window holds the record', () => {
    expect(windowActs({ record: null, self: detached, recordAlive: true })).toBe(false)
    expect(windowActs({ record: null, self: main, recordAlive: true })).toBe(true)
  })

  it('falls to the main window when the record was left by a window that is gone', () => {
    expect(windowActs({ record: other, self: main, recordAlive: false })).toBe(true)
    expect(windowActs({ record: other, self: detached, recordAlive: false })).toBe(false)
  })

  it('never answers while hidden or minimised, its own record or the fallback', () => {
    expect(windowActs({ record: mine, self: { ...detached, shown: false }, recordAlive: true })).toBe(false)
    expect(windowActs({ record: null, self: { ...main, shown: false }, recordAlive: true })).toBe(false)
    expect(windowActs({ record: other, self: { ...main, shown: false }, recordAlive: false })).toBe(false)
  })

  it('asks whether the record is alive only where the answer can change it', () => {
    expect(needsRecordAlive(other, main)).toBe(true)
    expect(needsRecordAlive({ windowId: 'm', at: 1 }, main)).toBe(false)
    expect(needsRecordAlive(null, main)).toBe(false)
    expect(needsRecordAlive(other, detached)).toBe(false)
    expect(needsRecordAlive(other, { ...main, shown: false })).toBe(false)
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
    windowActs: true,
    openSessionId: 's1',
    sessionIsForeign: false,
    readOnly: false,
    kind: 'browser_selection' as const,
    attachmentCount: 0,
  }

  it('stays silent in a window that was not focused last', () => {
    expect(deliverTarget({ ...base, windowActs: false })).toBeNull()
  })

  it('reaches the open session', () => {
    expect(deliverTarget(base)).toEqual({ sessionId: 's1' })
  })

  it('drops with no session open, and for a session on another Mac', () => {
    expect(deliverTarget({ ...base, openSessionId: null })).toEqual({ drop: 'no-session' })
    expect(deliverTarget({ ...base, sessionIsForeign: true })).toEqual({ drop: 'foreign' })
  })

  it('drops for a session shown without a composer, selection and screenshot alike', () => {
    expect(deliverTarget({ ...base, readOnly: true })).toEqual({ drop: 'read-only' })
    expect(deliverTarget({ ...base, readOnly: true, kind: 'browser_screenshot' })).toEqual({ drop: 'read-only' })
    // A session on another Mac says so first: that is why it cannot be driven.
    expect(deliverTarget({ ...base, readOnly: true, sessionIsForeign: true })).toEqual({ drop: 'foreign' })
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
