import { useLayoutEffect, useState } from 'react'
import type { ApiSession } from '../../lib/types'
import { treesCompactText, treesCountText, treesHeadText, whereFormOf } from '../../lib/whereForm'
import { basename } from '../format'
import { COUNT_MARK_GAP_PX, MARK_GAP_PX, charPxOf, fitWhere } from './fit'
import { TreeMark } from './marks'
import { TreesSheet } from './TreesSheet'

/**
 * The line under a session's title — project · ⎇ branch · worktree count —
 * in the session list row (9a) and the session screen's header (9b), as
 * canvas `Feature - Git worktree` 2h draws it (spec
 * 2026-10-07-live-working-tree-design, The phone).
 *
 * Form A: the branch, then "+3 worktrees" when running subagents work in
 * other trees. Form B, on the default branch in the main checkout: "3
 * worktrees" in place of ⎇ main. `lib/whereForm.ts` decides, as it does for
 * the desktop. A session in a worktree draws the tree mark where ⎇ stands.
 * What gives way in a narrow row is `fit.ts`'s. The count takes the line's
 * own ink: it is orientation, not an alert.
 *
 * In the list the row is the one tap target, so the count is only text and
 * its words join the row's name. In the header the count is a button whose ▾
 * opens the list of trees.
 */

/** 2h: the header's ▾ and the gap before it, which the count pays for in the fit. */
const CARET_PX = 13

const VARIANTS = {
  list: { fontPx: 11, text: 'text-[11px]', ink: 'text-[rgba(160,190,225,.7)]', dimInk: 'text-[rgba(160,190,225,.65)]' },
  header: { fontPx: 10.5, text: 'text-[10.5px]', ink: 'text-[rgba(160,190,225,.65)]', dimInk: 'text-[rgba(160,190,225,.65)]' },
} as const

/** The element's laid-out width, kept current; null until measured (and in jsdom, which lays nothing out). */
function useWidth(): [(el: HTMLElement | null) => void, number | null] {
  const [el, setEl] = useState<HTMLElement | null>(null)
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (!el) return
    const read = () => {
      const w = el.getBoundingClientRect().width
      setWidth(w > 0 ? w : null)
    }
    read()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(read)
    observer.observe(el)
    return () => observer.disconnect()
  }, [el])
  return [setEl, width]
}

export function WhereLine({
  session,
  dotColor,
  variant,
  dim = false,
}: {
  session: ApiSession
  /** The tag's colour, or the neutral one. */
  dotColor: string
  variant: 'list' | 'header'
  /** The list row's asleep ink. */
  dim?: boolean
}) {
  const [ref, width] = useWidth()
  const [open, setOpen] = useState(false)
  const v = VARIANTS[variant]
  const header = variant === 'header'
  const git = session.git ?? null
  const form = whereFormOf(git, session.otherTrees)
  const inWorktree = git?.worktree ?? false
  const fit = fitWhere({
    project: basename(session.cwd),
    branch: git?.ref ?? '',
    inWorktree,
    form,
    availPx: width,
    charPx: charPxOf(v.fontPx),
    caretPx: header ? CARET_PX : 0,
  })
  const sep = (
    <span aria-hidden className="shrink-0 text-[rgba(150,205,255,.3)]">
      ·
    </span>
  )
  const count =
    fit.count === 'none' ? null : (
      <span className="flex shrink-0 items-center" style={{ gap: COUNT_MARK_GAP_PX }}>
        {fit.count === 'compact' && <TreeMark />}
        <span>{fit.count === 'compact' ? treesCompactText(form) : treesCountText(form)}</span>
        {header && (
          <span aria-hidden className="text-[8px] text-[rgba(160,190,225,.6)]">
            ▾
          </span>
        )}
      </span>
    )

  return (
    <>
      <span
        ref={ref}
        className={['flex min-w-0 items-center gap-1.5 whitespace-nowrap font-mono', v.text, dim ? v.dimInk : v.ink].join(' ')}
      >
        <span aria-hidden className="block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: dotColor }} />
        <span className="shrink-0">{fit.project}</span>
        {fit.branch && (
          <>
            {sep}
            <span className="flex min-w-0 items-center" style={{ gap: MARK_GAP_PX }}>
              {inWorktree ? <TreeMark /> : <span aria-hidden>⎇</span>}
              <span className="truncate">{fit.branch}</span>
            </span>
          </>
        )}
        {count && sep}
        {count &&
          (header ? (
            // 2h: a 44 px hit area reaching above and below the line, nothing drawn for it.
            <button
              type="button"
              aria-label={`${treesHeadText(form)} with running subagents. Opens the list.`}
              aria-haspopup="dialog"
              aria-expanded={open}
              onClick={() => setOpen(true)}
              className="-mx-1.5 -my-[15px] flex shrink-0 items-center px-1.5 py-[15px]"
            >
              {count}
            </button>
          ) : (
            <>
              <span aria-hidden className="flex shrink-0">
                {count}
              </span>
              {/* 2h ONE TARGET: the count's words join the row's name. */}
              <span className="sr-only">, {treesHeadText(form)} busy</span>
            </>
          ))}
      </span>
      {open && <TreesSheet session={session} onClose={() => setOpen(false)} />}
    </>
  )
}
