import { useState } from 'react'
import { version as orbitalVersion } from '../../../desktop/package.json'
import { AUTO_DOWNLOAD_KEY, autoDownloadOn, releaseNotesUrl, remoteWaits, updateCheckLine } from '../lib/appUpdate'
import type { UpdateCheckAnswer } from '../lib/desktop'
import { useNow } from '../lib/useNow'
import { useAppUpdate } from '../store/appUpdate'
import { useOrbital } from '../store/store'
import { Button } from '../ui/Button'
import { Toggle } from '../ui/Checkbox'
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
 */
export function UpdatesSection({ patchAndSet }: { patchAndSet: (patch: Record<string, string>) => Promise<unknown> }) {
  const source = useAppUpdate((s) => s.source)
  const state = useAppUpdate((s) => s.state)
  const autoDownload = useOrbital((s) => autoDownloadOn(s.settings))
  const [checking, setChecking] = useState(false)
  const [answer, setAnswer] = useState<UpdateCheckAnswer | null>(null)
  const now = useNow(true, CHECKED_TICK_MS)

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
            <span className="font-mono fs-12 text-text-bright">Orbital {orbitalVersion}</span>
            {/* Canvas 50v 01–02: nothing to check while another member's update runs here. */}
            <Button variant="hairline" size="check" disabled={checking || !!state?.remote} onClick={() => void checkNow()}>
              Check now
            </Button>
          </div>
          <div className="flex items-center gap-3">
            <div aria-live="polite" className="font-mono fs-11 leading-[1.5] text-[rgba(160,190,225,.65)]">
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
            className="font-mono fs-11 tracking-[0.04em] text-[rgba(160,190,225,.75)] no-underline transition-colors hover:text-text-bright"
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
    </div>
  )
}
