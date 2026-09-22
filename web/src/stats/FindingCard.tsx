import { useState, type CSSProperties } from 'react'
import type { StatsFinding } from '../lib/types'
import { SEVERITY_STYLES } from './constants'
import { findingCopy, findingTurnUuid } from './findingCopy'
import { formatFindingTime } from './format'
import { sessionStatsPath } from './route'

/**
 * One card of the findings feed (canvas 10d). Four treatments over one
 * layout: CRITICAL and WARNING carry their own stripe and border, INFO the
 * quiet blue, and RESOLVED the same card dimmed with its headline struck
 * through.
 *
 * A card that belongs to a session is an anchor to `/stats/session/<id>` — a
 * real link, so the browser owns the navigation and ⌘-click opens a tab.
 * `slow-mcp` belongs to no session and is a plain card.
 *
 * The severity's three colours are handed to CSS as custom properties rather
 * than written into `style`, so the hover treatment can be a plain class: an
 * inline `background` would otherwise win over any `:hover` rule.
 */
export function FindingCard({
  finding,
  projectLabel,
  now,
  jump,
}: {
  finding: StatsFinding
  /** The readable path for the finding's project, or null when it has none. */
  projectLabel: string | null
  now?: number
  /**
   * The drilldown's variant of the same card (10b): the card is already inside
   * its session, so instead of linking to it, it offers the turn it blames and
   * the rule's "why this fired". Given the turn's chronological position.
   */
  jump?: { turnIndex: number; onJump: () => void }
}) {
  const [whyOpen, setWhyOpen] = useState(false)
  const style = SEVERITY_STYLES[finding.severity]
  const copy = findingCopy(finding)
  const resolved = finding.severity === 'resolved'
  const href =
    jump !== undefined || finding.sessionId === null
      ? null
      : sessionStatsPath(finding.sessionId, findingTurnUuid(finding.evidence))

  const cardVars = {
    '--card-ink': style.ink,
    '--card-stripe': style.stripe,
    '--card-border': style.cardBorder,
    '--card-fill': style.cardFill,
    '--card-chip': style.chipFill,
    '--card-chip-border': style.chipBorder,
    opacity: style.opacity,
  } as CSSProperties

  const base = [
    'group block rounded-xl border border-[var(--card-border)] bg-[var(--card-fill)] px-[14px] py-3',
    'shadow-[inset_2px_0_0_var(--card-stripe)] text-text-bright no-underline',
  ].join(' ')

  // 10d's hover: a brighter border in the card's own severity, a solider fill
  // and a 22px glow, over 120ms.
  const hover = [
    'cursor-pointer transition-[background-color,border-color,box-shadow] duration-[120ms]',
    'hover:border-[color-mix(in_oklab,var(--card-ink)_55%,transparent)] hover:bg-[rgba(8,14,26,.75)]',
    'hover:shadow-[inset_2px_0_0_var(--card-stripe),0_0_22px_color-mix(in_oklab,var(--card-ink)_12%,transparent)]',
  ].join(' ')

  const body = (
    <>
      <div className="flex items-center gap-2">
        <span className="rounded-[5px] border border-[var(--card-chip-border)] bg-[var(--card-chip)] px-[7px] py-0.5 font-mono text-[9px] tracking-[0.14em] text-[var(--card-ink)]">
          {finding.severity.toUpperCase()}
        </span>
        <span className="font-mono text-[10.5px] text-[rgba(160,190,225,.7)]">{finding.rule}</span>
        <span className="flex-1" />
        {/* No stamp on the drilldown (10b): every card there was measured on
            the one session the page is already headed with. */}
        {jump === undefined && (
          <span className="font-mono text-[10px] text-[rgba(160,190,225,.45)]">
            {formatFindingTime(finding.when, now)}
          </span>
        )}
      </div>

      <div
        className={`mt-2 text-[13px] font-semibold leading-[1.35] text-pretty ${
          resolved ? 'line-through decoration-[rgba(160,190,225,.5)]' : ''
        }`}
      >
        {copy.headline}
      </div>

      {copy.evidence !== '' && (
        <div className="mt-1.5 font-mono text-[10.5px] leading-[1.55] text-[rgba(160,190,225,.75)]">
          {copy.evidence}
        </div>
      )}

      {jump !== undefined ? (
        <>
          <div className="mt-[9px] flex items-center gap-4 font-mono text-[10.5px]">
            <button type="button" onClick={jump.onJump} className="cursor-pointer text-[#8fd8ff]">
              jump to turn {jump.turnIndex + 1} ›
            </button>
            {copy.why !== undefined && (
              <button
                type="button"
                aria-expanded={whyOpen}
                onClick={() => setWhyOpen(!whyOpen)}
                className="cursor-pointer text-[rgba(160,190,225,.65)]"
              >
                why this fired
              </button>
            )}
          </div>
          {whyOpen && copy.why !== undefined && (
            <div className="mt-2 border-t border-[rgba(150,205,255,.1)] pt-2 text-[11.5px] leading-[1.55] text-pretty text-[rgba(160,190,225,.75)]">
              {copy.why}
            </div>
          )}
        </>
      ) : (
      <div className="mt-[9px] flex items-center gap-2 font-mono text-[10.5px]">
        {copy.scope !== undefined ? (
          <span className="text-[rgba(160,190,225,.6)]">{copy.scope}</span>
        ) : (
          <span className="truncate text-[#8fd8ff]">
            {[projectLabel, finding.title].filter(Boolean).join(' · ') || 'this session'}
          </span>
        )}
        <span className="flex-1" />
        {href === null ? (
          <span className="text-[rgba(160,190,225,.45)]">→</span>
        ) : (
          <>
            <span className="whitespace-nowrap text-[rgba(160,190,225,.45)] group-hover:hidden">
              →
            </span>
            <span className="hidden whitespace-nowrap text-[var(--card-ink)] group-hover:inline">
              open session →
            </span>
          </>
        )}
      </div>
      )}
    </>
  )

  if (href === null) {
    return (
      <article className={base} style={cardVars}>
        {body}
      </article>
    )
  }

  return (
    <a href={href} className={`${base} ${hover}`} style={cardVars}>
      {body}
    </a>
  )
}
