import { useEffect, useState } from 'react'
import { tokenizeCode, type CodeToken } from './highlight'

/**
 * Shiki's per-line tokens for `code`, or null until they land — and for good
 * when the language is unknown, shiki fails, or `lang` is empty. A token
 * line count that disagrees with `lineCount` is dropped too: it would pair
 * colours with the wrong rows.
 *
 * The tokens are kept with the code they were made for, so the render in
 * which `code` changes already gets null rather than the old file's tokens
 * indexed by the new file's lines.
 */
export function useTokens(code: string, lang: string, lineCount: number): CodeToken[][] | null {
  const [made, setMade] = useState<{ code: string; lang: string; tokens: CodeToken[][] } | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!lang) return
    void tokenizeCode(code, lang).then((result) => {
      if (!cancelled && result && result.length === lineCount) setMade({ code, lang, tokens: result })
    })
    return () => {
      cancelled = true
    }
  }, [code, lang, lineCount])

  return made && made.code === code && made.lang === lang && made.tokens.length === lineCount ? made.tokens : null
}
