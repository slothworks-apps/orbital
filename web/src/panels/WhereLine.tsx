import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement, Ref } from 'react'
import { lineGroups, linesReadout, prAriaLabel } from '../lib/branchStatus'
import type { LinesMode } from '../lib/branchStatus'
import { Tooltip } from '../ui/Tooltip'
import type { BranchLines, BranchPr, GitLocation, OtherTree } from '../lib/types'
import {
  markOf,
  treeList,
  treesAriaLabel,
  treesCompactText,
  treesCountText,
  treesHeadText,
  treesMoreText,
  whereFormOf,
} from '../lib/whereForm'
import type { GitMark, WhereForm } from '../lib/whereForm'
import { LineGroups, LinesTooltipContent, PrTooltipContent } from './BranchSuffixes'
import { COUNT_MARK_GAP_PX, fitTreesRow, fitWhereRow, treesFoldReservePx, whereFoldReservePx } from './whereFit'
import type { CountMode, WhereCount } from './whereFit'

/**
 * The detail header's first line: the path, and where that directory sits in
 * git (canvas `Feature - Git worktree` 1a/1f). A read-out, not a control —
 * no cursor change, no hover fill, no menu.
 *
 * After the branch, two opt-in suffixes (canvas `Feature - Branch status`):
 * the pull request's number, which is the row's one button, and the line
 * changes, another read-out. With neither, the row is exactly the one above.
 *
 * Last, the count of other trees running subagents work in (`Feature - Git
 * worktree` turn 2, 2e; spec 2026-10-07-live-working-tree-design § 5): "+3
 * worktrees" after the suffixes (form A), or — on the default branch in the
 * main checkout — "3 worktrees" alone after the path (form B). Another
 * read-out, its list one hover away. `lib/whereForm.ts` decides the form.
 */

type Mark = GitMark

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

/** 2e: the worktree list's bubble — the Branch status shell, wider. */
const TREES_TOOLTIP_PX = 300

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

/** 2d/2k: where each mark sits in the list's 13 × 13 mark column. */
const LIST_MARK_OFFSET: Record<Mark, { left: number; top: number }> = {
  trunk: { left: 2.5, top: 0.5 },
  fork: { left: 1.5, top: 0.5 },
  tree: { left: 0, top: 0 },
}

function ListMark({ mark }: { mark: Mark }) {
  const Drawn = MARKS[mark]
  return (
    <span aria-hidden className="relative block" style={{ width: 13, height: 13 }}>
      <span className="absolute" style={LIST_MARK_OFFSET[mark]}>
        <Drawn />
      </span>
    </span>
  )
}

/**
 * 2d/2k: the trees running subagents work in — one block per tree (its mark
 * by its own git, the branch, the directory), then each subagent's task on
 * its own line behind a hanging "·", two lines at most. Text only: nothing
 * in it is a click target.
 */
function TreesTooltipContent({ form, trees }: { form: WhereForm; trees: readonly OtherTree[] }) {
  const list = treeList(trees)
  return (
    <span className="flex flex-col gap-[10px]">
      <span className="flex items-baseline gap-2 font-mono">
        <span className="text-[11px] text-text-bright">{treesHeadText(form)}</span>
        <span className="flex-1" />
        <span className="text-[10px] text-[rgba(160,190,225,.6)]">running subagents</span>
      </span>
      <span className="flex flex-col gap-2">
        {list.rows.map((row) => (
          <span
            key={row.root}
            className="grid grid-cols-[13px_minmax(0,1fr)_auto] items-center gap-x-[7px] gap-y-0.5 whitespace-nowrap font-mono text-[11px]"
          >
            <ListMark mark={row.mark} />
            <span className="min-w-0 overflow-hidden text-ellipsis text-text-bright">{row.branch}</span>
            <span className="text-[rgba(160,190,225,.6)]">{row.dir}</span>
            <span className="col-[2/4] flex flex-col gap-0.5 whitespace-normal">
              {row.agents.map((agent, i) => (
                <span
                  key={i}
                  className="grid grid-cols-[9px_minmax(0,1fr)] font-sans text-[12px] leading-[1.4] text-[rgba(190,212,238,.82)]"
                >
                  <span className="text-[rgba(160,190,225,.5)]">·</span>
                  <span className="line-clamp-2">{agent}</span>
                </span>
              ))}
            </span>
          </span>
        ))}
      </span>
      {list.more > 0 && (
        <span className="border-t border-[rgba(150,205,255,.1)] pt-2 font-mono text-[10.5px] text-[rgba(160,190,225,.6)]">
          {treesMoreText(list.more)}
        </span>
      )}
    </span>
  )
}

