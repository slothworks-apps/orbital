import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { splitWhereRow } from '../lib/format'
import { Tooltip } from '../ui/Tooltip'
import type { GitLocation } from '../lib/types'

/**
 * The detail header's first line: the path, and where that directory sits in
 * git (canvas `Feature - Git worktree` 1a/1f). A read-out, not a control —
 * no cursor change, no hover fill, no menu.
 */

/** Which mark the reading draws. Picked here, never sent by the server. */
type Mark = 'trunk' | 'fork' | 'tree'

function markOf(git: GitLocation): Mark {
  if (git.worktree) return 'tree'
  return git.detached || git.defaultBranch ? 'trunk' : 'fork'
}

/** The marks' drawn widths, which the width split has to pay for. */
const MARK_PX: Record<Mark, number> = { trunk: 8, fork: 10, tree: 13 }

/** Gaps either side of the mark: path to mark, mark to branch. */
const PATH_GAP_PX = 9
const MARK_GAP_PX = 5

/** One character of the row's 11px JetBrains Mono, which is what the split counts in. */
const CHAR_PX = 6.6

/**
 * What the row spends on everything that is not the path and the branch: the
 * header's side padding, the icon group and the gaps between them (canvas
 * 1f's geometry). Taken off the panel's width rather than measured, so the
 * split is the same arithmetic the canvas modelled — the row's own
 * `overflow: hidden` is the safety net for the character or two the icon
 * group varies by.
 */
const ROW_CHROME_PX = 180

/** How long the branch takes to fade out and back in when it changes. */
const BRANCH_FADE_MS = 130

const MARK_INK = 'rgba(160,190,225,.75)'
/** A step above the path, so the branch does not read as another path segment. */
const BRANCH_INK = 'rgba(200,220,245,.85)'
const PATH_INK = 'rgba(160,190,225,.7)'

const STROKE = 1.4

function TrunkMark() {
  return (
    <span aria-hidden className="relative block flex-none" style={{ width: 8, height: 12, color: MARK_INK }}>
      <span className="absolute rounded-[1px] bg-current" style={{ left: 3.3, top: 0, width: STROKE, height: 12 }} />
      <span className="absolute rounded-full bg-current" style={{ left: 1, top: 3, width: 6, height: 6 }} />
    </span>
  )
}

function ForkMark() {
  return (
    <span aria-hidden className="relative block flex-none" style={{ width: 10, height: 12, color: MARK_INK }}>
      <span className="absolute rounded-[1px] bg-current" style={{ left: 1, top: 0, width: STROKE, height: 12 }} />
      <span
        className="absolute box-border"
        style={{
          left: 1,
          top: 4.4,
          width: 6.8,
          height: 4.8,
          borderRight: `${STROKE}px solid currentColor`,
          borderBottom: `${STROKE}px solid currentColor`,
          borderBottomRightRadius: 5,
        }}
      />
      <span
        className="absolute box-border rounded-full"
        style={{ left: 5.1, top: 0, width: 4.6, height: 4.6, border: `${STROKE}px solid currentColor` }}
      />
    </span>
  )
}

function TreeMark() {
  return (
    <span aria-hidden className="relative block flex-none" style={{ width: 13, height: 13, color: MARK_INK }}>
      <span className="absolute rounded-[1px] bg-current" style={{ left: 5.8, top: 4.2, width: STROKE, height: 8.8 }} />
      <span
        className="absolute box-border rounded-full"
        style={{ left: 4.2, top: 0, width: 4.6, height: 4.6, border: `${STROKE}px solid currentColor` }}
      />
      <span
        className="absolute rounded-[1px] bg-current"
        style={{ left: 5.8, top: 3.6, width: STROKE, height: 4.6, transformOrigin: '50% 100%', transform: 'rotate(-48deg)' }}
      />
      <span
        className="absolute box-border rounded-full"
        style={{ left: 0.2, top: 2.6, width: 4.2, height: 4.2, border: `${STROKE}px solid currentColor` }}
      />
      <span
        className="absolute rounded-[1px] bg-current"
        style={{ left: 5.8, top: 6.4, width: STROKE, height: 4.4, transformOrigin: '50% 100%', transform: 'rotate(48deg)' }}
      />
      <span
        className="absolute box-border rounded-full"
        style={{ left: 8.6, top: 5.2, width: 4.2, height: 4.2, border: `${STROKE}px solid currentColor` }}
      />
    </span>
  )
}

