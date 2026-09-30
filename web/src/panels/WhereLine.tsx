import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement, Ref } from 'react'
import { lineGroups, linesReadout, prAriaLabel } from '../lib/branchStatus'
import type { LinesMode } from '../lib/branchStatus'
import { Tooltip } from '../ui/Tooltip'
import type { BranchLines, BranchPr, GitLocation } from '../lib/types'
import { BranchLinesTooltipContent, LineGroups, LinesTooltipContent, PrTooltipContent } from './BranchSuffixes'
import { fitWhereRow, whereFoldReservePx } from './whereFit'

/**
 * The detail header's first line: the path, and where that directory sits in
 * git (canvas `Feature - Git worktree` 1a/1f). A read-out, not a control —
 * no cursor change, no hover fill, no menu.
 *
 * After the branch, two opt-in suffixes (canvas `Feature - Branch status`):
 * the pull request's number, which is the row's one button, and the line
 * changes, another read-out. With neither, the row is exactly the one above.
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

/**
 * What the row spends on everything that is not the path and the branch: the
 * header's side padding, the icon group and the gaps between them (canvas
 * 1f's geometry). The fallback only, for a row nobody has measured: once the
 * header strip can fold (canvas 23c form 5) the icon group is two different
 * widths, and the split runs on the cell's measured width instead — which is
 * also how the path grows into what a fold gives back (23d).
 */
const ROW_CHROME_PX = 180

/**
 * How long the branch takes to fade out and back in when it changes. The
 * suffixes after it use the same fade (`Feature - Branch status` 1h), and the
 * strip waits it out before it re-judges the fold.
 */
export const BRANCH_FADE_MS = 130

/** 1h: the #PR's tooltip waits this long under the pointer; the lines' does not wait. */
const PR_TOOLTIP_DELAY_MS = 300

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

function readingKey(git: GitLocation | null): string {
  return git ? [git.ref, git.detached, git.worktree, git.defaultBranch].join('|') : ''
}

/**
 * A value on screen that lags the one from the server by a fade: the old one
 * fades out, is swapped, and the new one fades in. `keyOf` is what is drawn —
 * a change that draws the same (a tooltip-only detail) is taken at once,
 * without a fade. Another session replaces the value outright.
 *
 * The fade in waits two frames after the swap, so a suffix that was absent is
 * painted once at 0 and has something to fade from.
 */
