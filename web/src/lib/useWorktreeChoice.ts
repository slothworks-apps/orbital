import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import { isDemo } from './demo'
import type { WorktreeLaunch } from '@orbital/shared/worktree'
import { branchProblem, defaultBase, fetchFailureText, isWorktreeRepo, type FetchState, type WorktreeRepo } from './worktree'

/** Quiet time after the last keystroke in the directory before the repository is asked about. */
export const WORKTREE_OPTIONS_DEBOUNCE_MS = 300

/** The switch as the user last left it, per repository: `{ "<machine>|<main checkout>": true }`. */
const LAST_SWITCH_KEY = 'orbital.newSession.worktree'

function switchKey(machine: string | undefined, repo: WorktreeRepo): string {
  // The main checkout, so the repository's own worktrees share the choice.
  return `${machine ?? ''}|${repo.repoRoot}`
}

function readLastSwitch(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(LAST_SWITCH_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

function rememberSwitch(key: string, on: boolean): void {
  try {
    const all = readLastSwitch()
    // Only an on is worth a line: off is where every repository starts.
    if (on) all[key] = true
    else delete all[key]
    globalThis.localStorage?.setItem(LAST_SWITCH_KEY, JSON.stringify(all))
  } catch {
    // Storage full or blocked: the next dialog starts from `autoOn` alone.
  }
}

/** One inline error of the group (canvas 63c A4), with the one fix it offers. */
export interface WorktreeProblem {
  field: 'branch' | 'base' | 'launch'
  text: string
  action?: { label: string; run: () => void }
}

export interface WorktreeChoice {
  /** The repository the directory resolves to, or null: no group at all (not git, missing, not asked yet). */
  repo: WorktreeRepo | null
  on: boolean
  setOn: (on: boolean) => void
  /** The checkout is occupied and the switch was turned off by hand: the hint adds the consequence. */
  switchedOffByHand: boolean
  branch: string
  setBranch: (branch: string) => void
  base: string
  setBase: (base: string) => void
  fetch: FetchState
  problems: WorktreeProblem[]
  /** Launch waits: an error stands, or `origin` is still being fetched. */
  blocked: boolean
  /** What `POST /api/sessions` carries, or undefined to launch in the directory itself. */
  launch: WorktreeLaunch | undefined
  /** A launch refused for its worktree: the server's sentence, shown inline until the fields change. */
  setLaunchError: (message: string | null) => void
}

/**
 * New session's WORKTREE group (spec 2026-11-02-work-in-a-worktree-design §
 * The WORKTREE group): what the typed directory's repository offers, and the
 * user's choice in it. Shared by the desktop dialog and the phone's form, so
 * both start the same way and refuse the same names.
 *
 * - The repository is asked about once the directory settles and is a
 *   directory (`enabled`); another device's through `machine`.
 * - A new repository starts the switch on when the user last left it on in
 *   that repository, or from `autoOn` (occupied, and the setting allows it).
 *   Flipped by hand, the choice is remembered for the repository's next
 *   dialog — except that an occupied checkout still starts it on.
 * - Turning the switch on fetches `origin` once for that repository; a
 *   failure offers local main, and the repository is read again after a
 *   success, so a branch the fetch brought is known to the name check.
 */
export function useWorktreeChoice(cwd: string, enabled: boolean, machine?: string): WorktreeChoice {
  const typed = cwd.trim()
  const [answer, setAnswer] = useState<{ cwd: string; machine?: string; repo: WorktreeRepo | null } | null>(null)
  const [on, setOnState] = useState(false)
  const [touched, setTouched] = useState(false)
  const [branch, setBranchState] = useState('')
  const [base, setBaseState] = useState('')
  const [fetch, setFetch] = useState<FetchState>({ state: 'idle' })
  const [launchError, setLaunchError] = useState<string | null>(null)
  const asks = enabled && typed !== '' && !isDemo()
  const ticket = useRef(0)
  /** Bumped after a fetch: the directory is read again, as it stands by then. */
  const [reread, setReread] = useState(0)

  useEffect(() => {
    // A closed dialog forgets: the next open reads who is in the checkout afresh.
    if (!asks) {
      ticket.current++
      setAnswer(null)
      return
    }
    // The newest read wins: a slower answer for an earlier spelling, or for
    // before the fetch, is dropped by its ticket.
    const mine = ++ticket.current
    const dir = typed
    const timer = setTimeout(() => {
      api
        .worktreeOptions(dir, machine)
        .then((options) => {
          if (mine !== ticket.current) return
          setAnswer({ cwd: dir, machine, repo: isWorktreeRepo(options) ? options : null })
        })
        .catch(() => {
          // The group is an offer: a failed read just leaves it out.
          if (mine === ticket.current) setAnswer({ cwd: dir, machine, repo: null })
        })
    }, WORKTREE_OPTIONS_DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // `reread` is read for its change only.
  }, [asks, typed, machine, reread])

  const settled = answer?.cwd === typed && answer.machine === machine
  const repo = asks && settled ? answer.repo : null
  // The tree the choice belongs to: a new one starts the group over. While
  // the answer for a new spelling is on its way (undefined) the choice
  // stands, so a path edited back and forth inside one repository keeps it.
  const treeKey = !asks ? null : !settled ? undefined : repo ? `${machine ?? ''}|${repo.treeRoot}` : null
  const lastTree = useRef<string | null>(null)
  useEffect(() => {
    if (treeKey === undefined || treeKey === lastTree.current) return
    lastTree.current = treeKey
    setTouched(false)
    setBranchState('')
    setLaunchError(null)
    setFetch({ state: 'idle' })
    setOnState(repo ? repo.autoOn || readLastSwitch()[switchKey(machine, repo)] === true : false)
    setBaseState(repo ? defaultBase(repo) : '')
    // `repo` is read for the tree `treeKey` names.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeKey])

  // The switch on fetches `origin`, once per tree (63a: "fetched when you turned this on").
  useEffect(() => {
    if (!repo || !on || fetch.state !== 'idle') return
    setFetch({ state: 'fetching' })
    const dir = typed
    const forTree = treeKey
    api
      .fetchWorktreeOrigin(dir, machine)
      .then((result) => {
        if (lastTree.current !== forTree) return
        if (result && result.ok === true) {
          setFetch({ state: 'fetched', at: result.fetchedAt })
          // The fetch may have brought branches the name check should know.
          setReread((n) => n + 1)
        } else if (result && result.ok === false) {
          setFetch({ state: 'failed', error: result.error, message: result.message })
        } else {
          // An older Mac's empty answer: nothing was fetched, nothing failed.
          setFetch({ state: 'fetched', at: Date.now() })
        }
      })
      .catch(() => {
        if (lastTree.current === forTree) setFetch({ state: 'failed', error: 'other', message: '' })
      })
  }, [repo, on, fetch.state, typed, machine, treeKey])

  const setOn = useCallback(
    (next: boolean) => {
      setTouched(true)
      setOnState(next)
      if (repo) rememberSwitch(switchKey(machine, repo), next)
    },
    [repo, machine],
  )
  const setBranch = useCallback((next: string) => {
    setLaunchError(null)
    setBranchState(next)
  }, [])
  const setBase = useCallback((next: string) => {
    setLaunchError(null)
    setBaseState(next)
  }, [])

  const problems: WorktreeProblem[] = []
  if (repo && on) {
    const problem = branchProblem(branch, repo.branches)
    if (problem) {
      const exists = problem.kind === 'exists' ? problem : null
      problems.push({
        field: 'branch',
        text: problem.text,
        action: exists
          ? {
              label: 'Base on it',
              run: () => {
                setBase(exists.base)
                setBranch('')
              },
            }
          : undefined,
      })
    }
    if (fetch.state === 'failed' && base.startsWith('origin/')) {
      problems.push({
        field: 'base',
        text: fetchFailureText(fetch.error),
        action: { label: `Use local ${repo.defaultBranch}`, run: () => setBase(repo.defaultBranch) },
      })
    }
    if (launchError) problems.push({ field: 'launch', text: launchError })
  }

  const active = repo !== null && on
  return {
    repo,
    on: active,
    setOn,
    switchedOffByHand: repo !== null && !on && touched && repo.occupants.length > 0,
    branch,
    setBranch,
    base,
    setBase,
    fetch,
    problems,
    blocked: active && (problems.some((p) => p.field !== 'launch') || fetch.state === 'fetching'),
    launch: active ? { base, ...(branch.trim() ? { branch: branch.trim() } : {}) } : undefined,
    setLaunchError,
  }
}
