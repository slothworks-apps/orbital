/**
 * The composer's tokenizer (spec: 2026-09-20-composer-design § Highlighting).
 *
 * Pure, and deliberately so: the composer paints these runs as decorations
 * over its own text (`composerDecorations`), mapping each run's length onto
 * document positions, so the one invariant that matters is that the runs
 * re-join to the input VERBATIM — a tokenizer that trimmed, normalised or
 * dropped a single character would slide every paint after it off its text.
 *
 * Two token kinds, per canvas 9a/9e: a command slug (an exact catalog match
 * wherever a `/` starts a word) and a mention (`@path` with an optional
 * `:line[:col]`). Everything else is prose, including an unrecognised slug
 * (9e UNKNOWN), which stays plain ink and is reported through
 * `unknownCommand` for the hint line.
 *
 * Canvas 9e MID-LINE paints a mid-sentence `/code-review` as prose; that no
 * longer holds, because the CLI does pick a slug up there and the popup now
 * offers one — see [[command-completion-is-not-anchored-to-position-0]]. The
 * canvas is the one still to catch up.
 */

import type { SlashCommand } from './types'

export type ComposerToken =
  | { kind: 'text'; text: string }
  /** `name` is the slug without its leading slash — the catalog's own key. */
  | { kind: 'command'; text: string; name: string }
  /** `suffix` is the raw `:line[:col]` (or ''), which the composer paints muted. */
  | { kind: 'mention'; text: string; path: string; suffix: string }

/**
 * Catalog names as the tokenizer wants them: no leading slash, so a server
 * that answers `code-review` and one that answers `/code-review` both land in
 * the same set (the wire contract does not pin it down, and the SDK's
 * `supportedCommands()` and a filesystem scan disagree in practice).
 */
export function commandNameSet(commands: ReadonlyArray<Pick<SlashCommand, 'name'>>): Set<string> {
  return new Set(commands.map((c) => (c.name.startsWith('/') ? c.name.slice(1) : c.name)))
}

/**
 * One path segment inside a mention. `pathLinks`'s SEGMENT is mirrored rather
 * than imported, minus `@`: inside a mention a second `@` starts a new
 * candidate, and unlike prose there is no extension whitelist to pass — the
 * sigil is the user's declaration of intent, so `@README.md` and
 * `@src/components/` both count.
 */
const MENTION_SEGMENT = String.raw`[\w.+~-]+`
const MENTION = new RegExp(
  `@(${MENTION_SEGMENT}(?:/${MENTION_SEGMENT})*/?)`,
  'g',
)
/** Optional `:line` or `:line:col` immediately after the path (col ignored, kept). */
const LINE_SUFFIX = /^:\d+(?::\d+)?/

/**
 * A command slug. No `/` in the name — a run carrying a second one is a path
 * (`/Users/tomin/notes.md`), and the CLI's only nesting is `plugin:skill`,
 * which uses a colon.
 */
const COMMAND = /\/([A-Za-z0-9][A-Za-z0-9:._-]*)/g

/** Whitespace test used for both token boundaries and caret runs. */
const isSpace = (ch: string | undefined) => ch !== undefined && /\s/.test(ch)

/**
 * The position-0 slug, or null when the field does not open with one. A run
 * containing a `/` is an absolute path (`/Users/tomin/notes.md`), never a
 * command — the CLI has no slash inside a command name, only in `plugin:skill`
 * form, which uses a colon.
 */
function positionZeroSlug(text: string): string | null {
  if (!text.startsWith('/')) return null
  const end = text.search(/\s/)
  const name = (end === -1 ? text : text.slice(0, end)).slice(1)
  if (!name || name.includes('/')) return null
  return name
}

