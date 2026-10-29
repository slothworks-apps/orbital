import {
  COLOUR_THEMES,
  COLOUR_THEME_FOLLOW_SYSTEM_KEY,
  COLOUR_THEME_KEY,
  DEFAULT_COLOUR_THEME,
  DEFAULT_LIGHT_COLOUR_THEME,
  colourThemeById,
  macColourChoice,
  type ColourTheme,
} from '../lib/colourTheme'
import { Toggle } from '../ui/Checkbox'
import { Select, type SelectOption } from '../ui/Select'
import { Row } from './settingsRows'

type Settings = Record<string, string | undefined>

/** The menu's group headings, by kind (artboard 1f). */
const GROUP_LABEL: Record<ColourTheme['kind'], string> = { dark: 'DARK', light: 'LIGHT' }

/**
 * The picker's options, in `COLOUR_THEMES` order (dark, then light), each
 * under its kind's heading: the swatch, the name, and what it is after — or
 * `default` for Deep Field (1f). The trigger shows the kind instead.
 */
export function colourThemeOptions(): Array<SelectOption<string>> {
  return COLOUR_THEMES.map((theme) => ({
    value: theme.id,
    label: theme.name,
    group: GROUP_LABEL[theme.kind],
    swatch: theme.swatch,
    trail: theme.after ? `after ${theme.after}` : theme.id === DEFAULT_COLOUR_THEME ? 'default' : undefined,
    triggerTrail: theme.kind,
  }))
}

/**
 * Settings → Appearance → COLOURS (canvas `Feature - Colour themes` 1f),
 * shown while Labs → Colour themes is on: the theme, and whether light mode
 * swaps it for Albedo. Writing the setting is all a pick does; `main.tsx`
 * repaints the root whenever settings change.
 */
export function ColourThemeRows({
  settings,
  patchAndSet,
}: {
  settings: Settings
  patchAndSet: (patch: Record<string, string>) => Promise<boolean>
}) {
  const choice = macColourChoice(settings)
  const lightName = colourThemeById(DEFAULT_LIGHT_COLOUR_THEME)?.name ?? ''
  return (
    <>
      <Row
        title="Colours"
        setting={COLOUR_THEME_KEY}
        desc="The app's panels, text and backdrop. Planets and tag colours stay as they are. Separate from the map's theme below."
      >
        <Select
          aria-label="Colours"
          variant="swatch"
          font="sans"
          options={colourThemeOptions()}
          value={choice.theme}
          onChange={(next) => void patchAndSet({ [COLOUR_THEME_KEY]: next })}
          className="w-full"
        />
      </Row>
      <Row
        title="Follow the system"
        setting={COLOUR_THEME_FOLLOW_SYSTEM_KEY}
        desc={`Use ${lightName} while macOS is in Light mode, and your choice above otherwise.`}
      >
        <Toggle
          aria-label="Follow the system"
          checked={choice.followSystem}
          onChange={(checked) => void patchAndSet({ [COLOUR_THEME_FOLLOW_SYSTEM_KEY]: checked ? 'true' : 'false' })}
        />
      </Row>
    </>
  )
}
