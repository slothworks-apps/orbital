import { describe, expect, it } from 'vitest'
import { PROGRESS_TOOL } from '@orbital/shared/progress'
import { foldProgress } from '../lib/progressList'
import type { ChatMessage } from '../lib/types'
import { progressTones } from '../mobile/progress/figure'

let n = 0
/** One accepted call of the tool and its answer, as the transcript holds them. */
function call(input: unknown): ChatMessage[] {
  const id = `t${++n}`
  return [
    { id: `u${id}`, role: 'tool_use', toolName: PROGRESS_TOOL, toolUseId: id, toolInput: input },
    { id: `r${id}`, role: 'tool_result', toolUseId: id },
  ]
}

describe('the phone readout segments', () => {
  it('draws one per counted item, the held list deciding which is in progress', () => {
    const items = [{ title: 'a', state: 'done' }, { title: 'b', state: 'in_progress' }, { title: 'c', state: 'pending' }]
    const fold = foldProgress([
      ...call({ items }),
      ...call({ items: [...items, { title: 'd', state: 'dropped', reason: 'not needed' }], reason: 'not needed' }),
    ])
    expect(progressTones(fold.list, { done: 1, total: 3 })).toEqual(['done', 'active', 'pending'])
  })

  it('falls back to the figure when the held transcript carries no call', () => {
    expect(progressTones(null, { done: 2, total: 4 })).toEqual(['done', 'done', 'pending', 'pending'])
  })
})
