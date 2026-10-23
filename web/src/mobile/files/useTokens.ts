import { useEffect, useState } from 'react'
import { tokenizeCode, type CodeToken } from '../../lib/highlight'

/**
 * Shiki's per-line tokens for `code`, or null until they land — and for good
 * when the language is unknown, shiki fails, or `lang` is empty. A token
 * line count that disagrees with `lineCount` is dropped too: it would pair
 * colours with the wrong rows.
 */
export function useTokens(code: string, lang: string, lineCount: number): CodeToken[][] | null {
  const [tokens, setTokens] = useState<CodeToken[][] | null>(null)

  useEffect(() => {
    let cancelled = false
    setTokens(null)
    if (!lang) return
    void tokenizeCode(code, lang).then((result) => {
      if (!cancelled && result && result.length === lineCount) setTokens(result)
    })
    return () => {
      cancelled = true
    }
  }, [code, lang, lineCount])

  return tokens
}
