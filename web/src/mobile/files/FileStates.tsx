import type { ReactNode } from 'react'
import { formatBytes } from '../../lib/format'

/**
 * Canvas 10e — the viewer's states, all in the same image area and none red
 * (spec 2026-10-05-mobile-next § 0, § 2); loading is 10e2's moon
 * (`ui/MoonLoader.tsx`). The text preview borrows the same blocks for its own
 * loading, couldn't-load, gone and asleep answers.
 */

/** "116 of 186 KB" when both read in one unit (10e LOADING), else each with its own. */
export function progressLabel(received: number, total: number | null): string {
  if (total === null) return formatBytes(received)
  const [r, t] = [formatBytes(received), formatBytes(total)]
  const unit = (s: string) => s.slice(s.lastIndexOf(' ') + 1)
  return unit(r) === unit(t) ? `${r.slice(0, r.lastIndexOf(' '))} of ${t}` : `${r} of ${t}`
}

/**
 * 10e's reserved box: the image's own aspect, quiet diagonal stripes, its
 * size in mono at the centre — COULDN'T LOAD's and NOT CACHED's. Loading has
 * the moon instead (10e2).
 */
export function ReservedBox({ w, h, label }: { w: number; h: number; label: string }) {
  return (
    <div
      className="grid w-full place-items-center bg-[repeating-linear-gradient(135deg,color-mix(in_oklab,_var(--color-line)_5%,_transparent)_0_6px,color-mix(in_oklab,_var(--color-line)_1.5%,_transparent)_6px_12px)] font-mono fs-9.5 text-ink-900/50"
      style={{ aspectRatio: `${w} / ${h}` }}
    >
      {label}
    </div>
  )
}

/** The text and PDF previews' loading: the byte bar and its count. */
export function ByteBar({ received, total, mac }: { received: number; total: number | null; mac: string }) {
  const share = total ? Math.min(1, received / total) : 0
  return (
    <div className="flex flex-col gap-1.5 px-3.5">
      <span className="block h-0.5 rounded-[1px] bg-line/12">
        <span className="block h-full rounded-[1px] bg-line/55" style={{ width: `${share * 100}%` }} />
      </span>
      <span className="font-mono fs-9.5 text-ink-900/60">
        {progressLabel(received, total)} from {mac}
      </span>
    </div>
  )
}

/** 10e's sentence under the box: a 13px title and an 11.5px line, then an optional action. */
export function StateText({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 px-3.5">
      <span className="fs-13 font-semibold">{title}</span>
      {children && <span className="fs-11.5 leading-[1.45] text-ink-900/70 [text-wrap:pretty]">{children}</span>}
      {action}
    </div>
  )
}

/** 10e's Retry, and the shape of every 44px outlined action in the image area. */
export function StateButton({ children, onClick, quiet = false }: { children: ReactNode; onClick: () => void; quiet?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'grid h-11 place-items-center rounded-[12px] border font-semibold',
        quiet
          ? 'border-line/14 fs-12.5 text-ink-200/85'
          : 'border-line/22 fs-13 text-ink-100',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

/** 10e THE FILE IS GONE: a dashed square, the sentence, centred. No Retry — it would not help. */
export function GoneBlock({ path, mac }: { path: string | null; mac: string }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 text-center">
      <span aria-hidden className="block h-10 w-10 rounded-[10px] border-[1.5px] border-dashed border-ink-600/40" />
      <span className="fs-13 font-semibold">Not on {mac} any more</span>
      <span className="fs-11.5 leading-[1.45] text-ink-900/70 [text-wrap:pretty]">
        {path ?? 'This image'} was moved or deleted after the agent saved it.
      </span>
    </div>
  )
}

/** 10e MAC ASLEEP · CACHED: one quiet chip saying it is the phone's copy, and how old. */
export function CachedChip({ asOf }: { asOf: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line/20 px-[9px] py-1 font-mono fs-9.5 text-ink-600/80">
      <span aria-hidden className="block h-1.5 w-1.5 rounded-full border-[1.2px] border-ink-600/60" />
      cached · {asOf}
    </span>
  )
}
