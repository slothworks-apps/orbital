import { useState } from 'react'
import type { ChatMessage, CompactionMark as Mark } from '../lib/types'
import { Button } from '../ui/Button'
import { copyToClipboard } from '../lib/clipboard'
import { formatRecordForCopy } from './ErrorLog'
import {
  compactionDropPercent,
  compactionFailureRecord,
  formatCompactTokens,
  formatElapsed,
  formatMarkDuration,
  formatMarkTime,
} from '../lib/compaction'
import { useNow } from '../lib/useNow'

/**
 * Context compaction in the transcript (spec
 * 2026-09-28-context-compaction-design; canvas 26c, 26d): the permanent mark
 * a compaction leaves, and the live block while one runs. Neither is a chat
 * bubble, and neither folds into a tool run.
 */

/** 26d's failure red: the heading ink, its rules and the card's border. */
const FAILED_INK = 'oklch(80% .12 25)'
const FAILED_RULE = 'oklch(72% .17 25 / .4)'
const FAILED_BORDER = 'oklch(72% .17 25 / .3)'
/** The successful mark's copy (26d). */
const SUMMARY_NOTE =
  'Claude now works from a summary. Everything above stays here for you to read, but Claude no longer has it word for word.'
const FAILED_NOTE = 'Nothing was summarized, so Claude still has everything above.'

function Heading({ text, failed }: { text: string; failed: boolean }) {
  // 26d: mono 9.5 at .16em between two hairlines — grey for a cut, red for a
  // failure, which cut nothing and so is not drawn as a cut.
  const rule = failed ? FAILED_RULE : 'rgba(150,205,255,.3)'
  return (
    <div
      className="flex items-center gap-2.5 font-mono text-[9.5px] tracking-[0.16em]"
      style={{ color: failed ? FAILED_INK : 'rgba(214,228,246,.82)' }}
    >
      <span aria-hidden className="block h-px flex-1" style={{ background: rule }} />
      {text}
      <span aria-hidden className="block h-px flex-1" style={{ background: rule }} />
    </div>
  )
}

/** The meta line: trigger · (in terminal) · duration · time. A figure nobody reported is left out. */
function metaLine(mark: Mark, timestamp: string | undefined, terminal: boolean, now: number): string {
  const parts: string[] = [mark.trigger]
  if (terminal) parts.push('in terminal')
  if (mark.durationMs !== null) {
    const duration = formatMarkDuration(mark.durationMs)
    parts.push(mark.outcome === 'failed' ? `after ${duration}` : duration)
  }
  if (timestamp) {
    const at = Date.parse(timestamp)
    if (!Number.isNaN(at)) parts.push(formatMarkTime(at, now))
  }
  return parts.join(' · ')
}

export interface CompactionMarkProps {
  message: ChatMessage
  sessionId: string
  /** `N OF M` among the session's successful compactions; shown only when M > 1. */
  ordinal?: { n: number; of: number }
  /** A terminal session's mark: `in terminal` on the meta line. */
  terminal: boolean
  /** The session's context window, which the before → after bar is drawn against; null draws it against "before". */
  contextWindow: number | null
  /** The session's tag hue — the bar's "after" ties the mark to the planet (26d). */
  hue: number
  /** Present only on the newest failure of a live session: puts `/compact` into the composer. */
  onCompactAgain?: () => void
}

