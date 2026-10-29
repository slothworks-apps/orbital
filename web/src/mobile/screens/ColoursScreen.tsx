import { COLOUR_THEMES, DEFAULT_COLOUR_THEME, type ColourTheme, type ColourThemeKind } from '../../lib/colourTheme'
import { setPhoneColours, usePhoneColours } from '../platform/colourTheme'
import { useMobile } from '../state'
import { CARD, MobileScreen } from '../ui'

const GROUPS: readonly { kind: ColourThemeKind; label: string }[] = [
  { kind: 'dark', label: 'DARK' },
  { kind: 'light', label: 'LIGHT' },
]

/** What a row says under its name (1k B): the editor palette it is after; Deep Field is the default. */
function inspiration(theme: ColourTheme): string | null {
  if (theme.after) return `after ${theme.after}`
  return theme.id === DEFAULT_COLOUR_THEME ? 'default' : null
}

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
  const groups = slot === 'theme' ? GROUPS : GROUPS.filter((g) => g.kind === slot)

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
        {groups.map((group) => (
          <div key={group.kind} role="radiogroup" aria-label={group.label}>
            <div className="px-1 pb-2 pt-4 font-mono fs-10 tracking-[0.16em] text-ink-900/60">{group.label}</div>
            <div className={CARD}>
              {COLOUR_THEMES.filter((theme) => theme.kind === group.kind).map((theme, i) => {
                const on = theme.id === current
                const after = inspiration(theme)
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
                    <span aria-hidden className="flex shrink-0 overflow-hidden rounded-[5px] ring-1 ring-line/12">
                      {theme.swatch.map((colour, j) => (
                        <span key={j} className="block h-[22px] w-3" style={{ background: colour }} />
                      ))}
                    </span>
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
