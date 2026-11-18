import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { CDN_HOST_EXAMPLE, cdnHostField, cdnHostRows, withCdnHost, withoutCdnHost } from '../../lib/cdnHosts'
import { VIEWS_CDN_HOSTS_KEY, VIEWS_ENABLED_KEY, viewsEnabled } from '../../lib/experimental'
import { ViewGlyph } from '../../panels/ViewParts'
import { LockGlyph } from '../../panels/ViewsGlyphs'
import { useMacViewsSetting } from '../questionSetting'
import { UNNAMED_MAC } from '../composer'
import { useMobile } from '../state'
import { CARD, SectionLabel, Toggle } from '../ui'
import { defaultSupports } from '../version'

/**
 * Settings → LABS on the phone (canvas `Feature - Views` 69f, PHONE · THE
 * LIST and PHONE · ADDING A HOST; spec 2026-11-18-generated-views-design §
 * CDN hosts): the Views switch and, while it is on, the Mac's CDN hosts.
 * Both are the Mac's settings, read and written over the settings routes:
 * in a group, of the default member — the one a settings read reaches once
 * it is new enough to serve views (`settingsSource`), and the one a PATCH
 * goes to. Left out against an older Mac (`MAC_FEATURES.views`) and for a
 * pairing whose settings read is refused.
 */
export function LabsSection() {
  const ready = useMobile((s) => s.ready)
  const macVersion = useMobile((s) => s.macVersion)
  const macName = useMobile((s) => s.macName)
  const serves = ready && defaultSupports('views', macVersion)
  const [settings, setSettings] = useState<Record<string, string> | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!serves) return
    let live = true
    api
      .getSettings()
      .then((read) => {
        if (!live) return
        setSettings(read)
        useMacViewsSetting.setState({ on: viewsEnabled(read) })
      })
      .catch(() => {
        // No settings grant, or the Mac went away: the group stays out.
      })
    return () => {
      live = false
    }
  }, [serves])

  if (!serves || !settings) return null

  /** Saves `patch` on the Mac; false when it did not take it, and the rows keep what it holds. */
  const save = async (patch: Record<string, string>): Promise<boolean> => {
    setSaving(true)
    try {
      await api.patchSettings(patch)
      const next = { ...settings, ...patch }
      setSettings(next)
      useMacViewsSetting.setState({ on: viewsEnabled(next) })
      return true
    } catch {
      return false
    } finally {
      setSaving(false)
    }
  }

  const on = viewsEnabled(settings)
  return (
    <>
      <SectionLabel>LABS</SectionLabel>
      <div className={CARD}>
        <div className="flex min-h-16 items-center gap-2.5 py-2 pl-3.5 pr-1.5">
          <span className="flex text-ink-200/80">
            <ViewGlyph />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="fs-14 font-semibold">Views</span>
            <span className="fs-11.5 leading-[1.4] text-ink-900/60">Small pages a session shows in its transcript</span>
          </span>
          <Toggle
            label="Views"
            checked={on}
            disabled={saving}
            onChange={(next) => void save({ [VIEWS_ENABLED_KEY]: next ? 'true' : 'false' })}
          />
        </div>
      </div>
      {on && <CdnHosts stored={settings[VIEWS_CDN_HOSTS_KEY]} macName={macName ?? UNNAMED_MAC} saving={saving} save={save} />}
    </>
  )
}

function CdnHosts({
  stored,
  macName,
  saving,
  save,
}: {
  stored: string | undefined
  macName: string
  saving: boolean
  save: (patch: Record<string, string>) => Promise<boolean>
}) {
  // 69f PHONE · ADDING A HOST: + Add a host turns into the field and Add.
  const [adding, setAdding] = useState(false)
  const [typed, setTyped] = useState('')
  const field = cdnHostField(typed, stored)
  const wrong = field.state === 'bad' || field.state === 'dup'

  async function add() {
    if (field.state !== 'ok' || field.host === null) return
    if (await save({ [VIEWS_CDN_HOSTS_KEY]: withCdnHost(stored, field.host, Date.now()) })) {
      setTyped('')
      setAdding(false)
    }
  }

  return (
    <>
      <SectionLabel>CDN HOSTS · SCRIPTS WITHOUT ASKING</SectionLabel>
      <div className={CARD}>
        {cdnHostRows(stored).map((row, i) => (
          <div
            key={row.host}
            className={['flex min-h-13 items-center gap-2.5 pl-3.5 pr-1.5', i > 0 ? 'border-t border-line/8' : ''].join(' ')}
          >
            <span className="flex w-3 text-ink-900/60">{row.builtIn && <LockGlyph />}</span>
            <span className="flex min-w-0 flex-1 flex-col gap-px">
              <span className={`truncate font-mono fs-13 ${row.builtIn ? 'text-ink-200/80' : 'text-ink-100'}`}>{row.host}</span>
              <span className="font-mono fs-10 text-ink-900/60">{row.builtIn ? 'built in' : 'added by you'}</span>
            </span>
            {!row.builtIn && (
              // 69f: no confirm — adding it back is one line.
              <button
                type="button"
                disabled={saving}
                onClick={() => void save({ [VIEWS_CDN_HOSTS_KEY]: withoutCdnHost(stored, row.host) })}
                className="grid h-11 place-items-center rounded-[10px] px-3 fs-14 font-semibold text-danger-soft disabled:opacity-40"
              >
                Remove
              </button>
            )}
          </div>
        ))}
        {adding ? (
          <form
            className="flex items-center gap-2 border-t border-line/8 py-2 pl-3.5 pr-2"
            onSubmit={(e) => {
              e.preventDefault()
              void add()
            }}
          >
            <input
              type="text"
              // Opened by + Add a host: the keyboard comes up with it (69f).
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={CDN_HOST_EXAMPLE}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              inputMode="url"
              aria-label="Add a CDN host"
              aria-invalid={wrong || undefined}
              className={[
                'box-border h-11 min-w-0 flex-1 rounded-[10px] border bg-space/60 px-3 font-mono fs-13.5 text-ink-100 outline-none placeholder:text-ink-900/45',
                wrong ? 'border-danger-soft/40' : 'border-accent/45',
              ].join(' ')}
            />
            <button
              type="submit"
              disabled={saving || field.state !== 'ok'}
              className="grid h-11 place-items-center rounded-[10px] bg-accent px-4 fs-14 font-bold text-space-deep disabled:opacity-45"
            >
              Add
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="flex min-h-13 w-full items-center border-t border-line/8 px-3.5 text-left fs-14 font-semibold text-sky"
          >
            + Add a host
          </button>
        )}
      </div>
      {adding && wrong ? (
        // Not drawn on the phone in 69f: the desktop's line under the field, in its error ink.
        <p role="alert" className="px-1 pt-2 fs-12 leading-[1.5] text-danger-soft">
          {field.help}
        </p>
      ) : (
        <p className="px-1 pt-2 fs-12 leading-[1.5] text-ink-900/65">
          One list for every session on {macName}; changes here apply on the Mac too. Data still asks per session.
        </p>
      )}
    </>
  )
}
