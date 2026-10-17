import type { CompletionKey } from './types'

/**
 * A stable string for a completion key, for effect deps and caches: the key
 * object is rebuilt on every render, and its identity means nothing. Every
 * field that picks a different catalog or filesystem is in it — the session,
 * or the directory, its Claude directory and the device it is on — so
 * switching any of them starts the completions afresh.
 */
export function completionKeyId(key: CompletionKey): string {
  if ('session' in key) return `s:${key.session}`
  return `c:${key.machine ?? ''}:${key.claudeDir ?? ''}:${key.cwd}`
}
