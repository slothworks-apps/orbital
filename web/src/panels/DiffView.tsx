import { useEffect, useMemo, useState } from 'react'
import { DIFF_MAX_RENDERED_LINES, splitLines, type DiffLine, type LineDiff } from '../lib/diff'
import {
  cachedFragmentTokens,
  diffSideTexts,
  tokenizeFragment,
  type DiffRowCoord,
} from '../lib/codeTokens'
import { languageFromPath, type CodeToken } from '../lib/highlight'
import type { FileChange } from '../lib/fileEdit'

/**
 * An editing tool call's change, drawn as a diff (spec:
 * 2026-09-23-edit-diffs-in-the-transcript). Lives in the transcript, at the
 * tool call — the file viewer stays a snapshot and stays diff-free
 * (2026-09-19-file-viewer-design § "Reading, never editing").
 *
 * Every value here comes from canvas `Feature - Transcript blocks` 20d,
 * "EDIT DIFFS — WHAT WE KNOW, SHOWN HONESTLY" — its `luminance` palette and
 * the table under "H · DIFF COLOUR — WHY LUMINANCE". (Artboard ids are
 * per-file: `Feature - IDE bridge` also has a 20d, and it is a different
 * drawing.) What 20d prescribes about *behaviour* rather than appearance —
 * line numbers, hunk headers naming the enclosing symbol, `next hunk`
 * paging — is answered by the spec, not here; the spec says why.
 *
 * Syntax colours are the one place the canvas is deliberately not followed:
 * they are shiki's `github-dark-default`, the same theme and the same loader
 * the file viewer uses (adr `one-syntax-palette-for-all-code`). They sit
 * *inside* the diff's add/remove system rather than replacing it — the sign
 * column and the band say what a row is, the token colours say what the code
 * is, and the two never contend for the same channel.
 */

/**
 * Band and ink per row kind (canvas `Feature - Transcript blocks` 20d, the
 * `luminance` palette, and its "H · DIFF COLOUR — WHY LUMINANCE" table).
 *
 * The two sides are separated by **luminance, not hue**: an addition is a
 * raised light band under bright ink, a removal is a sunk dark band under
 * muted ink. That is why there is no green and no red here — 20d's own
 * reasoning is that green is a tag hue and red is `bypassPermissions`, and
 * light-in / shadow-out borrows neither and survives greyscale.
 *
 * This supersedes the six hues adr `diff-hues-are-content-not-state` drafted
 * before the artboard existed. That ADR's three axes — placement, redundancy,
 * never-a-status — all still hold, and hold more easily with no hue at all.
 */
const ROW_CLASSES: Record<DiffLine['kind'], string> = {
  add: 'bg-[rgba(200,225,255,.075)] text-[#f2f6fc]',
  del: 'bg-[rgba(0,0,0,.42)] text-[rgba(160,190,225,.56)]',
  context: 'text-[rgba(200,220,245,.62)]',
}

const GLYPH_CLASSES: Record<DiffLine['kind'], string> = {
  add: 'text-[#ffffff]',
  del: 'text-[rgba(160,190,225,.7)]',
  // 20d draws the context sign transparent: the column is held open so every
  // line's text starts at one x, but an unchanged line is not signed.
  context: 'text-transparent',
}

/** The sign is the primary channel; the band behind it is the second one.
 *  A reader in greyscale still reads the diff off the `+` and the `−`. */
const GLYPHS: Record<DiffLine['kind'], string> = { add: '+', del: '−', context: ' ' }

/** 20d's sign column: its own fixed, centred grid track, ahead of the text.
 *  The text cell's own inset follows it. */
const SIGN_COLUMN = 'inline-block w-[14px] shrink-0 select-none text-center'
const TEXT_CELL = 'whitespace-pre pl-[2px] pr-[10px]'

/**
 * How strongly a row's syntax tokens are drawn. 20d's table dims exactly one
 * kind — "removed line tokens · same hues · opacity .55" — and leaves added
 * and context lines at full strength, because in a luminance system the band
 * is what separates the sides and the ink must not fight it.
 *
 * This is the only place a token colour is altered. Dimming keeps the hue
 * shiki chose and lowers its luminance, which is the same axis the add/remove
 * system itself is separated on — so a dimmed keyword still reads as that
 * keyword, and a removed row still reads as removed.
 */
