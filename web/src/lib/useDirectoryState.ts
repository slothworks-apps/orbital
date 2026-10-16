import { useEffect, useState } from 'react'
import { api, type DirectoryState } from './api'

/** Quiet time after the last keystroke before the typed directory is asked about. */
export const DIRECTORY_CHECK_DEBOUNCE_MS = 350

/**
 * What the typed project directory is on the Mac, for the line under the New
 * Session field (spec 2026-10-12-new-session-missing-directory-design § 1).
 * `null` until the server has answered for the path as it reads now: an
 * answer for an earlier spelling is dropped rather than shown against a field
 * that has moved on. A failed ask is `null` too — the line is a courtesy, and
 * Start asks again anyway.
 */
export function useDirectoryState(path: string, enabled = true, machine?: string): DirectoryState | null {
  const typed = path.trim()
  const [answer, setAnswer] = useState<{ path: string; state: DirectoryState } | null>(null)
  useEffect(() => {
    if (!enabled || !typed) return
    let current = true
    const timer = setTimeout(() => {
      api
        .directoryState(typed, machine)
        .then(({ state }) => {
          if (current) setAnswer({ path: typed, state })
        })
        .catch(() => {})
    }, DIRECTORY_CHECK_DEBOUNCE_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [typed, enabled, machine])
  return enabled && answer?.path === typed ? answer.state : null
}

/** The line under the field for a directory that is not one yet; `null` says nothing. */
export function directoryLine(state: DirectoryState | null, where: string): string | null {
  switch (state) {
    case 'missing':
      return `No such folder on ${where} yet — it can be created when the session starts`
    case 'not_a_directory':
      return `That's a file, not a folder`
    case 'not_absolute':
      return 'Use a full path, like ~/Projects/name'
    default:
      return null
  }
}

/** A state Start cannot get past: no question would make it a directory. */
export function blocksLaunch(state: DirectoryState | null): boolean {
  return state === 'not_a_directory' || state === 'not_absolute'
}
