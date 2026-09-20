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
    highlighterPromise = import('shiki')
      .then(({ createHighlighter }) => createHighlighter({ themes: [THEME], langs: [] }))
      .catch((err: unknown) => {
        // Don't let a transient failure (network blip, etc) permanently
        // wedge highlighting for the rest of the page's life — clear the
        // cached promise so the next call gets a fresh attempt.
        highlighterPromise = null
        throw err
      })
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

/** One shiki token, reduced to what the file viewer's row renderer needs. */
export interface CodeToken {
  content: string
  color?: string
}

/**
 * Tokenizes `code` as `lang` into per-line shiki tokens — the file viewer's
 * source mode renders its own rows (gutter, line targets) so it needs
 * tokens, not `highlightCode`'s finished HTML. Same lazy singleton, same
 * posture on failure: an unknown language, a failed import or any shiki
 * error resolves to `null` and the caller renders plain text rows instead.
 */
export async function tokenizeCode(code: string, lang: string): Promise<CodeToken[][] | null> {
  try {
    const highlighter = await getHighlighterInstance()

    if (!highlighter.getLoadedLanguages().includes(lang)) {
      try {
        await highlighter.loadLanguage(lang as Parameters<Highlighter['loadLanguage']>[0])
      } catch {
        return null
      }
    }

    return highlighter.codeToTokensBase(code, {
      lang: lang as Parameters<Highlighter['codeToTokensBase']>[1]['lang'],
      theme: THEME,
    })
  } catch {
    return null
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
