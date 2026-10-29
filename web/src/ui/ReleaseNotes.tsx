import type { ReleaseNoteSection, ReleaseNotes } from '@orbital/shared/changelog'

/**
 * A version's notes by section, as WHAT'S NEW's dialog (canvas `Feature -
 * Notice toast` 1b) and the phone's sheet (2b) draw them: a mono title, then
 * its lines, each after a muted dash. Where they sit and the gap between
 * sections are the caller's.
 */
export function ReleaseNoteSections({
  sections,
  heading: Heading = 'h3',
}: {
  sections: readonly ReleaseNoteSection[]
  /** `h4` under a version's own heading (`ReleaseNoteVersions`). */
  heading?: 'h3' | 'h4'
}) {
  return (
    <>
      {sections.map((section) => (
        // 1b, 2b: 8 between the title and each line.
        <section key={section.title} aria-label={section.title} className="flex flex-col gap-2">
          <Heading className="font-mono fs-10 font-normal tracking-[0.18em] text-ink-900/60">{section.title}</Heading>
          <ul className="flex flex-col gap-2">
            {section.items.map((item, i) => (
              <li key={i} className="flex gap-2.5 fs-14 leading-[1.5] text-ink-400/92">
                <span aria-hidden className="flex-none text-ink-900/55">
                  –
                </span>
                <span className="[text-wrap:pretty]">{item}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  )
}

/**
 * The notes of every version WHAT'S NEW tells, newest first (spec
 * 2026-10-19-whats-new-design § After skipping versions). One version reads
 * as the canvas draws it, its sections alone; after skipping, each version
 * is a block of its own under its number and date, ruled off from the one
 * before. `gap` is the caller's space between sections, kept inside a block
 * and, as `ruled` (the same space as a padding-top class), under each rule.
 */
export function ReleaseNoteVersions({ notes, gap, ruled }: { notes: readonly ReleaseNotes[]; gap: string; ruled: string }) {
  if (notes.length === 1) return <ReleaseNoteSections sections={notes[0].sections} />
  return (
    <>
      {notes.map((n, i) => (
        <section
          key={n.version}
          aria-label={`Orbital ${n.version}`}
          className={['flex flex-col', gap, i > 0 ? `border-t border-line/10 ${ruled}` : ''].join(' ')}
        >
          <h3 className="flex items-baseline gap-2.5">
            <span className="fs-14 font-semibold text-ink-100">{n.version}</span>
            {n.date && <span className="font-mono fs-11 font-normal text-ink-900/55">{n.date}</span>}
          </h3>
          <ReleaseNoteSections sections={n.sections} heading="h4" />
        </section>
      ))}
    </>
  )
}
