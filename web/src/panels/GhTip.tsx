import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { recordError, reportError } from '../lib/errors'
import { END_GH_TIP_PATCH, GH_TIP_DONE, GH_TIP_KEY, shouldOfferGhTip, type GhStatusAnswer } from '../lib/ghTip'
import { ORBITAL_COMMANDS, runInOrbital } from '../lib/runInOrbital'
import { useMapNotices } from '../store/mapNotices'
import { useOrbital } from '../store/store'
import { Button } from '../ui/Button'
import { MapNotice, MapNoticeList, MapNoticeText } from '../ui/MapNotice'

/**
 * The `gh` tip (spec 2026-10-20-report-to-github-design § Telling people about
 * `gh`, canvas `Feature - Feedback` 61e, 61f): a `tip` in the map's notice
 * queue, said once on a launch where `gh` is not installed. × or Install ends
 * it for good. Like every notice, nothing else makes it go.
 */

const GH_TIP_ID = 'gh-tip'

/**
 * Asks the server about `gh` once settings are in, and again whenever the
 * window regains focus while the tip may still be due — `gh` installed in a
 * terminal meanwhile takes the tip out unseen. Once on screen it is the tip's
 * own, as `useNotificationsTip`'s. Mounted by `App`.
 */
export function useGhTip(): void {
  const [gh, setGh] = useState<GhStatusAnswer | null>(null)
  const settingsLoaded = useOrbital((s) => s.settingsLoaded === true)
  const ended = useOrbital((s) => s.settings[GH_TIP_KEY] === GH_TIP_DONE)
  const due = useOrbital((s) => shouldOfferGhTip(s.settings, s.settingsLoaded === true, gh))
  // Only while there is something left to learn: before an answer, or while
  // the answer is still "missing".
  const listening = settingsLoaded && !ended && (gh === null || gh.status === 'missing')

  useEffect(() => {
    if (!listening) return
    let live = true
    const ask = () => {
      api
        .ghStatus()
        .then((answer) => {
          if (live && answer) setGh(answer)
        })
        .catch(() => {
          /* nothing is offered on a failed ask; the next focus asks again */
        })
    }
    ask()
    window.addEventListener('focus', ask)
    return () => {
      live = false
      window.removeEventListener('focus', ask)
    }
  }, [listening])

  useEffect(() => {
    const notices = useMapNotices.getState()
    if (due) notices.push({ id: GH_TIP_ID, kind: 'tip', Body: GhTip })
    else if (notices.queue[0]?.id !== GH_TIP_ID) notices.dismiss(GH_TIP_ID)
  }, [due])
}

/**
 * Ends the tip for good. A failed write costs a second offer next launch:
 * recorded in the log so that is explained, but no toast over the map.
 */
function endTip(): void {
  api
    .patchSettings(END_GH_TIP_PATCH)
    .then(() => useOrbital.setState((state) => ({ settings: { ...state.settings, ...END_GH_TIP_PATCH } })))
    .catch((err) => recordError(err, 'Could not keep the gh tip closed'))
}

const INSTALL = ORBITAL_COMMANDS['install-gh']

function GhTip({ close }: { close: () => void }) {
  const dismiss = () => {
    endTip()
    close()
  }

  // The same session Settings' Run in Orbital starts: one way to install.
  // It lands on the map like any other; the map is not moved to it.
  const install = () => {
    endTip()
    close()
    runInOrbital('install-gh').catch((err) => reportError(err, 'Failed to start the session'))
  }

  return (
    <MapNotice label="TIP · GITHUB CLI" onClose={dismiss}>
      <MapNoticeText>Orbital works without gh. With it installed, Orbital can also:</MapNoticeText>
      <MapNoticeList
        items={[
          "show the pull request for a session's branch in its header",
          'send reports from the error log and Settings straight to GitHub',
        ]}
      />
      {/* 61e: what Install does, beside it — 2/6/0/0 inset, 10 apart. */}
      <div className="flex items-center gap-2.5 pr-1.5 pt-0.5">
        <span className="min-w-0 flex-1 font-mono text-[10.5px] leading-[1.5] text-[rgba(160,190,225,.6)]">
          Install runs <span className="text-[rgba(220,232,248,.9)]">{INSTALL.command}</span> in a new Orbital session
        </span>
        <Button variant="lit" size="notice" onClick={install}>
          Install
        </Button>
      </div>
    </MapNotice>
  )
}
