import { useEffect, useState, type ReactNode } from 'react'
import { api } from '../lib/api'
import { recordError } from '../lib/errors'
import {
  LIMIT_SUN_POSITIONS_KEY,
  LIMIT_SUN_STYLE_KEY,
  LIMIT_SUNS_ENABLED_KEY,
  LIMIT_SUN_COLORS_KEY,
  limitSunsEnabled,
} from '../lib/experimental'
import {
  pickSunColor,
  SUN_COLORS,
  sunColors,
  sunDiscGradient,
  sunPositions,
  sunStyle,
  sunTiles,
  type SunStyle,
} from '../lib/limitSuns'
import { accountViews, sunAccountKeys, type AccountView } from '../limits/accounts'
import { Button } from '../ui/Button'
import { Toggle } from '../ui/Checkbox'
import { ClaudeDirMark } from '../ui/ClaudeDirMark'
import { Segmented } from '../ui/Segmented'
import { Row, RowTitle, useDeviceOnlyMark } from './settingsRows'

type Settings = Record<string, string | undefined>

const STYLE_OPTIONS: Array<{ value: SunStyle; label: string }> = [
  { value: 'eclipse', label: 'Eclipse' },
  { value: 'dim', label: 'Dim' },
]

const STYLE_DESC: Record<SunStyle, string> = {
  eclipse: 'Eclipse: a shadow covers the middle as the room left right now is used. The ring shows the week.',
  dim: 'Dim: the middle gets darker as the room left right now is used. The ring shows the week.',
}

/** 60e: the picked colour's ring, and the hairline of the others. */
const PICKED_RING = '0 0 0 2px var(--color-panel-solid),0 0 0 3.5px var(--color-accent)'
const UNPICKED_RING = 'inset 0 0 0 1px color-mix(in oklab, var(--color-highlight) 12%, transparent)'

/**
 * Settings → Labs → Limit suns (spec 2026-10-20-limit-suns-design § 4;
 * canvas `Feature - Limit sun` 60e): the switch, and while it is on, the
 * sun's style, each account's star colour and the reset of the positions.
 * An API-key login has no plan windows, so the row is off and says why.
 */
