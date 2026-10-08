import { useEffect, useState } from 'react'
import { NOTIFICATIONS_TIP_KEY, NOTIFICATIONS_TIP_PENDING } from '@orbital/shared/notifications'
import { api } from '../lib/api'
import { notifyDesktopSettingsChanged, openNotificationSettings, requestNotificationPermission } from '../lib/desktop'
import { reportError } from '../lib/errors'
import { END_TIP_PATCH, shouldOfferNotificationsTip, turnOnPatch } from '../lib/notificationsTip'
import { useMapNotices } from '../store/mapNotices'
import { useOrbital } from '../store/store'
import { Button } from '../ui/Button'
import { MapNotice, MapNoticeText } from '../ui/MapNotice'

/**
 * The notifications tip on the desktop (spec
 * 2026-10-08-notifications-off-by-default-design § 3): a `tip` message in the
 * map's notice queue (canvas `Feature - Notice toast`), in the words of canvas
 * `Feature - Notifications off` — 1a the offer, 1b after Turn on, 1d refused.
 * Shown once, when the first session is on the map; whichever way it goes, it
 * never comes back. Like every notice, nothing makes it go but × or an action.
 */

const NOTIFICATIONS_TIP_ID = 'notifications-tip'

/**
 * Queues the tip the moment it is due, and takes it out unseen if it stops
 * being due before it showed. Once on screen it is the tip's own: the
 * confirmation after Turn on stays although the tip is no longer due. Mounted
 * by `App`.
 */
export function useNotificationsTip(): void {
  const due = useOrbital((s) => shouldOfferNotificationsTip(s.settings, Object.values(s.sessions)))
  useEffect(() => {
    const notices = useMapNotices.getState()
    if (due) notices.push({ id: NOTIFICATIONS_TIP_ID, kind: 'tip', Body: NotificationsTip })
    else if (notices.queue[0]?.id !== NOTIFICATIONS_TIP_ID) notices.dismiss(NOTIFICATIONS_TIP_ID)
  }, [due])
}

async function save(patch: Record<string, string>): Promise<void> {
  await api.patchSettings(patch)
  useOrbital.setState((state) => ({ settings: { ...state.settings, ...patch } }))
  // The desktop's notifier reads its rows from the server when told to.
  notifyDesktopSettingsChanged()
}

/** Ends the tip for good. A failed write costs a second offer next launch, not an error toast. */
function endTip(): void {
  save(END_TIP_PATCH).catch(() => {})
}

type Phase = 'offer' | 'asking' | 'on' | 'denied'

function NotificationsTip({ close }: { close: () => void }) {
  const [phase, setPhase] = useState<Phase>('offer')
  const tip = useOrbital((s) => s.settings[NOTIFICATIONS_TIP_KEY])

  // A notification setting changed meanwhile (Settings, another window): the
  // offer has nothing left to offer. The confirmation and the refusal stay.
  useEffect(() => {
    if (phase === 'offer' && tip !== NOTIFICATIONS_TIP_PENDING) close()
  }, [phase, tip, close])

  const dismiss = () => {
    endTip()
    close()
  }

  const toSettings = () => {
    endTip()
    // In memory only, like the harness templates' way in: this visit opens on
    // Notifications, and the stored section stays whatever the user picked.
    useOrbital.setState((state) => ({
      settings: { ...state.settings, settings_last_section: 'notifications' },
      ui: { ...state.ui, dialog: 'settings' },
    }))
    close()
  }

  const turnOn = async () => {
    setPhase('asking')
    // macOS asks now, at the user's click: the first notification Orbital
    // shows is the question (desktop `lib/notificationPermission`).
    const answer = await requestNotificationPermission()
    try {
      await save(turnOnPatch(answer))
    } catch (err) {
      reportError(err, 'Failed to save settings')
      setPhase('offer')
      return
    }
    setPhase(answer === 'denied' ? 'denied' : 'on')
  }

  if (phase === 'on') {
    // 1b: exactly what was switched on, ticked in the accent.
    return (
      <MapNotice label="NOTIFICATIONS · ON" closeLabel="Close" onClose={close}>
        <div className="flex items-center gap-5 text-[14px] font-semibold text-text-bright">
          {['Needs input', 'Session failed'].map((row) => (
            <span key={row} className="flex items-center gap-2">
              <span aria-hidden className="text-accent">
                ✓
              </span>
              {row}
            </span>
          ))}
        </div>
        <p className="text-[13px] leading-[1.5] text-[rgba(160,190,225,.75)] [text-wrap:pretty]">
          Sound and Session ended stay off.{' '}
          <button type="button" onClick={toSettings} className="text-[rgba(214,226,242,.92)] underline">
            Settings
          </button>
        </p>
      </MapNotice>
    )
  }

  if (phase === 'denied') {
    // 1d MACOS SAID NO: nothing was switched on, and one way out.
    return (
      <MapNotice
        label="NOTIFICATIONS · BLOCKED"
        onClose={close}
        actions={
          <Button
            variant="hairline"
            size="notice"
            onClick={() => {
              openNotificationSettings()
              close()
            }}
          >
            Open System Settings
          </Button>
        }
      >
        <MapNoticeText>macOS isn&rsquo;t allowing notifications from Orbital, so nothing was switched on.</MapNoticeText>
      </MapNotice>
    )
  }

  return (
    <MapNotice
      label="NOTIFICATIONS · OFF"
      onClose={dismiss}
      actions={
        <>
          <Button variant="quiet" size="notice-link" onClick={toSettings}>
            Settings →
          </Button>
          <Button variant="lit" size="notice" disabled={phase === 'asking'} onClick={() => void turnOn()}>
            Turn on
          </Button>
        </>
      }
    >
      <MapNoticeText>
        Orbital can notify you when a session needs your answer or finishes. This is off by default.
      </MapNoticeText>
    </MapNotice>
  )
}
