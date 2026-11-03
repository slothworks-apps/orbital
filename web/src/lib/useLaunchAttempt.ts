import { useMemo, useRef } from 'react'

/** The id of one launch attempt and the body it went out with. */
export interface LaunchAttempt {
  key: string
  id: string
}

/**
 * The id a launch goes out under (spec 2026-11-02-work-in-a-worktree-design §
 * The phone, slow routes): the last attempt's when the body is the same —
 * a launch whose answer was lost (a tunnel that gave up on a slow worktree
 * launch) is sent again under its first id, and the server answers the
 * repeat instead of starting a second session and worktree — and a fresh
 * one for anything else, which the server would refuse as a taken id.
 */
export function launchAttempt(last: LaunchAttempt | null, body: unknown, mint: () => string): LaunchAttempt {
  const key = JSON.stringify(body)
  return last?.key === key ? last : { key, id: mint() }
}

/**
 * One form's launch attempts: `idFor` mints the id once per attempt and
 * repeats it for a retry of the same body; `settle` forgets it once a launch
 * has gone through, so the next one is new.
 */
export function useLaunchAttempt(): { idFor: (body: unknown) => string; settle: () => void } {
  const last = useRef<LaunchAttempt | null>(null)
  return useMemo(
    () => ({
      idFor(body: unknown) {
        last.current = launchAttempt(last.current, body, () => crypto.randomUUID())
        return last.current.id
      },
      settle() {
        last.current = null
      },
    }),
    [],
  )
}
