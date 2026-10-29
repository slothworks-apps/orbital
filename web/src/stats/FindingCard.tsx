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
    'shadow-[inset_2px_0_0_var(--card-stripe)] text-ink-100 no-underline',
  ].join(' ')

  // 10d's hover: a brighter border in the card's own severity, a solider fill
  // and a 22px glow, over 120ms.
  const hover = [
    'cursor-pointer transition-[background-color,border-color,box-shadow] duration-[120ms]',
    'hover:border-[color-mix(in_oklab,var(--card-ink)_55%,transparent)] hover:bg-panel/75',
    'hover:shadow-[inset_2px_0_0_var(--card-stripe),0_0_22px_color-mix(in_oklab,var(--card-ink)_12%,transparent)]',
  ].join(' ')

  const body = (
    <>
      <div className="flex items-center gap-2">
        <span className="rounded-[5px] border border-[var(--card-chip-border)] bg-[var(--card-chip)] px-[7px] py-0.5 font-mono fs-9 tracking-[0.14em] text-[var(--card-ink)]">
          {finding.severity.toUpperCase()}
        </span>
        <span className="font-mono fs-10.5 text-ink-900/70">{finding.rule}</span>
        <span className="flex-1" />
        {/* No stamp on the drilldown (10b): every card there was measured on
            the one session the page is already headed with. */}
        {jump === undefined && (
          <span className="font-mono fs-10 text-ink-900/45">
            {formatFindingTime(finding.when, now)}
          </span>
        )}
      </div>

      <div
        className={`mt-2 fs-13 font-semibold leading-[1.35] text-pretty ${
          resolved ? 'line-through decoration-ink-900/50' : ''
        }`}
      >
        {copy.headline}
      </div>

      {copy.evidence !== '' && (
        <div className="mt-1.5 font-mono fs-10.5 leading-[1.55] text-ink-900/75">
          {copy.evidence}
        </div>
      )}

      {jump !== undefined ? (
        <>
          <div className="mt-[9px] flex items-center gap-4 font-mono fs-10.5">
            <button type="button" onClick={jump.onJump} className="cursor-pointer text-sky">
              jump to turn {jump.turnIndex + 1} ›
            </button>
            {copy.why !== undefined && (
              <button
                type="button"
                aria-expanded={whyOpen}
                onClick={() => setWhyOpen(!whyOpen)}
                className="cursor-pointer text-ink-900/65"
              >
                why this fired
              </button>
            )}
          </div>
          {whyOpen && copy.why !== undefined && (
            <div className="mt-2 border-t border-line/10 pt-2 fs-11.5 leading-[1.55] text-pretty text-ink-900/75">
              {copy.why}
            </div>
          )}
        </>
      ) : (
      <div className="mt-[9px] flex items-center gap-2 font-mono fs-10.5">
        {copy.scope !== undefined ? (
          <span className="text-ink-900/60">{copy.scope}</span>
        ) : (
          <span className="truncate text-sky">
            {[projectLabel, finding.title].filter(Boolean).join(' · ') || 'this session'}
          </span>
        )}
        <span className="flex-1" />
        {href === null ? (
          <span className="text-ink-900/45">→</span>
        ) : (
          <>
            <span className="whitespace-nowrap text-ink-900/45 group-hover:hidden">
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
