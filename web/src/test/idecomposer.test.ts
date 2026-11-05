import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiSession, IdeSelection } from '../lib/types'

vi.mock('../lib/api', async () => (await import('./apiMock')).mockApiModule())

import { api } from '../lib/api'
import { useOrbital } from '../store/store'
import { selectionId } from '../lib/ideSelection'

/**
 * What the editor selection does to a turn (spec:
 * 2026-09-23-ide-bridge-design § Behaviour).
 *
 * Two rules decided by the spec rather than by the canvas, and both can break
 * for a reason other than someone changing a value:
 *
 * - the selection attaches to EVERY prompt while it stands, as the CLI does,
 *   and with none standing the open file rides by path instead;
 * - × is per session, though the selection belongs to the workspace.
 */

const SELECTION: IdeSelection = {
  filePath: '/w/x/web/CLAUDE.md',
  lineStart: 84,
  lineCount: 5,
  text: 'a span does not have a size',
}

function session(over: Partial<ApiSession> & { id: string }): ApiSession {
  return {
    cwd: '/w/x',
    title: 'Session',
    firstAt: 1,
    lastAt: 1,
    messageCount: 0,
    source: 'web',
    permissionMode: null,
    model: null,
    resolvedModel: null,
    tagIds: [],
    status: 'idle',
    subagents: [],
    ...over,
  }
}

function seed(sessions: ApiSession[]) {
  useOrbital.setState({
    sessions: Object.fromEntries(sessions.map((s) => [s.id, s])),
    order: sessions.map((s) => s.id),
    transcripts: {},
    ideDismissed: {},
    browserSelections: {},
    composerDrafts: {},
  })
}

const sentTexts = () => vi.mocked(api.sendMessage).mock.calls.map((c) => c[1])
const OPEN = (path: string, typed: string) =>
  `The user opened the file ${path} in the IDE. This may or may not be related to the current task.\n\n${typed}`

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.sendMessage).mockResolvedValue(undefined as never)
})

