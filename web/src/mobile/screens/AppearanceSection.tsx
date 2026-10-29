import { colourThemeById } from '../../lib/colourTheme'
import { setPhoneColours, usePhoneColours } from '../platform/colourTheme'
import { useMobile } from '../state'
import { CARD, SectionLabel, Toggle } from '../ui'
import { ThemeSwatch } from './ThemeSwatch'

const FOLLOW_LABEL = 'Follow the system'

/**
 * Canvas `Feature - Colour themes` 1k A and C: Settings → APPEARANCE. One
 * Colours row, or with Follow the system on, one row per OS appearance; each
 * opens the Colours list. Just for this phone: the Mac keeps its own choice.
 */
export function AppearanceSection() {
  const choice = usePhoneColours((s) => s.choice)
  const painted = usePhoneColours((s) => s.painted)
  const openColours = useMobile((s) => s.openColours)
  const paintedKind = colourThemeById(painted)?.kind ?? 'dark'

  return (
    <>
      <SectionLabel>APPEARANCE</SectionLabel>
      <div className={CARD}>
        {choice.followSystem ? (
          <>
            <ColoursRow
              label="In light mode"
              theme={choice.light}
              live={paintedKind === 'light'}
              onOpen={() => openColours('light')}
            />
            <ColoursRow
              label="In dark mode"
              theme={choice.dark}
              live={paintedKind === 'dark'}
              divider
              onOpen={() => openColours('dark')}
            />
          </>
        ) : (
          <ColoursRow label="Colours" theme={choice.theme} live onOpen={() => openColours('theme')} />
        )}
        <div className="flex min-h-15 items-center gap-2.5 border-t border-line/8 py-2 pl-3.5 pr-1.5">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="fs-14 font-semibold">{FOLLOW_LABEL}</span>
            <span className="fs-11.5 leading-[1.4] text-ink-900/60">Switch with the phone&apos;s light / dark mode</span>
          </span>
          <Toggle
            label={FOLLOW_LABEL}
            checked={choice.followSystem}
            onChange={(next) => void setPhoneColours({ followSystem: next })}
          />
        </div>
      </div>
      <p className="px-1 pt-2 fs-12 leading-[1.5] text-ink-900/65">
        Just for this phone. Changing it here doesn&apos;t change your Mac, and the other way round.
      </p>
    </>
  )
}

/**
 * One row that opens the list. `live`: the row whose theme is painted now
 * carries its three dots, drawn from the live tokens (1k C: only the light
 * row has them while the phone is in light mode).
 */
function ColoursRow({
  label, theme, live, divider = false, onOpen,
}: {
  label: string
  theme: string
  live: boolean
  divider?: boolean
  onOpen: () => void
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={[
        'flex min-h-14 w-full items-center gap-2.5 pl-3.5 pr-2.5 text-left active:bg-line/6',
        divider ? 'border-t border-line/8' : '',
      ].join(' ')}
    >
      <span className="flex-1 fs-14 font-semibold">{label}</span>
      {live && <ThemeSwatch size="sm" />}
      <span className="fs-14 text-ink-900/60">{colourThemeById(theme)?.name}</span>
      <span aria-hidden className="w-5 text-center fs-18 text-ink-900/60">
        ›
      </span>
    </button>
  )
}
