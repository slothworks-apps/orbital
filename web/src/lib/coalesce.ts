/**
 * Wraps a read-and-apply so overlapping calls coalesce: at most one run is in
 * flight and one waits behind it. A call while one runs is answered by the
 * run after it, which starts once the current one settles — however many
 * calls came in meanwhile, it runs once more, not once per call. That later
 * run starts after every call it answers, so none of them gets an answer
 * older than itself.
 */
export function coalesced(run: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null
  let waiting: Promise<void> | null = null

  function start(): Promise<void> {
    running = run().finally(() => {
      running = null
    })
    return running
  }

  return () => {
    if (!running) return start()
    if (!waiting) {
      const next = () => {
        waiting = null
        return start()
      }
      waiting = running.then(next, next)
    }
    return waiting
  }
}
