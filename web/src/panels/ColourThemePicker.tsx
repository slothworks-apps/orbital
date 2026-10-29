import {
  COLOUR_THEMES,
  COLOUR_THEME_DARK_KEY,
  COLOUR_THEME_FOLLOW_SYSTEM_KEY,
  COLOUR_THEME_KEY,
  COLOUR_THEME_KIND_LABEL,
  COLOUR_THEME_LIGHT_KEY,
  colourThemeNote,
  colourThemesOfKind,
  macColourChoice,
  type ColourThemeKind,
} from '../lib/colourTheme'
import { Toggle } from '../ui/Checkbox'
import { Select, type SelectOption } from '../ui/Select'
import { Row } from './settingsRows'

type Settings = Record<string, string | undefined>

/**
 * The picker's options, in `COLOUR_THEMES` order (dark, then light), each
 * under its kind's heading: the swatch, the name, and what it is after — or
 * `default` for Deep Field (1f). The trigger shows the kind instead. `kind`:
 * the themes of that kind only, for one appearance while following the system.
 */
export function colourThemeOptions(kind?: ColourThemeKind): Array<SelectOption<string>> {
  return (kind ? colourThemesOfKind(kind) : COLOUR_THEMES).map((theme) => ({
    value: theme.id,
    label: theme.name,
    group: COLOUR_THEME_KIND_LABEL[theme.kind],
    swatch: theme.swatch,
    trail: colourThemeNote(theme) ?? undefined,
    triggerTrail: theme.kind,
  }))
}

/**
 * Settings → Appearance → COLOURS (canvas `Feature - Colour themes` 1f):
 * the theme, or with Follow the
 * system on, one per macOS appearance, as on the phone (1k). Writing the
 * setting is all a pick does; `main.tsx` repaints the root whenever settings
 * change.
 */
export function ColourThemeRows({
  settings,
  patchAndSet,
}: {
  settings: Settings
  patchAndSet: (patch: Record<string, string>) => Promise<boolean>
}) {
  const choice = macColourChoice(settings)
  return (
    <>
      {choice.followSystem ? (
        <>
          <ColourRow
            title="In light mode"
            setting={COLOUR_THEME_LIGHT_KEY}
            desc="The theme while macOS is in Light mode."
            kind="light"
            value={choice.light}
            patchAndSet={patchAndSet}
          />
          <ColourRow
            title="In dark mode"
            setting={COLOUR_THEME_DARK_KEY}
            desc="The theme while macOS is in Dark mode."
            kind="dark"
            value={choice.dark}
            patchAndSet={patchAndSet}
          />
        </>
      ) : (
        <ColourRow
          title="Colours"
          setting={COLOUR_THEME_KEY}
          desc="The app's panels, text, backdrop and map. Separate from the map's theme below."
          value={choice.theme}
          patchAndSet={patchAndSet}
        />
      )}
      <Row
        title="Follow the system"
        setting={COLOUR_THEME_FOLLOW_SYSTEM_KEY}
        desc="Switch with macOS's Light and Dark mode, with a theme for each."
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

function ColourRow({
  title,
  setting,
  desc,
  kind,
  value,
  patchAndSet,
}: {
  title: string
  setting: string
  desc: string
  kind?: ColourThemeKind
  value: string
  patchAndSet: (patch: Record<string, string>) => Promise<boolean>
}) {
  return (
    <Row title={title} setting={setting} desc={desc}>
      <Select
        aria-label={title}
        variant="swatch"
        font="sans"
        options={colourThemeOptions(kind)}
        value={value}
        onChange={(next) => void patchAndSet({ [setting]: next })}
        className="w-full"
      />
    </Row>
  )
}
