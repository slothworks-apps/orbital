import { describe, expect, it } from 'vitest'
import { VIEW_TOOL } from '@orbital/shared/views'
import type { ChatMessage } from '../lib/types'
import { foldTranscriptViews, groupToolRuns, pairMessages } from '../panels/TranscriptView'

const call = (toolUseId: string, input: Record<string, unknown>, toolName = VIEW_TOOL): ChatMessage =>
  ({ id: `m-${toolUseId}`, role: 'tool_use', toolName, toolUseId, toolInput: input })
const result = (toolUseId: string, isError = false): ChatMessage =>
  ({ id: `r-${toolUseId}`, role: 'tool_result', toolUseId, text: 'View x: shown.', isError })
const user = (id: string): ChatMessage => ({ id, role: 'user', text: 'hi' })

const page = { title: 'Release latency', component: 'export default () => null' }

function groups(messages: ChatMessage[], pending?: string, viewsOn = true) {
  const items = pairMessages(messages)
  return groupToolRuns(items, pending, viewsOn ? foldTranscriptViews(items) : undefined)
}

describe('groupToolRuns with views', () => {
  it('draws a shown call as a view of its own, not in a tool run', () => {
    const out = groups([call('a', { ...page }), result('a'), call('b', { command: 'ls' }, 'Bash'), result('b')])
    expect(out.map((g) => g.kind)).toEqual(['view', 'tools'])
  })

  it('leaves the call an ordinary tool row while Labs → Views is off', () => {
    const out = groups([call('a', { ...page }), result('a')], undefined, false)
    expect(out.map((g) => g.kind)).toEqual(['tools'])
  })

  it('keeps a refused call a tool row', () => {
    const out = groups([call('a', { ...page }), result('a', true)])
    expect(out.map((g) => g.kind)).toEqual(['tools'])
  })

  it('draws a waiting view as a view, never as a permission card', () => {
    const out = groups([call('a', { ...page, wait: true })], 'a')
    expect(out.map((g) => g.kind)).toEqual(['view'])
  })

  it('leaves one line where an updated view was, pointing at its newest call', () => {
    const out = groups([
      call('a', { ...page }),
      result('a'),
      user('u1'),
      call('b', { ...page, replaces: 'a' }),
      result('b'),
      user('u2'),
      call('c', { ...page, title: 'Release latency v2', replaces: 'b' }),
      result('c'),
    ])
    expect(out.map((g) => g.kind)).toEqual(['view-updated', 'message', 'view-updated', 'message', 'view'])
    const first = out[0]
    expect(first.kind === 'view-updated' && first.targetToolUseId).toBe('c')
    expect(first.kind === 'view-updated' && first.title).toBe('Release latency')
    const last = out[4]
    expect(last.kind === 'view' && last.viewId).toBe('a')
  })

  it('knows a call was updated even when the update is outside the window', () => {
    const all = pairMessages([call('a', { ...page }), result('a'), call('b', { ...page, replaces: 'a' }), result('b')])
    const fold = foldTranscriptViews(all)
    // Only the first call is on screen.
    const out = groupToolRuns(all.slice(0, 1), undefined, fold)
    expect(out.map((g) => g.kind)).toEqual(['view-updated'])
  })
})