const TOKEN_OPACITY: Record<DiffLine['kind'], number> = {
  add: 1,
  del: 0.55,
  context: 1,
}

function Row({ line, tokens }: { line: DiffLine; tokens: CodeToken[] | null }) {
  return (
    <div className={['flex', ROW_CLASSES[line.kind]].join(' ')}>
      <span aria-hidden className={[SIGN_COLUMN, GLYPH_CLASSES[line.kind]].join(' ')}>
        {GLYPHS[line.kind]}
      </span>
      {/* `pre` rather than `pre-wrap`: a wrapped line breaks the column the
          signs stand in, which is the one thing a diff cannot afford. The
          block scrolls sideways instead.

          Without tokens this is the raw text in the row's own ink, which is
          what every row shows until shiki lands and what an unhighlightable
          file shows for good. The fallback is never an empty block. */}
      <span
        className={TEXT_CELL}
        style={tokens ? { opacity: TOKEN_OPACITY[line.kind] } : undefined}
      >
        {tokens
          ? tokens.map((token, index) => (
              // Tokens of one immutable line, in order: the index is stable.
              <span key={index} style={token.color ? { color: token.color } : undefined}>
                {token.content}
              </span>
            ))
          : line.text}
      </span>
    </div>
  )
}

/**
 * Tokens for one reassembled side, loaded once and then remembered. Plain
 * text renders on the first frame and the colours swap in when shiki
 * resolves — the same posture the file viewer and the transcript's code
 * blocks already take, and the reason a diff never blocks a render on a
 * lazily imported WASM grammar.
 */
function useFragmentTokens(text: string, lang: string, lineCount: number): CodeToken[][] | null {
  const [loaded, setLoaded] = useState<{ key: string; tokens: CodeToken[][] | null }>(() => ({
    key: `${lang} ${text}`,
    tokens: cachedFragmentTokens(text, lang, lineCount) ?? null,
  }))

  useEffect(() => {
    const key = `${lang} ${text}`
    const known = cachedFragmentTokens(text, lang, lineCount)
    if (known !== undefined) {
      setLoaded({ key, tokens: known })
      return
    }
    let cancelled = false
    void tokenizeFragment(text, lang, lineCount).then((tokens) => {
      if (!cancelled) setLoaded({ key, tokens })
    })
    return () => {
      cancelled = true
    }
  }, [text, lang, lineCount])

  // Tokens loaded for a different fragment would colour this one's rows by
  // position. Held to the fragment they were asked for.
  return loaded.key === `${lang} ${text}` ? loaded.tokens : null
}

/** Unchanged lines the hunking dropped — one marker, never rows. Sits in
 *  20d's hunk-header slot and takes its band and ink; the text lines up with
 *  the rows' text cell rather than with their sign column. */
function Gap({ count }: { count: number }) {
  return (
    <div className="flex items-center gap-2 bg-[rgba(150,205,255,.045)] py-[3px] pl-4 text-[rgba(160,190,225,.55)]">
      <span aria-hidden>⋯</span>
      <span>
        {count} unchanged {count === 1 ? 'line' : 'lines'}
      </span>
    </div>
  )
}

/** A sentence about what the diff is or is not — never styled as an error
 *  (20d-E: "failure is ink + wording, not red"). 20d's footnote ink. */
function Note({ children }: { children: React.ReactNode }) {
  return <div className="px-1 pb-1 text-[rgba(160,190,225,.6)]">{children}</div>
}

/**
 * 20d-C's "unknown" banner: the sentence that says Orbital does not hold the
 * side it is not drawing, on the same 135° hatch the artboard uses wherever
 * a value is missing rather than empty. The texture is the signal; the ink
 * stays the ordinary note ink, because not knowing is not an error.
 */
const UNKNOWN_HATCH = {
  backgroundImage:
    'repeating-linear-gradient(135deg,rgba(150,205,255,.06) 0 2px,transparent 2px 6px)',
}

function UnknownNote({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={UNKNOWN_HATCH}
      className="px-[10px] py-[6px] tracking-[.04em] text-[rgba(200,220,245,.8)]"
    >
      {children}
    </div>
  )
}

/**
 * The scrolling mono frame every change body sits in (20d-A/B/C for the
 * applied form, 20d-D/E for the proposed one).
 *
 * `proposed` is the dashed, dimmed variant the artboard gives an edit that
 * has not landed — a call that failed, or one still waiting. A solid frame
 * around a change that never reached the disk is the claim 20d exists to
 * avoid.
 */
