import type { ReactNode } from 'react'
import { formatBytes } from '../../lib/format'

/**
 * Canvas 10e — the viewer's states, all in the same image area and none red
 * (spec 2026-10-05-mobile-next § 0, § 2). The text preview borrows the same
 * blocks for its own loading, couldn't-load, gone and asleep answers.
 */

/** "116 of 186 KB" when both read in one unit (10e LOADING), else each with its own. */
export function progressLabel(received: number, total: number | null): string {
  if (total === null) return formatBytes(received)
  const [r, t] = [formatBytes(received), formatBytes(total)]
  const unit = (s: string) => s.slice(s.lastIndexOf(' ') + 1)
  return unit(r) === unit(t) ? `${r.slice(0, r.lastIndexOf(' '))} of ${t}` : `${r} of ${t}`
}

/**
 * 10e's reserved box: the image's own aspect, diagonal stripes, its size in
 * mono at the centre. `loading` is 10e LOADING's brighter stripes and label;
 * `quiet` is COULDN'T LOAD's and NOT CACHED's.
 */
export function ReservedBox({ w, h, label, tone }: { w: number; h: number; label: string; tone: 'loading' | 'quiet' }) {
  return (
    <div
      className={[
        'grid w-full place-items-center font-mono text-[9.5px]',
        tone === 'loading'
          ? 'bg-[repeating-linear-gradient(135deg,rgba(150,205,255,.07)_0_6px,rgba(150,205,255,.02)_6px_12px)] text-[rgba(160,190,225,.65)]'
          : 'bg-[repeating-linear-gradient(135deg,rgba(150,205,255,.05)_0_6px,rgba(150,205,255,.015)_6px_12px)] text-[rgba(160,190,225,.5)]',
      ].join(' ')}
      style={{ aspectRatio: `${w} / ${h}` }}
    >
      {label}
    </div>
  )
}

/** 10e LOADING, under the box: the byte bar and its count. No spinner. */
export function ByteBar({ received, total, mac }: { received: number; total: number | null; mac: string }) {
  const share = total ? Math.min(1, received / total) : 0
  return (
    <div className="flex flex-col gap-1.5 px-3.5">
      <span className="block h-0.5 rounded-[1px] bg-[rgba(150,205,255,.12)]">
        <span className="block h-full rounded-[1px] bg-[rgba(150,205,255,.55)]" style={{ width: `${share * 100}%` }} />
      </span>
      <span className="font-mono text-[9.5px] text-[rgba(160,190,225,.6)]">
        {progressLabel(received, total)} from {mac}
      </span>
    </div>
  )
}

/** 10e's sentence under the box: a 13px title and an 11.5px line, then an optional action. */
export function StateText({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 px-3.5">
      <span className="text-[13px] font-semibold">{title}</span>
      {children && <span className="text-[11.5px] leading-[1.45] text-[rgba(160,190,225,.7)] [text-wrap:pretty]">{children}</span>}
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
          ? 'border-[rgba(150,205,255,.14)] text-[12.5px] text-[rgba(220,235,255,.85)]'
          : 'border-[rgba(150,205,255,.22)] text-[13px] text-[#e8eef8]',
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
      <span aria-hidden className="block h-10 w-10 rounded-[10px] border-[1.5px] border-dashed border-[rgba(200,215,235,.4)]" />
      <span className="text-[13px] font-semibold">Not on {mac} any more</span>
      <span className="text-[11.5px] leading-[1.45] text-[rgba(160,190,225,.7)] [text-wrap:pretty]">
        {path ?? 'This image'} was moved or deleted after the agent saved it.
      </span>
    </div>
  )
}

/** 10e MAC ASLEEP · CACHED: one quiet chip saying it is the phone's copy, and how old. */
export function CachedChip({ asOf }: { asOf: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[rgba(150,205,255,.2)] px-[9px] py-1 font-mono text-[9.5px] text-[rgba(200,215,235,.8)]">
      <span aria-hidden className="block h-1.5 w-1.5 rounded-full border-[1.2px] border-[rgba(200,215,235,.6)]" />
      cached · {asOf}
    </span>
  )
}
