import { useMemo, useState } from 'react'
import { deviceOptions, LOCAL_DEVICE } from '../lib/devices'
import { useOrbital } from '../store/store'
import { Segmented } from '../ui/Segmented'
import { ClaudeDirsRows } from './ClaudeDirsRows'

/**
 * Settings → Profiles (spec 2026-10-21-log-in-from-orbital-design § 4;
 * canvas 62c): this Mac's profiles and their logins. With another Mac or a
 * server in the device group, a row of devices over the list switches to
 * that one's profiles (62g) — its logins through the code path, its list
 * managed where it lives. A device that cannot be asked now (offline, too
 * old, not linked) is listed and inert, as in New session's DEVICE field.
 */
export function ProfilesSection({
  active,
  makeDefault,
  onSaved,
}: {
  active: boolean
  makeDefault: (patch: Record<string, string>) => Promise<unknown>
  onSaved: () => void
}) {
  const members = useOrbital((s) => (active ? s.remote?.group?.members : undefined))
  const options = useMemo(() => deviceOptions(members, Date.now()), [members])
  const [device, setDevice] = useState<string>(LOCAL_DEVICE)
  const chosen = options.find((o) => o.id === device && !o.inert) ?? options[0]
  const remote = chosen.id !== LOCAL_DEVICE

  return (
    <div className="flex flex-col">
      {options.length >= 2 && (
        <Segmented
          label="Profiles on"
          size="filter"
          className="mt-2 self-start"
          value={chosen.id}
          onChange={setDevice}
          options={options.map((o) => ({
            value: o.id,
            label: o.id === LOCAL_DEVICE ? 'This Mac' : o.label,
            title: o.sub,
            disabled: o.inert,
          }))}
        />
      )}
      <ClaudeDirsRows
        // A device switch starts its list from nothing rather than from the last device's rows.
        key={chosen.id}
        active={active}
        makeDefault={makeDefault}
        onSaved={onSaved}
        machine={remote ? chosen.id : undefined}
        macName={remote ? chosen.name : 'this Mac'}
      />
    </div>
  )
}