function Frame({ children, proposed = false }: { children: React.ReactNode; proposed?: boolean }) {
  return (
    <div
      className={[
        'overflow-x-auto rounded-[7px] border py-1 font-mono text-[10.5px] leading-[1.6]',
        proposed
          ? 'border-dashed border-[rgba(150,205,255,.3)] bg-[rgba(10,15,26,.6)] opacity-[.72]'
          : 'border-[rgba(150,205,255,.18)] bg-[rgba(10,15,26,.9)]',
      ].join(' ')}
    >
      {children}
    </div>
  )
}

/**
 * Rows an unopened row may show. A diff that arrives open because of the
 * `transcript_edit_diffs` setting is a preview, not the change: it stops at
 * the first hunk and at this many lines, so turning the setting on cannot
 * turn a transcript into a wall of code (canvas `Feature - Transcript
 * blocks` 20f). Opening the row by hand is what shows all of it.
 */
export const DIFF_PREVIEW_LINES = 14

function DiffBody({
  diff,
  path,
  preview = false,
  proposed = false,
}: {
  diff: LineDiff
  path: string
  preview?: boolean
  proposed?: boolean
}) {
  // The preview keeps the first hunk only, and only its first lines. `skipped`
  // is left as it was: it counts what the diff dropped before this hunk, which
  // is true whether or not the preview then cuts the hunk short.
  const hunks = useMemo(
    () =>
      preview
        ? diff.hunks.slice(0, 1).map((h) => ({ ...h, lines: h.lines.slice(0, DIFF_PREVIEW_LINES) }))
        : diff.hunks,
    [diff, preview],
  )
  const shown = hunks.reduce((n, h) => n + h.lines.length, 0)
  const total = diff.hunks.reduce((n, h) => n + h.lines.length, 0)

  // Where each hunk's rows start in the flat row order the coordinates use.
  const hunkOffsets = useMemo(() => {
    let n = 0
    return hunks.map((hunk) => {
      const offset = n
      n += hunk.lines.length
      return offset
    })
  }, [hunks])

  const lang = languageFromPath(path).lang
  const sides = useMemo(() => diffSideTexts(hunks.flatMap((hunk) => hunk.lines)), [hunks])
  const beforeTokens = useFragmentTokens(sides.before, lang, sides.beforeLines)
  const afterTokens = useFragmentTokens(sides.after, lang, sides.afterLines)
  const tokensAt = (coord: DiffRowCoord | undefined): CodeToken[] | null => {
    if (!coord) return null
    const side = coord.side === 'before' ? beforeTokens : afterTokens
    return side?.[coord.line] ?? null
  }

  return (
    <Frame proposed={proposed}>
      {diff.coarse && (
        <Note>
          Too large to align line by line — shown as one replacement, so lines unchanged inside it
          are counted as changed.
        </Note>
      )}
      {hunks.map((hunk, hunkIndex) => (
        // A static list derived from one immutable diff: the index is stable.
        <div key={hunkIndex}>
          {hunk.skipped > 0 && <Gap count={hunk.skipped} />}
          {hunk.lines.map((line, lineIndex) => (
            <Row
              key={lineIndex}
              line={line}
              tokens={tokensAt(sides.coords[hunkOffsets[hunkIndex] + lineIndex])}
            />
          ))}
        </div>
      ))}
      {!preview && diff.trailingSkipped > 0 && <Gap count={diff.trailingSkipped} />}
      {preview && shown < total && (
        <Note>
          Showing the first {shown} of {total} lines — open the row for the rest.
        </Note>
      )}
      {!preview && diff.truncated && (
        <Note>
          {diff.truncatedLines} more {diff.truncatedLines === 1 ? 'line' : 'lines'} not shown — open
          the file to read the result.
        </Note>
      )}
      {diff.beforeEndsWithNewline !== diff.afterEndsWithNewline && (
        <Note>
          {diff.afterEndsWithNewline
            ? 'A trailing newline was added.'
            : 'The trailing newline was removed.'}
        </Note>
      )}
    </Frame>
  )
}

/** One-sided content: a `Write`'s new text, or a notebook cell's new source.
 *  `asAddition` is true only when the missing side is genuinely empty. */
