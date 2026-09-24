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
 * - the selection attaches to EVERY prompt while it stands, as the CLI does;
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
    parentId: null,
    mapDismissedAt: null,
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
    composerDrafts: {},
  })
}

const sentTexts = () => vi.mocked(api.sendMessage).mock.calls.map((c) => c[1])

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

  it('sends the typed words alone once this session has dropped it', async () => {
    seed([session({ id: 's1', ide: { ideName: 'WebStorm', workspaceRoot: '/w/x', selection: SELECTION } })])
    useOrbital.getState().dismissIdeSelection('s1', selectionId(SELECTION))

    await useOrbital.getState().sendPrompt('s1', 'plain question')
    expect(sentTexts()).toEqual(['plain question'])
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

    expect(sentTexts()[0]).toBe('one')
    expect(sentTexts()[1]).toContain('a span does not have a size')
  })

  it('changes nothing about a turn when there is no editor', async () => {
    seed([
      session({ id: 'none', ide: null }),
      session({ id: 'absent' }),
      // An editor with the caret merely moved attaches nothing either.
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

    for (const id of ['none', 'absent', 'caret', 'empty']) {
      await useOrbital.getState().sendPrompt(id, `hello ${id}`)
    }
    expect(sentTexts()).toEqual(['hello none', 'hello absent', 'hello caret', 'hello empty'])
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
    expect(vi.mocked(api.answerDecision).mock.calls[0]?.[2]).toEqual({ 'which?': 'the second one' })
  })
})