/** Splits `text` into prose / command / mention runs that re-join to `text`. */
export function tokenizeComposer(
  text: string,
  knownCommands: ReadonlySet<string>,
): ComposerToken[] {
  if (text === '') return []

  /** Every run either kind claims, collected before any is emitted: the two
   * scans run over the whole field, so their hits arrive interleaved and the
   * merge below is what puts them back in reading order. */
  const hits: Array<{ start: number; token: ComposerToken }> = []

  COMMAND.lastIndex = 0
  for (let m = COMMAND.exec(text); m !== null; m = COMMAND.exec(text)) {
    const at = m.index
    // A command starts a word. Inside one the slash is a path separator or a
    // date (`web/src`, `22/09`), never a slug.
    if (at > 0 && !isSpace(text[at - 1])) continue
    // And the run must hold no second slash: `/Users/tomin/notes.md` opens a
    // word and is still a path. The name stops at the slash, so what follows
    // the match is what tells them apart.
    if (text[at + m[0].length] === '/') continue
    const name = m[1]
    if (!knownCommands.has(name)) continue
    hits.push({ start: at, token: { kind: 'command', text: `/${name}`, name } })
  }

  MENTION.lastIndex = 0
  for (let m = MENTION.exec(text); m !== null; m = MENTION.exec(text)) {
    const at = m.index
    // A mention starts a word. Glued to the end of one it is an email address
    // or a decorator, not a path (`tomas@example.com`).
    if (at > 0 && !isSpace(text[at - 1])) {
      MENTION.lastIndex = at + 1
      continue
    }
    // `.` is a path character, so a mention at the end of a sentence swallows
    // the full stop — same trim as `pathLinks`, same reason.
    const path = m[1].replace(/\.+$/, '')
    if (!path) {
      MENTION.lastIndex = at + 1
      continue
    }
    const suffix = LINE_SUFFIX.exec(text.slice(at + 1 + path.length))?.[0] ?? ''
    hits.push({ start: at, token: { kind: 'mention', text: `@${path}${suffix}`, path, suffix } })
    MENTION.lastIndex = at + 1 + path.length + suffix.length
  }

  hits.sort((a, b) => a.start - b.start)

  const tokens: ComposerToken[] = []
  let cursor = 0
  for (const hit of hits) {
    // Both scans require a word start, so an overlap needs one run to contain
    // the other; the earlier one keeps it and the prose between is emitted
    // verbatim, which is the invariant the paint rests on.
    if (hit.start < cursor) continue
    if (hit.start > cursor) tokens.push({ kind: 'text', text: text.slice(cursor, hit.start) })
    tokens.push(hit.token)
    cursor = hit.start + hit.token.text.length
  }

  if (cursor < text.length) tokens.push({ kind: 'text', text: text.slice(cursor) })
  return tokens
}

/**
 * The slug the hint line has to disown, or null when there is nothing to say
 * (canvas 9e UNKNOWN: `no command /comand — sends as typed`).
 *
 * An unfinished slug that is still a live prefix of something stays quiet —
 * otherwise the note would flash through `/c`, `/co`, `/cod` on the way to a
 * command that does exist. A space after the slug finishes it, and then even a
 * live prefix is wrong (`/co the diff`).
 *
 * This one KEEPS the position-0 rule that the popup and the tint have dropped.
 * The note is about a whole message that was meant to be a command and will
 * instead be sent as prose; a stray `/etc` in the middle of a sentence was
 * never meant as one, and warning about it would be noise on ordinary typing.
 */
export function unknownCommand(text: string, knownCommands: ReadonlySet<string>): string | null {
  const name = positionZeroSlug(text)
  if (name === null || knownCommands.has(name)) return null
  const finished = /\s/.test(text)
  if (!finished) {
    for (const known of knownCommands) if (known.startsWith(name)) return null
  }
  return `/${name}`
}

export interface CompletionContext {
  kind: 'command' | 'file'
  /** Offset of the trigger character (`/` or `@`) in the field. */
  start: number
  /** What sits between the trigger and the caret — the filter. */
  prefix: string
}

/**
 * What the popup would be completing with the caret where it is: a `/` or an
 * `@` starting a word, anywhere in the field (spec § Completion popup).
 * Null once the caret leaves the token — which is also what makes ⌫ past the
 * trigger, and a click elsewhere in the field, close the popup.
 *
 * `/` used to be offered at position 0 only, on the assumption that the CLI
 * expands a command only when the message opens with one. It does not — a
 * slug later in the prompt is picked up too — so completing one there is a
 * real offer rather than a decoration.
 */
export function completionContext(text: string, caret: number): CompletionContext | null {
  const pos = Math.max(0, Math.min(caret, text.length))
  let start = pos
  while (start > 0 && !isSpace(text[start - 1])) start -= 1
  const run = text.slice(start, pos)

  if (run.startsWith('/')) {
    const prefix = run.slice(1)
    // `/Users/tomin` is a path the user is typing, not a command.
    if (prefix.includes('/')) return null
    return { kind: 'command', start, prefix }
  }
  if (run.startsWith('@')) return { kind: 'file', start, prefix: run.slice(1) }
  return null
}
