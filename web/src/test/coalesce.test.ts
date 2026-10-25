import { describe, expect, it } from 'vitest'
import { coalesced } from '../lib/coalesce'

/** A run that stays in flight until the test settles it. */
function controlled() {
  const pending: { resolve: () => void; reject: (err: unknown) => void }[] = []
  const run = () =>
    new Promise<void>((resolve, reject) => {
      pending.push({ resolve, reject })
    })
  return { run, pending }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('coalesced', () => {
  it('runs once more after the run in flight, however many calls came in meanwhile', async () => {
    const { run, pending } = controlled()
    const call = coalesced(run)
    const first = call()
    const second = call()
    const third = call()
    expect(second).toBe(third)
    expect(pending).toHaveLength(1)
    pending[0].resolve()
    await first
    await tick()
    expect(pending).toHaveLength(2)
    pending[1].resolve()
    await second
    await tick()
    expect(pending).toHaveLength(2)
  })

  it('runs the waiting call after a run that failed', async () => {
    const { run, pending } = controlled()
    const call = coalesced(run)
    const first = call()
    const second = call()
    pending[0].reject(new Error('down'))
    await expect(first).rejects.toThrow('down')
    await tick()
    expect(pending).toHaveLength(2)
    pending[1].resolve()
    await second
  })

  it('starts afresh once nothing is in flight', async () => {
    const { run, pending } = controlled()
    const call = coalesced(run)
    const first = call()
    pending[0].resolve()
    await first
    void call()
    expect(pending).toHaveLength(2)
  })
})
