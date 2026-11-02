import { useMemo, useRef, useState } from 'react'
import type { FocusEvent, MouseEvent } from 'react'
import { searchDirectories, type DirectoryMatch, type DirectoryRow } from './directorySearch'

export interface DirectorySuggestions {
  /** The list's rows: the recent directories until something is typed, then the matches. */
  rows: DirectoryMatch[]
  /** Whether what the field holds is a query typed here, not a prefilled or picked path. */
  searching: boolean
  focused: boolean
  /** Call from the field's `onChange` with the new text. */
  type: (text: string) => void
  /** Call when a row fills the field: a picked path is not a query. */
  settle: () => void
  /** Spread on the field. */
  inputProps: {
    onFocus: (e: FocusEvent<HTMLInputElement>) => void
    onBlur: () => void
    onMouseUp: (e: MouseEvent<HTMLInputElement>) => void
  }
}

/**
 * The state behind New session's directory suggestions, shared by the
 * desktop field and the phone's (canvas `Feature - Directory suggestions`).
 * A value set from outside — prefilled, a RECENT chip, Browse…, a picked row,
 * a device switch — is not a query: until something is typed here the list
 * is the recent directories. Leaving the field settles what was typed.
 *
 * Focus selects the field's text, so typing replaces a prefilled path
 * instead of appending to it. A click would put the caret back on mouseup;
 * the first mouseup after focus is cancelled for that.
 */
export function useDirectorySuggestions(value: string, projects: readonly DirectoryRow[]): DirectorySuggestions {
  /** What was typed here, while it is still what the field holds; null until then. */
  const [typed, setTyped] = useState<string | null>(null)
  const [focused, setFocused] = useState(false)
  const justFocused = useRef(false)

  const searching = typed !== null && typed === value
  const query = searching ? typed : ''
  const rows = useMemo(() => searchDirectories(projects, query), [projects, query])

  return {
    rows,
    searching,
    focused,
    type: (text) => {
      // Focused from the keyboard: no click is coming to cancel.
      justFocused.current = false
      setTyped(text)
    },
    settle: () => setTyped(null),
    inputProps: {
      onFocus: (e) => {
        setFocused(true)
        justFocused.current = true
        e.currentTarget.setSelectionRange(0, e.currentTarget.value.length)
      },
      onBlur: () => {
        setFocused(false)
        setTyped(null)
        justFocused.current = false
      },
      onMouseUp: (e) => {
        if (!justFocused.current) return
        justFocused.current = false
        e.preventDefault()
      },
    },
  }
}
