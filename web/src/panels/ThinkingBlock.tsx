import { useState } from 'react'
import type { ChatMessage } from '../lib/types'

export interface ThinkingBlockProps {
  message: ChatMessage
  /** See `TranscriptViewProps.compact` — selects the subagent panel's
   * hairline treatment over the parent transcript's box. */
  compact?: boolean
}

/**
 * Claude's reasoning block (`role: 'thinking'`), rendered as itself rather
 * than through `MessageView` — which computes `isUser = role === 'user'`
 * and draws everything else, `thinking` included, as an assistant markdown
 * bubble. That was the live defect this component closes: raw
 * chain-of-thought rendering as if the model had said it out loud (spec
 * `2026-09-22-subagent-transcript-panel-design.md` § 7).
 *
 * Rendered as plain text, deliberately not through `ReactMarkdown` the way
 * `MessageView`'s assistant prose is — looking like formatted prose is
 * exactly what made the bug invisible, and thinking is not prose the model
 * addressed to anyone.
 *
 * Two containers share one body, because the same content appears in two
 * places at two widths:
 *
 * - **Parent transcript (default):** canvas 1b's boxed treatment, matching
 *   the tool rows it sits among — `border-radius`, border and fill lifted
 *   straight from `ToolRow`'s collapsed/expanded pair.
 * - **Compact (the 380px subagent panel):** canvas 11b's left hairline rule
 *   instead of a box — boxed blocks stack badly at that width, and thinking
 *   is the most common block there.
 *
 * Collapsible in both, reusing `ToolRow`'s own fold idiom (a `▸`/`▾` caret
 * that swaps rather than rotates, an immediate show/hide with no fold
 * animation — this is one block, not a list of rows the way
 * `ToolRunGroup`'s stack is). The default state is the one thing that
 * differs by variant, on purpose: collapsed in the parent, where you are
 * reading the conversation and thinking is noise you opt into; expanded in
 * the panel, where the reasoning is the reason the panel is open.
 */
export function ThinkingBlock({ message, compact = false }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(compact)

  const caret = (
    <span aria-hidden className="w-2 shrink-0 text-[9px] text-[rgba(160,190,225,.6)]">
      {expanded ? '▾' : '▸'}
    </span>
  )
  // Canvas 11b's own THINKING label — 9px mono, .18em tracking — used
  // unchanged in both variants; only the container around the body differs.
  const label = (
    <span className="font-mono text-[9px] tracking-[0.18em] text-[rgba(160,190,225,.5)]">
      THINKING
    </span>
  )
  // Canvas 11b's own body typography, likewise shared — the spec is explicit
  // that this is the same content in two places, not a re-scaled copy of it.
  const body = expanded && message.text ? (
    <div className="whitespace-pre-wrap text-[12px] leading-[1.55] text-[rgba(190,212,238,.62)] [text-wrap:pretty]">
      {message.text}
    </div>
  ) : null

  if (compact) {
    return (
      <div data-role="thinking" data-thinking-variant="compact" className="border-l border-[rgba(150,205,255,.16)] pl-[10px]">
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          aria-label="Thinking"
          className="flex items-center gap-1.5"
        >
          {caret}
          {label}
        </button>
        {body && <div className="mt-1">{body}</div>}
      </div>
    )
  }

  return (
    <div
      data-role="thinking"
      data-thinking-variant="boxed"
      className={[
        'overflow-hidden rounded-[7px] border',
        // Same collapsed/expanded fill pair as `ToolRow` and `ToolRunGroup`,
        // so a thinking block reads as one more block of the same family
        // rather than a fourth, unrelated visual language.
        expanded
          ? 'border-[rgba(150,205,255,.18)] bg-[rgba(4,8,16,.55)]'
          : 'border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.45)]',
      ].join(' ')}
    >
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        aria-label="Thinking"
        className="flex w-full items-center gap-2 px-2.5 py-[7px] text-left"
      >
        {caret}
        {label}
      </button>
      {body && (
        <div className="border-t border-[rgba(150,205,255,.08)] px-3 pb-2.5 pt-2">{body}</div>
      )}
    </div>
  )
}