describe('the editor selection on the way out', () => {
  it('rides with every prompt while it stands, not only the first', async () => {
    seed([session({ id: 's1', ide: { ideName: 'WebStorm', workspaceRoot: '/w/x', selection: SELECTION } })])

    await useOrbital.getState().sendPrompt('s1', 'what does this mean?')
    await useOrbital.getState().sendPrompt('s1', 'and this?')

    expect(sentTexts()).toHaveLength(2)
    for (const text of sentTexts()) {
      expect(text).toContain('@web/CLAUDE.md lines 84–88')
      expect(text).toContain('a span does not have a size')
    }
    expect(sentTexts()[0]).toMatch(/what does this mean\?$/)
    expect(sentTexts()[1]).toMatch(/and this\?$/)
  })

  it('shows the transcript what was sent, not what was typed', async () => {
    seed([session({ id: 's1', ide: { ideName: 'WebStorm', workspaceRoot: '/w/x', selection: SELECTION } })])
    await useOrbital.getState().sendPrompt('s1', 'why?')
    const optimistic = useOrbital.getState().transcripts.s1
    expect(optimistic).toHaveLength(1)
    expect(optimistic[0].text).toBe(sentTexts()[0])
  })

  it('sends only the open file once this session has dropped the selection', async () => {
    seed([session({ id: 's1', ide: { ideName: 'WebStorm', workspaceRoot: '/w/x', selection: SELECTION } })])
    useOrbital.getState().dismissIdeSelection('s1', selectionId(SELECTION))

    await useOrbital.getState().sendPrompt('s1', 'plain question')
    expect(sentTexts()).toEqual([OPEN('web/CLAUDE.md', 'plain question')])
  })

  it('carries it again the moment the selection changes under a dismissal', async () => {
    seed([session({ id: 's1', ide: { ideName: 'WebStorm', workspaceRoot: '/w/x', selection: SELECTION } })])
    useOrbital.getState().dismissIdeSelection('s1', selectionId(SELECTION))

    // The person selected something else; the stored id no longer matches, and
    // nothing had to clear it.
    const moved = { ...SELECTION, lineStart: 120, text: 'else' }
    useOrbital.setState((state) => ({
      sessions: {
        ...state.sessions,
        s1: { ...state.sessions.s1, ide: { ideName: 'WebStorm', workspaceRoot: '/w/x', selection: moved } },
      },
    }))

    await useOrbital.getState().sendPrompt('s1', 'and now?')
    expect(sentTexts()[0]).toContain('@web/CLAUDE.md lines 120–124')
  })

  it('dismisses for THIS session only, never for the workspace', async () => {
    const ide = { ideName: 'WebStorm', workspaceRoot: '/w/x', selection: SELECTION }
    seed([session({ id: 's1', ide }), session({ id: 's2', ide })])

    useOrbital.getState().dismissIdeSelection('s1', selectionId(SELECTION))
    await useOrbital.getState().sendPrompt('s1', 'one')
    await useOrbital.getState().sendPrompt('s2', 'two')

    expect(sentTexts()[0]).toBe(OPEN('web/CLAUDE.md', 'one'))
    expect(sentTexts()[1]).toContain('a span does not have a size')
  })

  it('changes nothing about a turn when there is no editor', async () => {
    seed([
      session({ id: 'none', ide: null }),
      session({ id: 'absent' }),
    ])

    for (const id of ['none', 'absent']) {
      await useOrbital.getState().sendPrompt(id, `hello ${id}`)
    }
    expect(sentTexts()).toEqual(['hello none', 'hello absent'])
  })

  it('names the open file, by path only, when nothing is selected', async () => {
    seed([
      // The caret merely moved.
      session({
        id: 'caret',
        ide: {
          ideName: 'WebStorm',
          workspaceRoot: '/w/x',
          selection: { ...SELECTION, text: null },
        },
      }),
      // An empty selection is the same fact as an absent one.
      session({
        id: 'empty',
        ide: { ideName: 'WebStorm', workspaceRoot: '/w/x', selection: { ...SELECTION, text: '' } },
      }),
    ])

    for (const id of ['caret', 'empty']) {
      await useOrbital.getState().sendPrompt(id, `hello ${id}`)
    }
    expect(sentTexts()).toEqual([OPEN('web/CLAUDE.md', 'hello caret'), OPEN('web/CLAUDE.md', 'hello empty')])
  })

  it('sends a slash command as typed — the CLI runs it only from the first character', async () => {
    seed([
      session({ id: 'selected', ide: { ideName: 'WebStorm', workspaceRoot: '/w/x', selection: SELECTION } }),
      session({
        id: 'caret',
        ide: { ideName: 'WebStorm', workspaceRoot: '/w/x', selection: { ...SELECTION, text: null } },
      }),
    ])

    await useOrbital.getState().sendPrompt('selected', '/compact keep the plan')
    await useOrbital.getState().sendPrompt('caret', '/compact')
    // A pasted path is a prompt, not a command, and keeps its context.
    await useOrbital.getState().sendPrompt('caret', '/w/x/a.ts fails')
    expect(sentTexts()).toEqual(['/compact keep the plan', '/compact', OPEN('web/CLAUDE.md', '/w/x/a.ts fails')])
  })

  it('leaves an answer to an open question alone — it is words for the ask', async () => {
    seed([session({ id: 's1', ide: { ideName: 'WebStorm', workspaceRoot: '/w/x', selection: SELECTION } })])
    useOrbital.setState({
      pendingDecisions: {
        s1: {
          id: 'tu1',
          kind: 'question',
          createdAt: 1,
          input: {
            questions: [
              { question: 'which?', header: 'PICK', options: [], multiSelect: false },
            ],
          },
        },
      },
    })

    await useOrbital.getState().sendPrompt('s1', 'the second one')
    // Answered, not sent as a turn — and certainly not with a code block
    // wrapped around it.
    expect(api.sendMessage).not.toHaveBeenCalled()
    expect(useOrbital.getState().decisionDrafts.tu1).toEqual({ 'which?': 'the second one' })
  })
})

describe('the browser selection on the way out', () => {
  const PAGE = { eventId: 'e1', text: 'the paragraph', url: 'https://example.com/spec', title: 'Spec', at: 1 }
  beforeEach(() => useOrbital.setState({ pendingDecisions: {} }))

  it('rides once, after the editor block and before the typed words', async () => {
    seed([session({ id: 's1', ide: { ideName: 'WebStorm', workspaceRoot: '/w/x', selection: SELECTION } })])
    useOrbital.getState().setBrowserSelection('s1', PAGE)

    await useOrbital.getState().sendPrompt('s1', 'consistent?')
    await useOrbital.getState().sendPrompt('s1', 'and again')

    const [first, second] = sentTexts()
    const editor = first.indexOf('Selected in the editor')
    const browser = first.indexOf('Selected in the browser — Spec (https://example.com/spec):')
    expect(editor).toBe(0)
    expect(browser).toBeGreaterThan(editor)
    expect(first.indexOf('consistent?')).toBeGreaterThan(browser)
    expect(second).not.toContain('Selected in the browser')
    expect(useOrbital.getState().browserSelections.s1).toBeUndefined()
  })

  it('leaves a slash command untouched and keeps the selection standing', async () => {
    seed([session({ id: 's1' })])
    useOrbital.getState().setBrowserSelection('s1', PAGE)
    await useOrbital.getState().sendPrompt('s1', '/compact')
    expect(sentTexts()).toEqual(['/compact'])
    expect(useOrbital.getState().browserSelections.s1).toEqual(PAGE)
  })

  it('belongs to its own session', async () => {
    seed([session({ id: 's1' }), session({ id: 's2' })])
    useOrbital.getState().setBrowserSelection('s1', PAGE)
    await useOrbital.getState().sendPrompt('s2', 'other')
    expect(sentTexts()).toEqual(['other'])
    expect(useOrbital.getState().browserSelections.s1).toEqual(PAGE)
  })
})
