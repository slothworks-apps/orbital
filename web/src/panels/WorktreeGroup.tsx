import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { shortenPath } from '../lib/format'
import { useNow } from '../lib/useNow'
import type { WorktreeChoice } from '../lib/useWorktreeChoice'
import { tagColor, type Tag } from '../lib/types'
import {
  BASE_GROUPS,
  baseNote,
  baseRows,
  occupancyCopy,
  prTarget,
  worktreePathLine,
  type BaseRow,
} from '../lib/worktree'
import { useEscapeLayer } from '../ui/escapeLayer'
import { prefersReducedMotion } from '../ui/usePresence'
import { usePopupPosition } from '../ui/usePopupPosition'
import { ForkMark } from './WhereLine'

/** Worktree Group component: BRANCH and BASE unfold under the switch over this long, once. */
const UNFOLD_MS = 260
/** Worktree Group: the unfold's curve. */
const UNFOLD_EASE = 'cubic-bezier(.2,.8,.25,1)'
/** Worktree Group: the fields fade over this long as they unfold. */
const UNFOLD_FADE_MS = 200
/** Worktree Group: the fields stop clipping once the unfold has settled. */
const UNFOLD_SETTLE_MS = 280
/** Worktree Group: folded, the block pulls up by the group's gap, so it takes no room at all. */
const FOLDED_PULL_PX = -10
/** `local · 2 h old` reads in hours at the finest it needs. */
const AGE_TICK_MS = 60_000
/** Worktree Group: the dropdown hangs 6px under the BASE field. */
const DROPDOWN_GAP_PX = 6

/**
 * The fields' shared box (Worktree Group component): 9px/12px inside a 9px
 * radius over the well, mono 12px, so BRANCH and BASE line up. The edge is
 * the soft error ink while an error stands, the accent while BASE is open.
 */
function fieldBox(edge: 'rest' | 'error' | 'open'): string {
  return [
    'w-full min-w-0 rounded-[9px] border bg-space/60 px-3 py-[9px] font-mono fs-12 text-ink-100 outline-none transition-[border-color] duration-[180ms] ease-[ease]',
    edge === 'error' ? 'border-danger-pale/50' : edge === 'open' ? 'border-accent/50' : 'border-line/18',
  ].join(' ')
}

const SUB_LABEL = 'font-mono fs-9.5 tracking-[0.14em] text-ink-900/55'

/**
 * New session's WORKTREE group (spec 2026-11-02-work-in-a-worktree-design §
 * The WORKTREE group; canvas `Worktree Group` component, imported by 63a–63c),
 * under PROJECT DIRECTORY. Drawn only for a git repository (`choice.repo`).
 *
 * - A1 quiet: the WORKTREE kicker and the switch, one 18px line.
 * - A2 occupied: who works in the checkout and on which branch; their tag dot
 *   is the line's only colour, never a warning hue. Off by hand, it adds the
 *   consequence once.
 * - A3 on: BRANCH and BASE stacked, the PR target when the base is not the
 *   default, and where the worktree will be.
 * - A4: errors inline, each with its one fix; Launch waits meanwhile.
 *
 * The only motion: the switch (180ms), the unfold (260ms) and the dropdown's
 * arrival, each played once.
 */
