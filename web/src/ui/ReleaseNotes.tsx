import type { ReleaseNoteSection } from '@orbital/shared/changelog'

/**
 * A version's notes by section, as WHAT'S NEW's dialog (canvas `Feature -
 * Notice toast` 1b) and the phone's sheet (2b) draw them: a mono title, then
 * its lines, each after a muted dash. Where they sit and the gap between
 * sections are the caller's.
 */
export function ReleaseNoteSections({ sections }: { sections: readonly ReleaseNoteSection[] }) {
  return (
    <>
      {sections.map((section) => (
        // 1b, 2b: 8 between the title and each line.
        <section key={section.title} aria-label={section.title} className="flex flex-col gap-2">
          <h3 className="font-mono text-[10px] font-normal tracking-[0.18em] text-[rgba(160,190,225,.6)]">{section.title}</h3>
          <ul className="flex flex-col gap-2">
            {section.items.map((item, i) => (
              <li key={i} className="flex gap-2.5 text-[14px] leading-[1.5] text-[rgba(214,226,242,.92)]">
                <span aria-hidden className="flex-none text-[rgba(160,190,225,.55)]">
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
