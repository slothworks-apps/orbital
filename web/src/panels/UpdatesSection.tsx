import { useEffect, useState } from 'react'
import { version as orbitalVersion } from '../../../desktop/package.json'
import { api } from '../lib/api'
import { AUTO_DOWNLOAD_KEY, autoDownloadOn, releaseNotesUrl, remoteWaits, updateCheckLine } from '../lib/appUpdate'
import type { UpdateCheckAnswer } from '../lib/desktop'
import { UPDATE_CHANNEL_KEY, experimentalUpdatesWords, type UpdateChannel } from '@orbital/shared/updateChannel'
import { recordError } from '../lib/errors'
import { channelStatusLine, experimentalUpdatesOn, stampOriginName, type SettingStamp } from '../lib/updateChannel'
import { useNow } from '../lib/useNow'
import { useAppUpdate } from '../store/appUpdate'
import { useOrbital } from '../store/store'
import { Button } from '../ui/Button'
import { Toggle } from '../ui/Checkbox'
import {
  EXITING, INLINE_CONFIRM_ENTER, INLINE_CONFIRM_ENTER_MS, INLINE_CONFIRM_EXIT, INLINE_CONFIRM_EXIT_MS,
} from '../ui/motion'
import { usePresence } from '../ui/usePresence'
import { GroupLine, Row, SectionLabel } from './settingsRows'

/** "Checked 2 h ago" moves in minutes at the finest, so it is re-read that often. */
const CHECKED_TICK_MS = 60_000

/**
 * Settings › Updates (canvas `Feature - App update`; spec
 * 2026-10-08-builds-for-testers-design § The desktop app updates itself):
 * the installed version with Check now and its release notes, and whether a
 * new version downloads by itself. Desktop only — `Settings` lists it only
 * where the update bridge is. No badge anywhere while an update waits; the
 * map's prompt is where it is offered. A restart waiting for sessions to
 * finish is off the map, so its line and Cancel are here.
 *
 * RELEASES holds Experimental updates (canvas `Feature - Experimental
 * updates` 1a, 1h): one switch for the whole group, off by default. While
 * it is on, the version and a build the check found say experimental.
 */
export function UpdatesSection({ patchAndSet }: { patchAndSet: (patch: Record<string, string>) => Promise<unknown> }) {
  const source = useAppUpdate((s) => s.source)
  const state = useAppUpdate((s) => s.state)
  const autoDownload = useOrbital((s) => autoDownloadOn(s.settings))
  const [checking, setChecking] = useState(false)
  const [answer, setAnswer] = useState<UpdateCheckAnswer | null>(null)
  const now = useNow(true, CHECKED_TICK_MS)
  const experimental = useOrbital((s) => experimentalUpdatesOn(s.settings))

  const checkNow = async () => {
    if (!source) return
    setChecking(true)
    try {
      setAnswer(await source.checkForUpdates())
    } catch {
      setAnswer({ kind: 'error' })
    } finally {
      setChecking(false)
    }
  }

  const line = updateCheckLine({
    checking,
    answer,
    prompt: state ?? { phase: 'none' },
    checkedAt: state?.checkedAt ?? null,
    // The line is read when it draws: a check that just landed is "just now".
    now: Math.max(now, state?.checkedAt ?? 0),
    experimental,
  })

  return (
    <div className="flex min-h-0 flex-col overflow-y-auto px-8 pb-5 pt-2">
      <GroupLine />
      <SectionLabel first>VERSION</SectionLabel>
      <Row
        title="Version"
        desc="Orbital checks at launch and every few hours. A check never downloads unless the switch below is on."
      >
        <div className="flex flex-col items-start gap-2">
          <div className="flex items-center gap-3">
            {experimental ? (
              // 1a: `· experimental` after the version, never coloured.
              <span className="flex items-baseline gap-1.5 font-mono fs-12 text-ink-100">
                Orbital {orbitalVersion}
                <span className="text-ink-900/70">·</span>
                <span className="fs-11 text-ink-900/65">experimental</span>
              </span>
            ) : (
              <span className="font-mono fs-12 text-ink-100">Orbital {orbitalVersion}</span>
            )}
            {/* Canvas 50v 01–02: nothing to check while another member's update runs here. */}
            <Button variant="hairline" size="check" disabled={checking || !!state?.remote} onClick={() => void checkNow()}>
              Check now
            </Button>
          </div>
          <div className="flex items-center gap-3">
            <div aria-live="polite" className="font-mono fs-11 leading-[1.5] text-ink-900/65">
              {line}
            </div>
            {/* A wait here, this Mac's own or another member's (canvas 50v 02), its download included. */}
            {state && (state.phase === 'waiting' || remoteWaits(state)) && (
              <Button variant="hairline" size="check" onClick={() => source?.updateAction('cancel-wait')}>
                Cancel
              </Button>
            )}
          </div>
          <a
            href={releaseNotesUrl(orbitalVersion)}
            target="_blank"
            rel="noreferrer"
            className="font-mono fs-11 tracking-[0.04em] text-ink-900/75 no-underline transition-colors hover:text-ink-100"
          >
            Release notes on GitHub ↗
          </a>
        </div>
      </Row>

      <SectionLabel>DOWNLOADS</SectionLabel>
      <Row
        title="Download updates automatically"
        desc="Off: Orbital asks before it downloads a new version. On: it downloads in the background and asks only to restart. Either way, it never restarts on its own."
      >
        <Toggle
          aria-label="Download updates automatically"
          checked={autoDownload}
          onChange={(on) => void patchAndSet({ [AUTO_DOWNLOAD_KEY]: on ? 'true' : 'false' })}
        />
      </Row>

      <ExperimentalUpdates on={experimental} latestRegular={state?.latestRegular ?? null} patchAndSet={patchAndSet} />
    </div>
  )
}

