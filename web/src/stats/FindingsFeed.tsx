import type { StatsFinding } from '../lib/types'
import { PANEL_CLASS, PANEL_LABEL_CLASS } from './constants'
import { FindingCard } from './FindingCard'
import { Scroller } from './Scroller'

/**
 * FINDINGS (canvas 10a), the feed of every rule that fired in the window.
 *
 * Below three sessions the feed says so instead of listing what it found
 * (10e, "empty"): three sessions is not enough for "cache-burn" to mean a
 * habit rather than one bad afternoon.
 */
const MIN_SESSIONS_TO_JUDGE = 3

export function FindingsFeed({
  findings,
  sessionCount,
  projectLabel,
}: {
  findings: StatsFinding[]
  sessionCount: number
  /** Maps a finding's transcript directory to a readable path. */
  projectLabel: (projectDir: string | null) => string | null
}) {
  const ruleCount = new Set(findings.map((f) => f.rule)).size
  const judging = sessionCount >= MIN_SESSIONS_TO_JUDGE

  return (
    <section
      aria-label="Findings"
      className={`${PANEL_CLASS} flex min-h-0 flex-1 flex-col gap-2 overflow-hidden px-[18px] py-4`}
    >
      <div className="flex items-baseline gap-2.5">
        <div className={PANEL_LABEL_CLASS}>FINDINGS</div>
        <span className="flex-1" />
        <div className="font-mono text-[10px] text-[rgba(160,190,225,.45)]">
          {findings.length} hits · {ruleCount} rules · click to open session
        </div>
      </div>

      {!judging || findings.length === 0 ? (
        <div className="font-mono text-[11px] leading-[1.55] text-[rgba(160,190,225,.6)]">
          {judging ? 'nothing to report in this window' : 'needs more sessions to judge'}
        </div>
      ) : (
        <Scroller wrapperClassName="flex-1" className="flex h-full flex-col gap-2.5 pr-1">
          {findings.map((finding, index) => (
            <FindingCard
              // A rule fires at most once per session, and `slow-mcp` at
              // most once per tool — but neither carries an id of its own,
              // so the index keeps the key unique for the window-level ones.
              key={`${finding.rule}-${finding.sessionId ?? index}`}
              finding={finding}
              projectLabel={projectLabel(finding.projectDir)}
            />
          ))}
        </Scroller>
      )}
    </section>
  )
}