function ContentBody({
  content,
  path,
  asAddition,
  preview = false,
  proposed = false,
}: {
  content: string
  path: string
  asAddition: boolean
  preview?: boolean
  proposed?: boolean
}) {
  const all = useMemo(() => splitLines(content), [content])
  const shown = useMemo(
    () => all.slice(0, preview ? DIFF_PREVIEW_LINES : DIFF_MAX_RENDERED_LINES),
    [all, preview],
  )
  const hidden = all.length - shown.length

  // One side, so one fragment — the rows shown, not the whole content: the
  // lines past the cut are never drawn and tokenizing them would be work
  // nobody sees.
  const lang = languageFromPath(path).lang
  const fragment = useMemo(() => shown.join('\n'), [shown])
  const tokens = useFragmentTokens(fragment, lang, shown.length)

  return (
    <Frame proposed={proposed}>
      {shown.map((text, index) => (
        <Row
          key={index}
          line={{ kind: asAddition ? 'add' : 'context', text }}
          tokens={tokens?.[index] ?? null}
        />
      ))}
      {hidden > 0 && (
        <Note>
          {hidden} more {hidden === 1 ? 'line' : 'lines'} not shown — open the file to read the
          result.
        </Note>
      )}
    </Frame>
  )
}

/** The micro-label the tool row puts over this block. */
export function changeSectionLabel(change: FileChange, isError: boolean): string {
  if (change.kind === 'edit') return isError ? 'PROPOSED DIFF' : 'DIFF'
  if (change.kind === 'write') {
    if (change.outcome === 'created') return 'NEW FILE'
    return isError ? 'PROPOSED CONTENTS' : 'CONTENTS WRITTEN'
  }
  if (change.mode === 'delete') return 'CELL DELETED'
  return change.mode === 'insert' ? 'CELL INSERTED' : 'CELL SOURCE'
}

export function ChangeView({
  change,
  isError = false,
  preview = false,
}: {
  change: FileChange
  isError?: boolean
  /** Drawn because the row arrived open, not because anyone opened it. */
  preview?: boolean
}) {
  if (change.kind === 'edit') {
    return (
      <div className="flex flex-col gap-1 font-mono text-[10.5px] leading-[1.6]">
        {change.replaceAll && (
          <Note>Applied to every occurrence in the file, not only the one shown.</Note>
        )}
        {change.diff.changed ? (
          <DiffBody diff={change.diff} path={change.path} preview={preview} proposed={isError} />
        ) : (
          <Note>The replacement is identical to what it replaced — nothing changed.</Note>
        )}
      </div>
    )
  }

  if (change.kind === 'write') {
    return (
      <div className="flex flex-col gap-1 font-mono text-[10.5px] leading-[1.6]">
        {/* The honest line. Orbital never held the previous contents of a file
            it did not itself read, so an overwrite has no before side to draw
            and says so rather than showing the new text as if it were all
            new. */}
        {change.outcome === 'replaced' && (
          <UnknownNote>
            Replaced the whole file. Orbital does not have the previous contents.
          </UnknownNote>
        )}
        {change.outcome === 'unknown' && (
          <UnknownNote>
            {isError
              ? 'The write did not complete — this is what it would have written.'
              : 'Whether this replaced an existing file is not known yet.'}
          </UnknownNote>
        )}
        <ContentBody
          content={change.content}
          path={change.path}
          asAddition={change.outcome === 'created'}
          preview={preview}
          proposed={isError}
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1 font-mono text-[10.5px] leading-[1.6]">
      {/* A replaced cell is the notebook's version of an overwrite: the new
          source is known and the old one never was, so it wears the same
          "unknown" hatch a `Write` over an existing file does. Deleting and
          inserting hide nothing, so they are ordinary notes. */}
      {change.mode === 'replace' ? (
        <UnknownNote>
          {`Replaced the source of cell ${change.cellId ?? '(unnamed)'}. Orbital does not have the previous source.`}
        </UnknownNote>
      ) : (
        <Note>
          {change.mode === 'delete'
            ? `Deleted cell ${change.cellId ?? '(unnamed)'}.`
            : `Inserted a cell${change.cellId ? ` after ${change.cellId}` : ' at the top'}.`}
        </Note>
      )}
      {change.mode !== 'delete' && (
        <ContentBody
          content={change.source}
          path={change.path}
          asAddition={change.mode === 'insert'}
          preview={preview}
          proposed={isError}
        />
      )}
    </div>
  )
}
