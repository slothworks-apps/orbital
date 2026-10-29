import {
  COLOUR_THEME_KIND_LABEL,
  colourThemeInspiration,
  colourThemesOfKind,
  type ColourThemeKind,
} from '../../lib/colourTheme'
import { setPhoneColours, usePhoneColours } from '../platform/colourTheme'
import { useMobile } from '../state'
import { CARD, MobileScreen } from '../ui'
import { ThemeSwatch } from './ThemeSwatch'

const KINDS: readonly ColourThemeKind[] = ['dark', 'light']

/**
 * Canvas `Feature - Colour themes` 1k B: the Colours list, pushed over
 * Settings, grouped DARK / LIGHT. Opened for one OS appearance while
 * following the system, it lists that kind only (1k C). A tap paints the
 * phone at once and stays here; the list scrolls as themes are added.
 */
export function ColoursScreen() {
  const goBack = useMobile((s) => s.goBack)
  const slot = useMobile((s) => s.colourSlot)
  const current = usePhoneColours((s) => s.choice[slot])
  const kinds = slot === 'theme' ? KINDS : [slot]

  const header = (
    <div className="flex h-13 items-center gap-1 px-1.5">
      <button
        type="button"
        aria-label="Back"
        onClick={() => goBack()}
        className="grid h-11 w-11 place-items-center fs-28 leading-none text-ink-200/85"
      >
        ‹
      </button>
      <h1 className="flex-1 fs-17 font-bold">Colours</h1>
    </div>
  )

  return (
    <MobileScreen header={header}>
      <div className="flex flex-col px-4 pb-4 pt-0.5">
        {kinds.map((kind) => (
          <div key={kind} role="radiogroup" aria-label={COLOUR_THEME_KIND_LABEL[kind]}>
            <div className="px-1 pb-2 pt-4 font-mono fs-10 tracking-[0.16em] text-ink-900/60">
              {COLOUR_THEME_KIND_LABEL[kind]}
            </div>
            <div className={CARD}>
              {colourThemesOfKind(kind).map((theme, i) => {
                const on = theme.id === current
                const after = colourThemeInspiration(theme)
                return (
                  <button
                    key={theme.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => void setPhoneColours({ [slot]: theme.id })}
                    className={[
                      'flex min-h-13 w-full items-center gap-3 px-3.5 text-left active:bg-line/6',
                      i > 0 ? 'border-t border-line/8' : '',
                    ].join(' ')}
                  >
                    {/* The theme's own colours, not the live tokens: each row shows what it would paint. */}
                    <ThemeSwatch colours={theme.swatch} size="md" />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className={['fs-14.5', on ? 'font-bold' : 'font-medium'].join(' ')}>{theme.name}</span>
                      {after && <span className="font-mono fs-10.5 text-ink-900/60">{after}</span>}
                    </span>
                    <span aria-hidden className={['w-5 fs-16 text-accent', on ? '' : 'invisible'].join(' ')}>
                      ✓
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        ))}
        <p className="px-1 pt-2.5 fs-12 leading-[1.5] text-ink-900/65">Applies right away. Your Mac keeps its own choice.</p>
      </div>
    </MobileScreen>
  )
}