/** The count as the row draws it: the word, or the tree mark and the number (2e compact form). */
function CountReadout({ text, compact }: { text: string; compact: boolean }) {
  return (
    <>
      {compact && <TreeMark />}
      <span>{text}</span>
    </>
  )
}

/**
 * 1e, BRANCH · LINES MOVED IN, and 2e's last step: the full name, then
 * whatever left the row for this bubble, each under a hairline — the lines,
 * and the worktree count as the last line.
 */
function BranchMovedTooltipContent({
  branch,
  detached,
  lines,
  count,
}: {
  branch: string
  detached: boolean
  lines?: BranchLines
  count?: string
}) {
  const rule = <span className="block h-px bg-[rgba(150,205,255,.1)]" />
  return (
    <>
      <span className="font-mono text-[11px] leading-[1.45] text-text-bright [overflow-wrap:anywhere]">{branch}</span>
      {lines && rule}
      {lines && <LinesTooltipContent lines={lines} branch={branch} detached={detached} />}
      {count && rule}
      {count && (
        <span className="flex items-center font-mono text-[11px]" style={{ gap: COUNT_MARK_GAP_PX, color: PATH_INK }}>
          <CountReadout text={count} compact />
        </span>
      )}
    </>
  )
}

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
const readingShownKey = (r: { git: GitLocation | null; hidden: boolean }) => (r.hidden ? 'hidden' : readingKey(r.git))
const markShownKey = (mark: Mark | null) => mark ?? ''
const pathShownKey = (path: string) => path
/** The number and the form fade; the list under it is taken at once, so an open bubble updates in place (2e). */
const countShownKey = (c: { form: WhereForm }) => (c.form.kind === 'plain' ? '' : `${c.form.kind}|${c.form.count}`)