function useFaded<T>(value: T, keyOf: (v: T) => string, sessionId: string | null): { shown: T; opacity: number } {
  const [shown, setShown] = useState<T>(value)
  const [opacity, setOpacity] = useState(1)
  const session = useRef(sessionId)
  const fadingIn = useRef(false)
  const valueKey = keyOf(value)
  const shownKey = keyOf(shown)

  useEffect(() => {
    if (session.current !== sessionId) {
      session.current = sessionId
      fadingIn.current = false
      setShown(value)
      setOpacity(1)
      return
    }
    if (valueKey === shownKey) {
      if (value !== shown) setShown(value)
      return
    }
    setOpacity(0)
    const timer = setTimeout(() => {
      fadingIn.current = true
      setShown(value)
    }, BRANCH_FADE_MS)
    return () => clearTimeout(timer)
  }, [value, shown, valueKey, shownKey, sessionId])

  useEffect(() => {
    if (!fadingIn.current) return
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        fadingIn.current = false
        setOpacity(1)
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [shown])

  return { shown, opacity }
}

const prKey = (pr: BranchPr | undefined) => (pr ? String(pr.number) : '')

export function WhereLine({
  path,
  fullPath,
  git,
  sessionId,
  panelWidthPx,
  cellWidthPx,
  ref,
  pr,
  lines,
  linesMode = 'off',
  folded = false,
  onFoldReserve,
}: {
  /** The path as the header has always drawn it — `shortenPath(cwd)`. */
  path: string
  /** The undisplayed whole of it, which only the screen reader gets. */
  fullPath: string
  git: GitLocation | null
  /** Switching sessions replaces the reading outright; only a branch switch fades. */
  sessionId: string | null
  /** The panel's current width — what the row has to divide up, less `ROW_CHROME_PX`. */
  panelWidthPx: number
  /**
   * This row's own width as laid out, when the owner measures it; it replaces
   * the estimate from `panelWidthPx`. The cell is `flex: 1`, so its width
   * never depends on the text split here — measuring it cannot loop.
   */
  cellWidthPx?: number
  /** The row's cell — the flex:1 box the header strip's fold watches (canvas 23d). */
  ref?: Ref<HTMLSpanElement>
  /** The branch's pull request, when the setting is on and there is one. */
  pr?: BranchPr
  /** The branch's line changes, when the setting is on. */
  lines?: BranchLines
  linesMode?: LinesMode
  /** Whether the header strip is folded now — the fold order's step 2. */
  folded?: boolean
  /**
   * What the strip's fold decision has to take off the cell's width for the
   * suffixes (`whereFoldReservePx`), reported once their fade has settled.
   */
  onFoldReserve?: (px: number) => void
}) {
  // The reading on screen, which lags the one from the server by the length
  // of the fade — the old branch fades out before the new one fades in.
  const { shown, opacity } = useFaded(git, readingKey, sessionId)
  const linesKey = useCallback((l: BranchLines | undefined) => JSON.stringify(lineGroups(l, linesMode)), [linesMode])
  const { shown: shownPr, opacity: prOpacity } = useFaded(pr, prKey, sessionId)
  const { shown: shownLines, opacity: linesOpacity } = useFaded(lines, linesKey, sessionId)

  const mark = shown ? markOf(shown) : null
  const markPx = mark ? MARK_PX[mark] + PATH_GAP_PX + MARK_GAP_PX : 0
  const available = cellWidthPx !== undefined && cellWidthPx > 0 ? cellWidthPx : panelWidthPx - ROW_CHROME_PX
  const branch = shown?.ref ?? ''
  const prText = shownPr ? `#${shownPr.number}` : ''
  // Line changes belong to a working tree, so they need its reading to hang off.
  const groups = shown ? lineGroups(shownLines, linesMode) : []
  const fit = fitWhereRow({ path, branch, markPx, cellPx: available, pr: prText, lines: groups, folded })
  const reservePx = whereFoldReservePx({ path, branch, markPx, pr: prText, lines: groups })
  useLayoutEffect(() => onFoldReserve?.(reservePx), [reservePx, onFoldReserve])

  const Mark = mark ? MARKS[mark] : null
  // The lines are no control, so a screen reader hears them here (1h).
  const label = readingLabel(fullPath, shown) + (groups.length > 0 ? ` · ${linesReadout(groups)}` : '')
  const cut = Boolean(shown) && fit.branch !== shown?.ref

  // Bubbles stay inside the header row (1h: "clamped to the panel").
  const cell = useRef<HTMLSpanElement | null>(null)
  const setCell = useCallback(
    (el: HTMLSpanElement | null) => {
      cell.current = el
      if (typeof ref === 'function') ref(el)
      else if (ref) (ref as { current: HTMLSpanElement | null }).current = el
    },
    [ref],
  )
  const row = useCallback(() => cell.current?.parentElement ?? null, [])
  const fade = (value: number) => ({ opacity: value, transition: `opacity ${BRANCH_FADE_MS}ms ease` })

  // The mark and the branch are one reading, so they are one hover target —
  // which also puts the bubble's left edge on the mark, where 1f aligns it.
  // `data-no-drag`: in a detached window this row is the title bar, and a
  // drag region would swallow the hover that raises the bubble.
  const reading = Mark ? (
    <span data-testid="git-reading" data-no-drag className="flex flex-none items-center" style={{ gap: MARK_GAP_PX }}>
      <Mark />
      <span style={{ color: BRANCH_INK, opacity, transition: `opacity ${BRANCH_FADE_MS}ms ease` }}>
        {fit.branch}
      </span>
    </span>
  ) : null

  return (
    <span
      ref={setCell}
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
      {fit.linesMoved && shown && shownLines ? (
        // Step 4 on: the lines left the row for this bubble, under the full
        // name, so the branch answers the pointer even when it is whole (1e).
        <Tooltip
          variant="panel"
          clampWithin={row}
          content={<BranchLinesTooltipContent lines={shownLines} branch={shown.ref} detached={shown.detached} />}
        >
          {reading as ReactElement<{ 'aria-describedby'?: string }>}
        </Tooltip>
      ) : cut && shown ? (
        <Tooltip variant="name" title={shown.ref}>
          {reading as ReactElement<{ 'aria-describedby'?: string }>}
        </Tooltip>
      ) : (
        reading
      )}
      {/* The #PR: neutral in every state — state, review and checks are one
          hover away (1f, N1). A real button: the fill, the pointer and the
          focus ring say so, ⏎ opens it, and the tooltip rises on focus too.
          Its padding is cancelled by its margin, so the text keeps the suffix
          rhythm and the fill spills into the gaps (1h). The desktop shell
          routes a window.open to the system browser. */}
      {shownPr && (
        <span className="flex flex-none" style={fade(prOpacity)}>
          <Tooltip
            variant="panel"
            delayMs={PR_TOOLTIP_DELAY_MS}
            clampWithin={row}
            content={<PrTooltipContent pr={shownPr} />}
          >
            <button
              type="button"
              aria-label={prAriaLabel(shownPr)}
              onClick={() => window.open(shownPr.url, '_blank', 'noopener')}
              className="-mx-1 flex-none cursor-pointer rounded-[5px] px-1 py-0.5 font-mono text-[11px] leading-[14px] text-[rgba(200,220,245,.85)] transition-colors duration-[120ms] ease-in-out hover:bg-[rgba(150,205,255,.09)] hover:text-[#e8eef8] focus-visible:text-[#e8eef8] focus-visible:shadow-[0_0_0_1px_oklch(85%_.12_205/.7)] focus-visible:outline-none"
            >
              {fit.pr}
            </button>
          </Tooltip>
        </span>
      )}
      {/* The line changes: a read-out — no fill, no cursor change, and the
          bubble opens at once (1f LINES · READ-OUT). */}
      {fit.lines.length > 0 && shownLines && shown && (
        <span className="flex flex-none" style={fade(linesOpacity)}>
          <Tooltip
            variant="panel"
            clampWithin={row}
            content={<LinesTooltipContent lines={shownLines} branch={shown.ref} detached={shown.detached} />}
          >
            <span data-no-drag data-testid="branch-lines" className="flex">
              <LineGroups groups={fit.lines} />
            </span>
          </Tooltip>
        </span>
      )}
    </span>
  )
}