const MARKS: Record<Mark, () => ReactElement> = { trunk: TrunkMark, fork: ForkMark, tree: TreeMark }

/** The whole reading, for the screen reader and for the hover title. */
function readingLabel(path: string, git: GitLocation | null): string {
  if (!git) return path
  const kind = git.worktree ? 'Worktree' : 'Main checkout'
  const what = git.detached ? `detached at ${git.ref}` : `branch ${git.ref}`
  return `${kind} · ${what} · ${path}`
}

function sameReading(a: GitLocation | null, b: GitLocation | null): boolean {
  if (!a || !b) return a === b
  return a.ref === b.ref && a.detached === b.detached && a.worktree === b.worktree && a.defaultBranch === b.defaultBranch
}

export function WhereLine({
  path,
  fullPath,
  git,
  sessionId,
  panelWidthPx,
}: {
  /** The path as the header has always drawn it — `shortenPath(cwd)`. */
  path: string
  /** The undisplayed whole of it, which only the screen reader gets. */
  fullPath: string
  git: GitLocation | null
  /** Switching sessions replaces the reading outright; only a branch switch fades. */
  sessionId: string | null
  /** The panel's current width — what the row has to divide up. */
  panelWidthPx: number
}) {
  // The reading on screen, which lags the one from the server by the length
  // of the fade — the old branch fades out before the new one fades in.
  const [shown, setShown] = useState<GitLocation | null>(git)
  const [opacity, setOpacity] = useState(1)
  const session = useRef(sessionId)

  useEffect(() => {
    if (session.current !== sessionId) {
      session.current = sessionId
      setShown(git)
      setOpacity(1)
      return
    }
    if (sameReading(shown, git)) return
    setOpacity(0)
    const timer = setTimeout(() => {
      setShown(git)
      setOpacity(1)
    }, BRANCH_FADE_MS)
    return () => clearTimeout(timer)
  }, [git, shown, sessionId])

  const mark = shown ? markOf(shown) : null
  const markPx = mark ? MARK_PX[mark] + PATH_GAP_PX + MARK_GAP_PX : 0
  const room = Math.max(0, Math.floor((panelWidthPx - ROW_CHROME_PX - markPx) / CHAR_PX))
  const fit = splitWhereRow(path, shown?.ref ?? '', room)
  const Mark = mark ? MARKS[mark] : null
  const label = readingLabel(fullPath, shown)
  const cut = Boolean(shown) && fit.branch !== shown?.ref

  // The mark and the branch are one reading, so they are one hover target —
  // which also puts the bubble's left edge on the mark, where 1f aligns it.
  const reading = Mark ? (
    <span data-testid="git-reading" className="flex flex-none items-center" style={{ gap: MARK_GAP_PX }}>
      <Mark />
      <span style={{ color: BRANCH_INK, opacity, transition: `opacity ${BRANCH_FADE_MS}ms ease` }}>
        {fit.branch}
      </span>
    </span>
  ) : null

  return (
    <span
      aria-label={label}
      // No `overflow-hidden` here, however much it looks like it belongs: the
      // tooltip below hangs under the row, and a clip on this element cuts
      // away the whole bubble while the row goes on looking fine. The clip
      // lives on the path instead — the only part that can outgrow its share,
      // the reading being `flex-none` and sized to its own capped text.
      className="flex min-w-0 flex-1 cursor-default items-center whitespace-nowrap font-mono text-[11px]"
      style={{ gap: PATH_GAP_PX }}
    >
      <span className="min-w-0 overflow-hidden" style={{ color: PATH_INK }}>
        {fit.path}
      </span>
      {/* Only a cut name needs saying — a branch already on screen in full
          gets no bubble, because the row is a read-out and should stay quiet
          under the pointer (1f). */}
      {cut && shown ? (
        <Tooltip variant="name" title={shown.ref}>
          {reading as ReactElement<{ 'aria-describedby'?: string }>}
        </Tooltip>
      ) : (
        reading
      )}
    </span>
  )
}
