/**
 * The list of attached files that rides at the end of a prompt (spec:
 * 2026-10-01-file-attachments-design § The wire into the session).
 *
 * A file that is not an image reaches the agent as a path it reads itself,
 * so the turn's text carries the list and the transcript turns it back into
 * receipts. The wording is a contract with `cleanTitle` in
 * `server/src/transcript/parser.ts`, which strips it from titles.
 */

const HEADING = 'Attached files:'

/** The trailing list: a blank line (or the start), the heading, then `- /path` lines to the end. */
const BLOCK = /(?:^|\n\n)Attached files:\n((?:- \/[^\n]*(?:\n|$))+)$/

export function promptWithFiles(text: string, paths: readonly string[]): string {
  if (paths.length === 0) return text
  const block = [HEADING, ...paths.map((path) => `- ${path}`)].join('\n')
  return text ? `${text}\n\n${block}` : block
}

export interface SentFiles {
  /** What was typed, without the list. */
  text: string
  paths: string[]
}

/** The list read back off a sent turn, or null when the turn carries none. */
export function parseSentFiles(text: string | undefined | null): SentFiles | null {
  if (!text) return null
  const trimmed = text.trimEnd()
  const match = BLOCK.exec(trimmed)
  if (!match) return null
  const paths = match[1]
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2))
  return { text: trimmed.slice(0, match.index), paths }
}

/** `report.xlsx` → `XLSX`; the receipt's and the chip's glyph. Empty for no extension. */
export function extensionLabel(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1, dot + 5).toUpperCase()
}