export function CompactionMark({
  message,
  sessionId,
  ordinal,
  terminal,
  contextWindow,
  hue,
  onCompactAgain,
}: CompactionMarkProps) {
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const mark = message.compaction
  if (!mark) return null
  const now = Date.now()
  const failed = mark.outcome === 'failed'
  const meta = metaLine(mark, message.timestamp, terminal, now)

  if (failed) {
    return (
      <div data-compaction-mark="failed" data-compaction-id={message.id} className="flex flex-col gap-2">
        <Heading text="COMPACTION FAILED" failed />
        <div
          className="flex flex-col gap-[9px] rounded-lg border bg-[rgba(4,8,16,.5)] px-3 py-2.5"
          style={{ borderColor: FAILED_BORDER }}
        >
          <div className="flex items-baseline gap-2 font-mono text-[10.5px] text-[rgba(160,190,225,.65)]">
            {mark.preTokens !== null && (
              <span className="text-[12.5px] text-[#e8eef8]">{formatCompactTokens(mark.preTokens)}</span>
            )}
            <span>unchanged</span>
            <span aria-hidden className="flex-1" />
            <span>{meta}</span>
          </div>
          {/* Quoted exactly — the reason is the one thing a developer needs. */}
          <div
            className="whitespace-pre-wrap break-words rounded-md bg-[rgba(2,4,9,.6)] px-2.5 py-2 font-mono text-[10.5px] leading-[1.55]"
            style={{ color: FAILED_INK }}
          >
            {mark.error ?? 'No reason given'}
          </div>
          <div className="text-xs leading-normal text-[rgba(190,212,238,.82)] [text-wrap:pretty]">{FAILED_NOTE}</div>
          <div className="flex items-center gap-2">
            <Button
              variant="pill"
              size="pill"
              aria-label="Copy the failed compaction"
              onClick={() => {
                void copyToClipboard(
                  formatRecordForCopy(compactionFailureRecord(sessionId, mark, message.timestamp)),
                ).then(setCopied)
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
            {onCompactAgain && (
              <Button variant="pill" size="pill" onClick={onCompactAgain}>
                /compact again
              </Button>
            )}
          </div>
        </div>
      </div>
    )
  }

  const drop = compactionDropPercent(mark)
  // The bar is drawn against the window when it is known (26d: 93 % → 11 %),
  // and against "before" when it is not — the shrink still reads.
  const scale = contextWindow ?? mark.preTokens
  const barPre = mark.preTokens !== null && scale ? Math.min(100, (mark.preTokens / scale) * 100) : null
  const barPost = mark.postTokens !== null && scale ? Math.min(100, (mark.postTokens / scale) * 100) : null
  const heading = ordinal && ordinal.of > 1 ? `CONTEXT COMPACTED · ${ordinal.n} OF ${ordinal.of}` : 'CONTEXT COMPACTED'

  return (
    <div data-compaction-mark="success" data-compaction-id={message.id} className="flex flex-col gap-2">
      <Heading text={heading} failed={false} />
      <div className="flex flex-col gap-[9px] rounded-lg border border-[rgba(150,205,255,.14)] bg-[rgba(4,8,16,.5)] px-3 py-2.5">
        <div className="flex items-baseline gap-2 font-mono text-[10.5px] text-[rgba(160,190,225,.65)]">
          {mark.preTokens !== null && (
            <span className="text-[12.5px] text-[#e8eef8]">
              {formatCompactTokens(mark.preTokens)}
              {mark.postTokens !== null && ` → ${formatCompactTokens(mark.postTokens)}`}
            </span>
          )}
          {drop !== null && <span>−{drop} %</span>}
          <span aria-hidden className="flex-1" />
          <span>{meta}</span>
        </div>
        {/* No "after", no bar: nothing is drawn that was not reported. */}
        {barPre !== null && barPost !== null && (
          <div aria-hidden className="relative h-[3px] rounded-[2px] bg-[rgba(150,205,255,.08)]">
            <span
              className="absolute inset-y-0 left-0 block rounded-[2px] bg-[rgba(160,190,225,.22)]"
              style={{ width: `${barPre}%` }}
            />
            <span
              className="absolute inset-y-0 left-0 block rounded-[2px]"
              style={{ width: `${barPost}%`, background: `oklch(80% .13 ${hue} / .85)` }}
            />
          </div>
        )}
        <div className="text-xs leading-normal text-[rgba(190,212,238,.82)] [text-wrap:pretty]">{SUMMARY_NOTE}</div>
        {mark.summary && (
          <>
            <button
              type="button"
              aria-expanded={summaryOpen}
              onClick={() => setSummaryOpen((open) => !open)}
              className="flex items-center gap-1.5 self-start font-mono text-[10.5px] text-[rgba(200,220,245,.8)] hover:text-[#e8eef8]"
            >
              <span
                aria-hidden
                className="inline-block text-[9px] text-[rgba(160,190,225,.6)] transition-transform duration-150"
                style={{ transform: summaryOpen ? 'rotate(90deg)' : 'none' }}
              >
                ▸
              </span>
              summary
            </button>
            {summaryOpen && (
              <pre className="m-0 whitespace-pre-wrap break-words rounded-md border border-[rgba(150,205,255,.1)] bg-[rgba(2,4,9,.6)] px-[11px] py-[9px] font-mono text-[10.5px] leading-[1.6] text-[rgba(170,195,225,.8)]">
                {mark.summary}
              </pre>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * The live `COMPACTING CONTEXT m:ss` block at the end of the transcript while
 * a compaction runs (26c). No progress is drawn — nothing reports any — only
 * the elapsed time and a sweep that says it is still going.
 */
export function CompactingBlock({
  startedAt,
  trigger,
  preTokens,
  contextWindow,
}: {
  startedAt: number
  trigger: 'manual' | 'auto'
  preTokens: number | null
  contextWindow: number | null
}) {
  const now = useNow(true)
  const of = contextWindow !== null ? ` of ${formatCompactTokens(contextWindow)}` : ''
  const at = preTokens !== null ? `${formatCompactTokens(preTokens)}${of}` : null
  const cause =
    trigger === 'manual'
      ? at
        ? `Manual: you ran /compact at ${at}.`
        : 'Manual: you ran /compact.'
      : at
        ? `Auto: the context reached ${at}.`
        : 'Auto: the context reached its limit.'
  return (
    <div
      data-compacting-block
      role="status"
      className="flex shrink-0 flex-col gap-2.5 rounded-[9px] border border-[rgba(150,205,255,.16)] bg-[rgba(4,8,16,.55)] px-3.5 py-3"
    >
      <div className="flex items-baseline gap-2 font-mono text-[10px] tracking-[0.16em] text-[rgba(214,228,246,.85)]">
        COMPACTING CONTEXT
        <span aria-hidden className="flex-1" />
        <span className="text-[11px] tracking-[0.04em] text-[#e8eef8]">{formatElapsed(now - startedAt)}</span>
      </div>
      <div aria-hidden className="relative h-[2px] overflow-hidden rounded-[1px] bg-[rgba(150,205,255,.1)]">
        <span className="orbital-shimmer absolute inset-y-0 left-0 block w-[30%] rounded-[1px] bg-[image:linear-gradient(90deg,transparent,rgba(214,228,246,.55),transparent)]" />
      </div>
      <div className="text-xs leading-normal text-[rgba(190,212,238,.8)] [text-wrap:pretty]">
        {cause} Claude is summarizing the conversation above and will carry on by itself when it&apos;s done.
      </div>
    </div>
  )
}
