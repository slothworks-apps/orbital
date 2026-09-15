import Anser from 'anser'
import type { Highlighter } from 'shiki'

const THEME = 'github-dark-default'

/** Lazy singleton highlighter promise. Created on first `highlightCode` call
 * via a dynamic `import('shiki')`, so shiki's (large) WASM grammar engine
 * never loads until a code block actually needs highlighting. Shared across
 * every call so languages loaded for one code block stay warm for the next. */
let highlighterPromise: Promise<Highlighter> | null = null

function getHighlighterInstance(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then(({ createHighlighter }) =>
      createHighlighter({ themes: [THEME], langs: [] })
    )
  }
  return highlighterPromise
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Plain, escaped `<pre>` markup — used both as the pending state while a
 * highlight is in flight and as the permanent result for unknown languages
 * or any shiki failure (import error, bad WASM, unrecognized lang, etc). */
export function plainCodeHtml(code: string): string {
  return `<pre><code>${escapeHtml(code)}</code></pre>`
}

/**
 * Highlights `code` as `lang` using shiki, resolving to trusted-safe HTML
 * (safe to pass straight to `dangerouslySetInnerHTML`). Never throws: an
 * unrecognized language, a failed dynamic import, or any other shiki error
 * all fall back to plain escaped `<pre>` markup instead.
 */
export async function highlightCode(code: string, lang: string): Promise<string> {
  try {
    const highlighter = await getHighlighterInstance()

    if (!highlighter.getLoadedLanguages().includes(lang)) {
      try {
        await highlighter.loadLanguage(lang as Parameters<Highlighter['loadLanguage']>[0])
      } catch {
        return plainCodeHtml(code)
      }
    }

    return highlighter.codeToHtml(code, { lang, theme: THEME })
  } catch {
    return plainCodeHtml(code)
  }
}

/**
 * ANSI escape codes -> HTML via `anser`. The input is escaped for HTML
 * FIRST (so any `<`/`&`/etc in the raw text, e.g. shell output containing
 * `<script>`, can never inject markup) and only THEN colorized — anser's
 * `ansiToHtml` does not escape its input on its own.
 */
export function ansiToHtml(text: string): string {
  return Anser.ansiToHtml(Anser.escapeForHtml(text))
}
