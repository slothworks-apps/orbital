import { DIFF_MAX_RENDERED_LINES, splitLines, type DiffLine, type LineDiff } from '../lib/diff'
import type { FileChange } from '../lib/fileEdit'

/**
 * An editing tool call's change, drawn as a diff (spec:
 * 2026-09-23-edit-diffs-in-the-transcript). Lives in the transcript, at the
 * tool call — the file viewer stays a snapshot and stays diff-free
 * (2026-09-19-file-viewer-design § "Reading, never editing").
 *
 * No canvas artboard covers this yet, so every value here is a transcript
 * token already in use — the `<pre>` blocks' 10.5px mono at 1.6, the tool
 * row's hairline borders, `SectionLabel`'s muted ink — apart from the two
 * change hues, which adr `diff-hues-are-content-not-state` argues for.
 */

/** Ink and wash per row kind. Context is dimmer than a plain result block:
 *  in a diff the unchanged lines are scenery, not content. */
const ROW_CLASSES: Record<DiffLine['kind'], string> = {
  add: 'bg-[oklch(78%_.11_145_/_.10)] text-[oklch(88%_.07_145)]',
  del: 'bg-[oklch(74%_.12_22_/_.10)] text-[oklch(87%_.07_22)]',
  context: 'text-[rgba(160,190,225,.55)]',
}

const GLYPH_CLASSES: Record<DiffLine['kind'], string> = {
  add: 'text-[oklch(78%_.13_145)]',
  del: 'text-[oklch(74%_.14_22)]',
  context: 'text-[rgba(160,190,225,.25)]',
}

/** The sign is the primary channel; the wash behind it is the second one.
 *  A reader who cannot separate the two hues still reads the diff. */
const GLYPHS: Record<DiffLine['kind'], string> = { add: '+', del: '−', context: ' ' }

function Row({ line }: { line: DiffLine }) {
  return (
    <div className={['flex', ROW_CLASSES[line.kind]].join(' ')}>
      <span
        aria-hidden
        className={['w-4 shrink-0 select-none pl-1', GLYPH_CLASSES[line.kind]].join(' ')}
      >
        {GLYPHS[line.kind]}
      </span>
      {/* `pre` rather than `pre-wrap`: a wrapped line breaks the column the
          signs stand in, which is the one thing a diff cannot afford. The
          block scrolls sideways instead. */}
      <span className="whitespace-pre pr-2">{line.text}</span>
    </div>
  )
}

/** Unchanged lines the hunking dropped — one marker, never rows. */
function Gap({ count }: { count: number }) {
  return (
    <div className="flex items-center gap-2 py-[3px] pl-1 text-[rgba(160,190,225,.4)]">
      <span aria-hidden>⋯</span>
      <span>
        {count} unchanged {count === 1 ? 'line' : 'lines'}
      </span>
    </div>
  )
}

/** A sentence about what the diff is or is not — never styled as an error. */
function Note({ children }: { children: React.ReactNode }) {
  return <div className="px-1 pb-1 text-[rgba(160,190,225,.55)]">{children}</div>
}

/** The scrolling mono frame every change body sits in. */
function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-[5px] border border-[rgba(150,205,255,.08)] bg-[rgba(2,5,11,.5)] py-1 font-mono text-[10.5px] leading-[1.6]">
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

function DiffBody({ diff, preview = false }: { diff: LineDiff; preview?: boolean }) {
  // The preview keeps the first hunk only, and only its first lines. `skipped`
  // is left as it was: it counts what the diff dropped before this hunk, which
  // is true whether or not the preview then cuts the hunk short.
  const hunks = preview
    ? diff.hunks.slice(0, 1).map((h) => ({ ...h, lines: h.lines.slice(0, DIFF_PREVIEW_LINES) }))
    : diff.hunks
  const shown = hunks.reduce((n, h) => n + h.lines.length, 0)
  const total = diff.hunks.reduce((n, h) => n + h.lines.length, 0)

  return (
    <Frame>
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
            <Row key={lineIndex} line={line} />
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
  asAddition,
  preview = false,
}: {
  content: string
  asAddition: boolean
  preview?: boolean
}) {
  const all = splitLines(content)
  const shown = all.slice(0, preview ? DIFF_PREVIEW_LINES : DIFF_MAX_RENDERED_LINES)
  const hidden = all.length - shown.length
  return (
    <Frame>
      {shown.map((text, index) => (
        <Row key={index} line={{ kind: asAddition ? 'add' : 'context', text }} />
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
          <DiffBody diff={change.diff} preview={preview} />
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
          <Note>Replaced the whole file. Orbital does not have the previous contents.</Note>
        )}
        {change.outcome === 'unknown' && (
          <Note>
            {isError
              ? 'The write did not complete — this is what it would have written.'
              : 'Whether this replaced an existing file is not known yet.'}
          </Note>
        )}
        <ContentBody
          content={change.content}
          asAddition={change.outcome === 'created'}
          preview={preview}
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1 font-mono text-[10.5px] leading-[1.6]">
      <Note>
        {change.mode === 'delete'
          ? `Deleted cell ${change.cellId ?? '(unnamed)'}.`
          : change.mode === 'insert'
            ? `Inserted a cell${change.cellId ? ` after ${change.cellId}` : ' at the top'}.`
            : `Replaced the source of cell ${change.cellId ?? '(unnamed)'}. Orbital does not have the previous source.`}
      </Note>
      {change.mode !== 'delete' && (
        <ContentBody
          content={change.source}
          asAddition={change.mode === 'insert'}
          preview={preview}
        />
      )}
    </div>
  )
}