export function WorktreeGroup({ choice, tags }: { choice: WorktreeChoice; tags: readonly Tag[] }) {
  const ids = useId()
  const repo = choice.repo
  const now = useNow(choice.fetch.state === 'failed', AGE_TICK_MS)
  if (!repo) return null

  const occupant = repo.occupants[0]
  const occupantTag = occupant ? tags.find((t) => String(t.id) === String(occupant.tagId)) : undefined
  const hint = occupant
    ? occupancyCopy(repo.occupants.length, occupant.branch ?? repo.currentBranch, choice.switchedOffByHand)
    : null
  const branchProblem = choice.problems.find((p) => p.field === 'branch')
  const baseProblem = choice.problems.find((p) => p.field === 'base')
  const target = prTarget(choice.base, repo.defaultBranch)

  return (
    <div className="flex flex-col gap-2.5" role="group" aria-label="Worktree">
      <div className="flex min-h-[18px] items-center gap-2">
        <span className="font-mono fs-10 tracking-[0.16em] text-ink-900/60">WORKTREE</span>
        <span aria-hidden className="flex-1" />
        <Switch on={choice.on} onChange={choice.setOn} />
      </div>
      {hint && occupant && (
        // A2: muted ink, the session's own tag dot, no icon.
        <p className="-mt-[3px] flex items-center gap-2 fs-12 leading-[1.45] text-ink-900/75 [text-wrap:pretty]">
          <span
            aria-hidden
            className="block h-1.5 w-1.5 flex-none rounded-full"
            style={{ background: occupantTag ? tagColor(occupantTag.hue) : 'currentColor' }}
          />
          <span>
            <span className="font-semibold text-ink-100">{occupant.title || 'A session'}</span>
            {hint.lead}
            {hint.branch && <span className="font-mono fs-11 text-ink-600/85">{hint.branch}</span>}
            {hint.tail}
          </span>
        </p>
      )}
      <Unfold open={choice.on}>
        <div className="flex min-w-0 flex-col gap-2.5">
          <div className="flex min-w-0 flex-col gap-2.5">
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className={`flex gap-1.5 ${SUB_LABEL}`}>
                BRANCH
                {!choice.branch.trim() && <span className="tracking-[0.04em] text-ink-900/45">· optional</span>}
              </span>
              <input
                id={`${ids}-branch`}
                type="text"
                spellCheck={false}
                autoComplete="off"
                aria-label="New branch name"
                aria-invalid={branchProblem !== undefined || undefined}
                placeholder={`${repo.branchForm}…`}
                value={choice.branch}
                onChange={(e) => choice.setBranch(e.target.value)}
                className={`${fieldBox(branchProblem ? 'error' : 'rest')} placeholder:text-ink-900/45`}
              />
            </label>
            <div className="flex min-w-0 flex-col gap-1.5">
              <span id={`${ids}-base`} className={SUB_LABEL}>
                BASE
              </span>
              <BasePicker
                labelledBy={`${ids}-base`}
                rows={baseRows(repo, choice.fetch)}
                value={choice.base}
                note={baseNote(choice.base, choice.fetch, repo.fetchedAt, now)}
                error={baseProblem !== undefined}
                onPick={choice.setBase}
              />
            </div>
          </div>
          {choice.problems.map((problem) => (
            // A4: the soft error ink, a mono `!`, the one fix in the accent.
            <p
              key={problem.field}
              role="alert"
              className="flex items-baseline gap-2 fs-12 leading-[1.45] text-danger-pale"
            >
              <span aria-hidden className="font-mono fs-11">
                !
              </span>
              <span className="flex-1">{problem.text}</span>
              {problem.action && (
                <button
                  type="button"
                  onClick={problem.action.run}
                  className="flex-none fs-12 font-semibold text-accent hover:text-ink-300"
                >
                  {problem.action.label}
                </button>
              )}
            </p>
          ))}
          {target && (
            // A3 stacked base: neutral ink with the fork mark.
            <p className="flex items-center gap-2 fs-12 text-ink-900/75">
              <ForkMark ink="currentColor" />
              <span>
                The PR will target <span className="font-mono fs-11 text-ink-600/85">{target}</span>, not{' '}
                {repo.defaultBranch}.
              </span>
            </p>
          )}
          <div className="truncate font-mono fs-10.5 text-ink-900/50">
            {worktreePathLine(shortenPath(repo.repoRoot), choice.branch)}
          </div>
        </div>
      </Unfold>
    </div>
  )
}

/**
 * BRANCH and BASE under the switch (Worktree Group component): always
 * mounted, opened and closed by `grid-template-rows` 0fr ↔ 1fr with the
 * group's gap pulled in, so the dialog's height follows the motion rather
 * than snapping. Closing hides it only once the height is gone; it clips
 * while it moves and stops clipping once it has settled open.
 */
function Unfold({ open, children }: { open: boolean; children: ReactNode }) {
  const [settled, setSettled] = useState(open)
  useEffect(() => {
    if (!open) {
      setSettled(false)
      return
    }
    const timer = setTimeout(() => setSettled(true), UNFOLD_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [open])
  const transition = prefersReducedMotion()
    ? 'none'
    : [
        `grid-template-rows ${UNFOLD_MS}ms ${UNFOLD_EASE}`,
        `margin-top ${UNFOLD_MS}ms ${UNFOLD_EASE}`,
        `opacity ${UNFOLD_FADE_MS}ms ease`,
        `visibility 0s linear ${open ? 0 : UNFOLD_MS}ms`,
      ].join(', ')
  return (
    <div
      data-unfold={open ? 'open' : 'closed'}
      aria-hidden={!open || undefined}
      inert={!open || undefined}
      className="grid min-w-0 grid-cols-[minmax(0,1fr)]"
      style={{
        gridTemplateRows: open ? '1fr' : '0fr',
        marginTop: open ? 0 : FOLDED_PULL_PX,
        opacity: open ? 1 : 0,
        visibility: open ? 'visible' : 'hidden',
        transition,
      }}
    >
      <div className="min-h-0" style={{ overflow: open && settled ? 'visible' : 'hidden' }}>
        {children}
      </div>
    </div>
  )
}

/**
 * The group's switch (Worktree Group component): the label before a 32×18
 * track with a 14px knob, accent and glowing when on; 180ms each way.
 */
function Switch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={[
        'flex items-center gap-2.5 fs-12.5 font-semibold transition-colors duration-[180ms] ease-[ease]',
        on ? 'text-ink-100' : 'text-ink-200/85',
      ].join(' ')}
    >
      Work in a worktree
      <span
        aria-hidden
        className={[
          'relative block h-[18px] w-8 flex-none rounded-[9px] transition-[background-color,box-shadow] duration-[180ms] ease-[ease]',
          on
            ? 'bg-accent shadow-[0_0_10px_color-mix(in_oklab,var(--color-accent)_50%,transparent)]'
            : 'bg-line/16',
        ].join(' ')}
      >
        <span
          className={[
            'absolute top-0.5 block h-3.5 w-3.5 rounded-full transition-[left,background-color] duration-[180ms] ease-[ease]',
            on ? 'left-4 bg-space-deep' : 'left-0.5 bg-ink-200/80',
          ].join(' ')}
        />
      </span>
    </button>
  )
}

