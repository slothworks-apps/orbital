import { useEffect, useState } from 'react'

/**
 * Whether the window has focus, tracked only while `enabled`. Desktop windows
 * dim a detail or two while they sit behind another: a detached window its
 * glint (canvas `Feature - Detached window` 22d), the main window its mark
 * (`Feature - Main window chrome` 24d). Always true when not tracked.
 */
export function useWindowFocused(enabled: boolean): boolean {
  const [focused, setFocused] = useState(() => !enabled || document.hasFocus())
  useEffect(() => {
    if (!enabled) return
    const onFocus = () => setFocused(true)
    const onBlur = () => setFocused(false)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [enabled])
  return focused
}

/**
 * Whether the document is hidden (`document.hidden`): a minimised window, a
 * background tab, or the desktop window after the red button, which only
 * hides it. The map draws nothing while this is true.
 */
export function useDocumentHidden(): boolean {
  const [hidden, setHidden] = useState(() => document.hidden)
  useEffect(() => {
    const onChange = () => setHidden(document.hidden)
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])
  return hidden
}