/**
 * RELEASES › Experimental updates (canvas `Feature - Experimental updates`
 * 1a, 1h). A group setting, so its label says every device, the phones
 * included — and none when this Mac is alone, where the words say this Mac.
 * Turning it on asks inline first and the switch stays off until Turn on;
 * turning it off asks nothing. The mono line under the switch says who
 * turned it on and when, or, once off, which version this Mac stays on
 * while it runs ahead of the regular release.
 */
function ExperimentalUpdates({
  on,
  latestRegular,
  patchAndSet,
}: {
  on: boolean
  latestRegular: string | null
  patchAndSet: (patch: Record<string, string>) => Promise<unknown>
}) {
  const members = useOrbital((s) => s.remote?.group.members)
  const value = useOrbital((s) => s.settings[UPDATE_CHANNEL_KEY])
  const inGroup = members?.some((m) => !m.self) ?? false
  const words = experimentalUpdatesWords(inGroup)
  const [asking, setAsking] = useState(false)
  const confirm = usePresence(asking, INLINE_CONFIRM_ENTER_MS, INLINE_CONFIRM_EXIT_MS)
  // undefined while it is being read, null when it could not be.
  const [stamp, setStamp] = useState<SettingStamp | null | undefined>(undefined)

  // Read again whenever the value changes, here or on another member.
  useEffect(() => {
    let current = true
    api
      .getSettingStamp(UPDATE_CHANNEL_KEY)
      .then((s) => current && setStamp({ at: s.at, origin: s.origin }))
      .catch((err) => {
        // The line falls back to saying less; the failure is kept in the error log.
        recordError(err, 'Could not read when experimental updates were turned on')
        if (current) setStamp(null)
      })
    return () => {
      current = false
    }
  }, [value])

  // Turned on elsewhere while this one asked: nothing is left to ask.
  useEffect(() => {
    if (on) setAsking(false)
  }, [on])

  const status = channelStatusLine({
    on,
    inGroup,
    stamp,
    originName: stamp ? stampOriginName(stamp.origin, members ?? []) : null,
    installed: orbitalVersion,
    latestRegular,
  })
  const exiting = confirm.state === 'exiting'

  return (
    <>
      <SectionLabel scope={inGroup ? 'group' : null}>RELEASES</SectionLabel>
      <Row
        title="Experimental updates"
        desc={
          <span className="flex flex-col gap-0.5">
            <span>{words.lines[0]}</span>
            <span>{words.lines[1]}</span>
          </span>
        }
      >
        <Toggle
          aria-label="Experimental updates"
          checked={on}
          // Off → on asks first (a second press closes the question); on → off saves at once.
          onChange={(next) => (next ? setAsking((a) => !a) : void patchAndSet({ [UPDATE_CHANNEL_KEY]: 'stable' satisfies UpdateChannel }))}
        />
        {status && <span className="font-mono fs-11 leading-[1.5] text-ink-900/65 [text-wrap:pretty]">{status}</span>}
      </Row>
      {confirm.mounted && (
        <div
          inert={exiting || undefined}
          className={[
            'mb-2 mt-0.5 flex flex-col gap-3.5 rounded-xl border border-line/16 bg-space/55 px-[18px] py-4',
            exiting ? `${INLINE_CONFIRM_EXIT} ${EXITING}` : INLINE_CONFIRM_ENTER,
            confirm.state === 'entered' ? 'opacity-100' : 'opacity-0',
          ].join(' ')}
        >
          <div className="flex flex-col gap-[5px]">
            <span className="fs-13.5 font-semibold text-ink-100">{words.question}</span>
            <span className="max-w-[620px] fs-12.5 leading-[1.55] text-ink-900/70 [text-wrap:pretty]">{words.body}</span>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="member" onClick={() => setAsking(false)}>
              Cancel
            </Button>
            <Button
              variant="ink"
              size="member"
              onClick={() => {
                setAsking(false)
                void patchAndSet({ [UPDATE_CHANNEL_KEY]: 'experimental' satisfies UpdateChannel })
              }}
            >
              Turn on
            </Button>
          </div>
        </div>
      )}
    </>
  )
}