/** A branch name with its `origin/` prefix stepped back (Worktree Group: the list's rows). */
function BranchName({ name }: { name: string }) {
  if (!name.startsWith('origin/')) return <>{name}</>
  return (
    <>
      <span className="text-ink-900/60">origin/</span>
      {name.slice('origin/'.length)}
    </>
  )
}

/**
 * BASE (Worktree Group component; canvas 63c A3): a field like BRANCH, and a
 * dropdown in the shell of every other picker — the main checkout's branch
 * and the default under their captions, a hairline, a search over local and
 * remote branches, and the branches in a list that scrolls past 178px.
 *
 * Portalled and placed by `usePopupPosition`, like `ui/Select`: the dialog's
 * body scrolls and would cut a dropdown hung inside it. The search field
 * holds focus while it is open; the arrows walk the rows, ⏎ picks, esc and a
 * click outside close it.
 */
function BasePicker({
  labelledBy,
  rows,
  value,
  note,
  error,
  onPick,
}: {
  labelledBy: string
  rows: BaseRow[]
  value: string
  note: string
  error: boolean
  onPick: (value: string) => void
}) {
  const listId = useId()
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const popupRef = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)
  const [entered, setEntered] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState<string | null>(null)

  const top = rows.filter((r) => r.group !== BASE_GROUPS.all)
  const needle = query.trim().toLowerCase()
  const listed = rows.filter((r) => r.group === BASE_GROUPS.all && (!needle || r.value.toLowerCase().includes(needle)))
  const pickable = [...top, ...listed]

  const close = (restoreFocus: boolean) => {
    setOpen(false)
    setEntered(false)
    setQuery('')
    if (restoreFocus) triggerRef.current?.focus()
  }
  const pick = (next: string) => {
    close(true)
    if (next !== value) onPick(next)
  }

  useEscapeLayer(open, () => close(true))
  usePopupPosition(open, triggerRef, popupRef, { gap: DROPDOWN_GAP_PX, matchAnchorWidth: true })

  // Arrives from 4px above at .98, two frames after it mounts, so the
  // browser has a resting frame to transition from.
  useEffect(() => {
    if (!open) return
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setEntered(true))
    })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target
      if (!(target instanceof Node)) return
      if (triggerRef.current?.contains(target) || popupRef.current?.contains(target)) return
      setOpen(false)
      setEntered(false)
      setQuery('')
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open])

  // The active row is scrolled into the list's view as the arrows move it.
  useEffect(() => {
    if (!open || active === null) return
    document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [open, active, listId])

  function onSearchKey(e: ReactKeyboardEvent<HTMLInputElement>) {
    const at = pickable.findIndex((r) => r.value === active)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (pickable.length === 0) return
      const next = e.key === 'ArrowDown' ? Math.min(pickable.length - 1, at + 1) : Math.max(0, at - 1)
      setActive(pickable[next].value)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      if (at >= 0) pick(pickable[at].value)
    } else if (e.key === 'Tab') {
      close(false)
    }
  }

  const rowId = (row: BaseRow) => `${listId}-${row.value}`
  const rowTint = (row: BaseRow) =>
    row.value === active ? 'bg-line/9' : row.value === value ? 'bg-line/7' : ''
  const check = (row: BaseRow) => (
    <span aria-hidden className={`flex-none font-mono fs-10 text-accent ${row.value === value ? '' : 'opacity-0'}`}>
      ✓
    </span>
  )
  const name = rows.find((r) => r.value === value)?.label ?? value

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-labelledby={labelledBy}
        onClick={() => (open ? close(true) : (setActive(value), setOpen(true)))}
        className={`${fieldBox(error ? 'error' : open ? 'open' : 'rest')} flex cursor-pointer items-center gap-2 overflow-hidden text-left`}
      >
        <span className="min-w-0 shrink truncate">{name}</span>
        <span className="min-w-0 shrink-[100] truncate fs-10.5 text-ink-900/55">{note}</span>
        <span aria-hidden className="flex-1" />
        <span
          aria-hidden
          className={`flex-none font-sans fs-8 text-ink-900/60 transition-transform duration-200 ease-[ease] ${open ? 'rotate-180' : ''}`}
        >
          ▾
        </span>
      </button>
      {open &&
        createPortal(
          <div
            ref={popupRef}
            role="listbox"
            id={listId}
            aria-labelledby={labelledBy}
            aria-activedescendant={active !== null && pickable.some((r) => r.value === active) ? `${listId}-${active}` : undefined}
            // Keeps a click on a row from taking focus out of the search field.
            onMouseDown={(e) => {
              if (!(e.target instanceof HTMLInputElement)) e.preventDefault()
            }}
            className={[
              'orbital-no-drag fixed z-[60] flex flex-col gap-0.5 rounded-[10px] border border-line/16 bg-panel/96 p-[5px] shadow-[0_14px_34px_color-mix(in_oklab,var(--color-shadow)_55%,transparent)] backdrop-blur-[12px]',
              'origin-top',
            ].join(' ')}
            // Worktree Group: from 4px above at .98 and transparent, to rest.
            style={{
              opacity: entered ? 1 : 0,
              transform: entered ? 'none' : 'translateY(-4px) scale(.98)',
              transition: prefersReducedMotion() ? 'none' : `opacity 160ms ease, transform 200ms ${UNFOLD_EASE}`,
            }}
          >
            {top.map((row, i) => (
              <div key={row.value} className="flex flex-col gap-0.5">
                {(i === 0 || top[i - 1].group !== row.group) && (
                  <div
                    role="presentation"
                    className="px-[9px] pb-[3px] pt-1.5 font-mono fs-9.5 tracking-[0.12em] text-ink-900/50"
                  >
                    {row.group}
                  </div>
                )}
                <div
                  id={rowId(row)}
                  role="option"
                  aria-selected={row.value === value}
                  onMouseMove={() => setActive(row.value)}
                  onClick={() => pick(row.value)}
                  className={`flex cursor-pointer items-center gap-2 rounded-[7px] px-[9px] py-[7px] ${rowTint(row)}`}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-px">
                    <span className="truncate font-mono fs-11.5 text-ink-100">
                      <BranchName name={row.label} />
                    </span>
                    {row.sub && <span className="truncate fs-11 text-ink-900/65">{row.sub}</span>}
                  </span>
                  {check(row)}
                </div>
              </div>
            ))}
            <div aria-hidden className="mx-[5px] my-[3px] h-px bg-line/10" />
            <input
              type="text"
              autoFocus
              spellCheck={false}
              aria-label="Search local and remote branches"
              placeholder="Search local and remote branches"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                const lower = e.target.value.trim().toLowerCase()
                const first = rows.find((r) => r.group === BASE_GROUPS.all && r.value.toLowerCase().includes(lower))
                setActive(lower ? (first?.value ?? null) : active)
              }}
              onKeyDown={onSearchKey}
              className="mx-1 mb-1 mt-0.5 rounded-[7px] border border-line/14 bg-space/60 px-[9px] py-[7px] font-mono fs-11.5 text-ink-100 outline-none placeholder:text-ink-900/45"
            />
            <div className="flex max-h-[178px] flex-col gap-0.5 overflow-y-auto overflow-x-hidden overscroll-contain">
              {listed.map((row) => (
                <div
                  key={row.value}
                  id={rowId(row)}
                  role="option"
                  aria-selected={row.value === value}
                  onMouseMove={() => setActive(row.value)}
                  onClick={() => pick(row.value)}
                  className={`flex shrink-0 cursor-pointer items-center gap-2 rounded-[7px] px-[9px] py-1.5 ${rowTint(row)}`}
                >
                  <span className="min-w-0 flex-1 truncate whitespace-nowrap font-mono fs-11.5 text-ink-100">
                    <BranchName name={row.label} />
                  </span>
                  {row.sub && <span className="flex-none font-mono fs-10 text-ink-900/50">{row.sub}</span>}
                  {check(row)}
                </div>
              ))}
              {listed.length === 0 && (
                <div className="px-[9px] py-2 font-mono fs-10.5 text-ink-900/55">
                  No branch matches “{query.trim()}”
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
