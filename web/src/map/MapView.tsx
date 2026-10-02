import { useOrbital, mapTheme } from '../store/store'
import { SpaceMap } from './SpaceMap'
import { ArchipelagoMap } from './archipelago/ArchipelagoMap'
import { DeskMap } from './desk/DeskMap'

/**
 * Mounts the appropriate map renderer based on the theme setting.
 * Each renderer gets access to the same scene model and shared controls.
 */
export function MapView() {
  const settings = useOrbital((s) => s.settings)
  const theme = mapTheme(settings)

  switch (theme) {
    case 'archipelago':
      return <ArchipelagoMap />
    case 'desk':
      return <DeskMap />
    case 'planets':
    default:
      return <SpaceMap />
  }
}