const NO_TREES: readonly OtherTree[] = []

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
  otherTrees,
}: {
  /** Where the session works now, shortened — `shortenPath(workingDirOf(session))`. Fades when it changes (2f). */
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
  /** The trees running subagents work in, other than this one — the count and its list (2e). */
  otherTrees?: readonly OtherTree[]
}) {
  const trees = otherTrees ?? NO_TREES
  const form = useMemo(() => whereFormOf(git, trees), [git, trees])
  const formB = form.kind === 'trees'

  // What is on screen lags the server by the length of the fade — the old
  // value fades out before the new one fades in. Each part fades on its own,
  // so only what changed moves: the path when the session changes trees, the
  // mark when it changes kind, the count when it changes number (2e, 2f).
  // Form B draws no reading, so a form change fades the reading out with it.
  const reading = useMemo(() => ({ git, hidden: formB }), [git, formB])
  const { shown: shownReading, opacity } = useFaded(reading, readingShownKey, sessionId)
  const { shown: shownMark, opacity: markOpacity } = useFaded(
    formB || !git ? null : markOf(git),
    markShownKey,
    sessionId,
  )
  const { shown: shownPath, opacity: pathOpacity } = useFaded(path, pathShownKey, sessionId)
  const counted = useMemo(() => ({ form, trees }), [form, trees])
  const { shown: shownCount, opacity: countOpacity } = useFaded(counted, countShownKey, sessionId)
  const linesKey = useCallback((l: BranchLines | undefined) => JSON.stringify(lineGroups(l, linesMode)), [linesMode])
  // Form B drops the suffixes with the branch (spec § 5).
  const { shown: shownPr, opacity: prOpacity } = useFaded(formB ? undefined : pr, prKey, sessionId)
  const { shown: shownLines, opacity: linesOpacity } = useFaded(formB ? undefined : lines, linesKey, sessionId)

  const shown = shownReading.hidden ? null : shownReading.git
  const shownForm = shownCount.form
  const count: WhereCount | null =
    shownForm.kind === 'plain' ? null : { full: treesCountText(shownForm), compact: treesCompactText(shownForm) }
  const markPx = shownMark && shown ? MARK_PX[shownMark] + PATH_GAP_PX + MARK_GAP_PX : 0
  const available = cellWidthPx !== undefined && cellWidthPx > 0 ? cellWidthPx : panelWidthPx - ROW_CHROME_PX
  const branch = shown?.ref ?? ''
  const prText = shownPr ? `#${shownPr.number}` : ''
  // Line changes belong to a working tree, so they need its reading to hang off.
  const groups = shown ? lineGroups(shownLines, linesMode) : []
  const rowInput = { path: shownPath, branch, markPx, pr: prText, lines: groups, count }
  // Form B, once its fade has swapped it in: the path and the count alone.
  const treesFit =
    shownReading.hidden && count ? fitTreesRow({ path: shownPath, cellPx: available, folded, count }) : null
  const fit = fitWhereRow({ ...rowInput, cellPx: available, folded })
  const reservePx = count && treesFit ? treesFoldReservePx({ path: shownPath, count }) : whereFoldReservePx(rowInput)
  useLayoutEffect(() => onFoldReserve?.(reservePx), [reservePx, onFoldReserve])

  const pathText = treesFit ? treesFit.path : fit.path
  const countMode: CountMode = treesFit ? treesFit.count : fit.count
  const Mark = shownMark && shown ? MARKS[shownMark] : null
  const countLabel = count ? treesAriaLabel(shownForm, shownCount.trees) : ''
  // The lines and the count are no control, so a screen reader hears them here (1h, 2e).
  const label =
    readingLabel(fullPath, shownReading.git) +
    (groups.length > 0 ? ` · ${linesReadout(groups)}` : '') +
    (countLabel ? ` · ${countLabel}` : '')
  const cut = Boolean(shown) && fit.branch !== shown?.ref
  // Steps 4 and 5: what left the row lives in the branch's bubble (1e, 2e).
  const linesMoved = !treesFit && fit.linesMoved && Boolean(shownLines)
  const countMoved = !treesFit && countMode === 'moved'

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
  const readingEl = Mark ? (
    <span data-testid="git-reading" data-no-drag className="flex flex-none items-center" style={{ gap: MARK_GAP_PX }}>
      <span className="flex" style={fade(markOpacity)}>
        <Mark />
      </span>
      <span style={{ color: BRANCH_INK, ...fade(opacity) }}>{fit.branch}</span>
    </span>
  ) : null

  // 2e: the count — a read-out like the lines, no fill, no cursor change, not
  // a tab stop; the list rises at once under the pointer.
  const countEl =
    count && (countMode === 'full' || countMode === 'compact') ? (
      <span className="flex flex-none" style={fade(countOpacity)}>
        <Tooltip
          variant="panel"
          widthPx={TREES_TOOLTIP_PX}
          clampWithin={row}
          content={<TreesTooltipContent form={shownForm} trees={shownCount.trees} />}
        >
          <span
            data-no-drag
            data-testid="where-trees"
            aria-label={countLabel}
            className="flex items-center"
            style={{ gap: COUNT_MARK_GAP_PX, color: PATH_INK }}
          >
            <CountReadout
              text={countMode === 'full' ? count.full : count.compact}
              compact={countMode === 'compact'}
            />
          </span>
        </Tooltip>
      </span>
    ) : null

  if (treesFit) {
    return (
      <span
        ref={setCell}
        aria-label={label}
        className="flex min-w-0 flex-1 cursor-default items-center whitespace-nowrap font-mono text-[11px]"
        style={{ gap: PATH_GAP_PX }}
      >
        <span className="min-w-0 overflow-hidden" style={{ color: PATH_INK, ...fade(pathOpacity) }}>
          {pathText}
        </span>
        {countEl}
      </span>
    )
  }

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
      <span className="min-w-0 overflow-hidden" style={{ color: PATH_INK, ...fade(pathOpacity) }}>
        {pathText}
      </span>
      {/* Only a cut name needs saying — a branch already on screen in full
          gets no bubble, because the row is a read-out and should stay quiet
          under the pointer (1f). */}
      {(linesMoved || countMoved) && shown && readingEl ? (
        // Step 4 on: the lines left the row for this bubble, under the full
        // name, so the branch answers the pointer even when it is whole (1e);
        // at step 5 the count follows them as its last line (2e).
        <Tooltip
          variant="panel"
          clampWithin={row}
          content={
            <BranchMovedTooltipContent
              branch={shown.ref}
              detached={shown.detached}
              lines={linesMoved ? shownLines : undefined}
              count={countMoved && count ? count.full : undefined}
            />
          }
        >
          {readingEl}
        </Tooltip>
      ) : cut && shown && readingEl ? (
        <Tooltip variant="name" title={shown.ref}>
          {readingEl}
        </Tooltip>
      ) : (
        readingEl
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
      {/* The count of other trees: the row's last suffix (2e). */}
      {countEl}
    </span>
  )
}