export function LimitSunsLabs({
  settings,
  apiKey,
  patchAndSet,
}: {
  settings: Settings
  /** Signed in with an API key (`/api/health`'s `billing`). */
  apiKey: boolean
  patchAndSet: (patch: Record<string, string>) => Promise<boolean>
}) {
  const on = limitSunsEnabled(settings) && !apiKey
  // The accounts the colours are picked for, read as the limits page reads them.
  const [views, setViews] = useState<AccountView[] | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!on) return
    let live = true
    setFailed(false)
    api
      .getLimits()
      .then((snapshot) => {
        if (live) setViews(accountViews(snapshot.dirs, { dirInfo: null, self: null, now: Date.now() }))
      })
      .catch((err: unknown) => {
        recordError(err, 'Could not read the plan limits')
        if (live) setFailed(true)
      })
    return () => {
      live = false
    }
  }, [on])

  const keys = views ? sunAccountKeys(views) : []
  const colors = sunColors(keys, settings)
  const accounts = (views ?? []).filter((v) => colors.has(v.group.key))
  const showTiles = (views ?? []).reduce((n, v) => n + v.dirs.length, 0) >= 2
  const style = sunStyle(settings)

  return (
    <>
      <Row
        title="Show plan limits as suns on the map"
        setting={LIMIT_SUNS_ENABLED_KEY}
        dimmed={apiKey}
        desc={
          <>
            One sun for each Claude account, in its own star colour, placed in space with your sessions. The middle
            shows how much room is left right now and the ring shows the week. Click a sun to open Limits, or drag it
            wherever you like.
            <span className="mt-2 block font-mono fs-10.5 text-ink-900/55">
              {apiKey
                ? 'needs a Claude account · limits aren’t tracked with an API key'
                : 'Planets theme only · the Desk theme shows no suns'}
            </span>
          </>
        }
      >
        <Toggle
          aria-label="Show plan limits as suns on the map"
          checked={on}
          disabled={apiKey}
          onChange={(checked) => void patchAndSet({ [LIMIT_SUNS_ENABLED_KEY]: checked ? 'true' : 'false' })}
        />
      </Row>
      {on && (
        <div className="mb-[13px] ml-4 flex flex-col border-l border-line/12 pl-4">
          <SubRow title="Sun style" setting={LIMIT_SUN_STYLE_KEY} desc={STYLE_DESC[style]}>
            <Segmented<SunStyle>
              label="Sun style"
              size="row"
              options={STYLE_OPTIONS}
              value={style}
              onChange={(value) => void patchAndSet({ [LIMIT_SUN_STYLE_KEY]: value })}
            />
          </SubRow>
          {accounts.length !== 1 && (
            <SubRow
              title="Sun colours"
              setting={LIMIT_SUN_COLORS_KEY}
              desc="Each account gets a star colour in the order it was signed in: yellow, white, blue, red. The colour only says whose sun it is. It never changes with usage. Picking a colour that is taken swaps the two."
            >
              {accounts.length === 0 ? (
                <span className="font-mono fs-10.5 text-ink-900/55">
                  {views !== null ? 'no account read yet' : failed ? 'limits unavailable' : 'reading…'}
                </span>
              ) : (
                <div className="flex w-full flex-col gap-1.5">
                  {accounts.map((view) => {
                    const { tiles, more } = sunTiles(view.dirs.map((d) => d.mono))
                    const current = colors.get(view.group.key)
                    return (
                      <div key={view.group.key} className="flex min-h-[30px] items-center gap-2">
                        {showTiles && tiles.map((mono, i) => <ClaudeDirMark key={i} mono={mono} />)}
                        {showTiles && more > 0 && <ClaudeDirMark mono={`+${more}`} />}
                        <span className="min-w-0 flex-1 truncate font-mono fs-11 text-ink-400/88">
                          {view.title}
                        </span>
                        <span className="flex flex-none gap-[9px]">
                          {SUN_COLORS.map((color) => (
                            <button
                              key={color}
                              type="button"
                              title={color}
                              aria-label={color}
                              aria-pressed={current === color}
                              onClick={() =>
                                void patchAndSet({
                                  [LIMIT_SUN_COLORS_KEY]: pickSunColor(keys, settings, view.group.key, color),
                                })
                              }
                              className="block h-[18px] w-[18px] cursor-pointer rounded-full border-0 p-0"
                              style={{
                                background: sunDiscGradient(color),
                                boxShadow: current === color ? PICKED_RING : UNPICKED_RING,
                              }}
                            />
                          ))}
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}
            </SubRow>
          )}
          <SubRow
            title="Sun positions"
            setting={LIMIT_SUN_POSITIONS_KEY}
            desc="Kept for each account after you drag a sun. Reset puts every sun back at the top left of the map."
          >
            <Button
              variant="ghost"
              size="row"
              disabled={sunPositions(settings).size === 0}
              onClick={() => void patchAndSet({ [LIMIT_SUN_POSITIONS_KEY]: '{}' })}
            >
              Reset positions
            </Button>
          </SubRow>
        </div>
      )}
    </>
  )
}

/** 60e: a setting under the switch, indented behind a hairline; the control column lines up with `Row`'s. */
function SubRow({
  title,
  setting,
  desc,
  children,
}: {
  title: string
  /** The key it edits, for `Row`'s THIS MAC ONLY. */
  setting: string
  desc: ReactNode
  children: ReactNode
}) {
  const mark = useDeviceOnlyMark(setting)
  return (
    <div className="grid grid-cols-[1fr_320px] items-start gap-6 pt-3">
      <div>
        <RowTitle title={title} mark={mark} />
        <div className="mt-1 fs-12 leading-[1.55] text-ink-900/70 [text-wrap:pretty]">{desc}</div>
      </div>
      <div className="flex min-w-0 flex-col items-start gap-2.5">{children}</div>
    </div>
  )
}
