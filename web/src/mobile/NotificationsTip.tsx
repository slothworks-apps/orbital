import { useEffect, useState } from 'react'
import { usePhoneNotices } from './notices'
import { phoneTurnOn, shouldOfferPhoneTip, usePhoneTip } from './phoneTip'
import { NoticeButton, PinnedNotice, PinnedNoticeText } from './PinnedNotice'
import { setRules as setNotifierRules } from './notify'
import { readNotificationsCache, writeNotificationsCache } from './platform/cache'
import { openPhoneNotificationSettings } from './platform/notificationsTip'
import { askForNotifications } from './platform/push'
import { useMobile } from './state'
import { clientRef } from './transport/clientRef'

/**
 * The notifications tip on the phone (spec
 * 2026-10-08-notifications-off-by-default-design § 5): a `tip` message in the
 * phone's notice queue (canvas `Feature - Notice toast` 2a), in the words of
 * canvas `Feature - Notifications off` — 2a the offer, 2c turned on, 2d not
 * allowed. Nothing is asked of the OS until Turn on is tapped; a refusal
 * switches nothing on and never asks again.
 */

const NOTIFICATIONS_TIP_ID = 'notifications-tip'

/**
 * Reads what the tip needs — its stored state, and this phone's rules while
 * it may be due — and queues it the moment it is due, taking it out unseen if
 * it stops being due before it showed. Mounted by the session list.
 */
export function usePhoneNotificationsTip(): void {
  const stored = usePhoneTip((s) => s.stored)
  const rules = usePhoneTip((s) => s.rules)
  const ready = useMobile((s) => s.ready)

  useEffect(() => {
    if (stored === undefined) void usePhoneTip.getState().load()
  }, [stored])

  // The Mac's word when the tunnel is up, the cache's when it is not.
  useEffect(() => {
    if (stored !== 'pending') return
    let current = true
    void (async () => {
      const cached = await readNotificationsCache().catch(() => null)
      if (current && cached) usePhoneTip.setState({ rules: cached.value })
      if (!ready) return
      try {
        const fresh = await clientRef.getNotifications()
        if (current) usePhoneTip.setState({ rules: fresh })
      } catch {
        // The cached rules, or none, stand.
      }
    })()
    return () => {
      current = false
    }
  }, [stored, ready])

  const due = shouldOfferPhoneTip(stored ?? null, rules)
  useEffect(() => {
    const notices = usePhoneNotices.getState()
    if (due) notices.push({ id: NOTIFICATIONS_TIP_ID, kind: 'tip', Body: NotificationsTip })
    else if (notices.queue[0]?.id !== NOTIFICATIONS_TIP_ID) notices.dismiss(NOTIFICATIONS_TIP_ID)
  }, [due])
}

type Phase = 'offer' | 'asking' | 'on' | 'denied'

function NotificationsTip({ close }: { close: () => void }) {
  const [phase, setPhase] = useState<Phase>('offer')
  const stored = usePhoneTip((s) => s.stored)
  const ready = useMobile((s) => s.ready)
  const go = useMobile((s) => s.go)

  // A switch turned on in 9f meanwhile: the offer has nothing left to offer.
  useEffect(() => {
    if (phase === 'offer' && stored !== 'pending') close()
  }, [phase, stored, close])

  const end = () => usePhoneTip.getState().end()
  const dismiss = () => {
    end()
    close()
  }
  const toSettings = () => {
    end()
    close()
    // 2e: Settings opens scrolled to its NOTIFICATIONS group, with no highlight.
    usePhoneTip.setState({ settingsTarget: 'notifications' })
    go('settings')
  }

  const turnOn = async () => {
    const rules = usePhoneTip.getState().rules
    if (!rules) return
    setPhase('asking')
    // 2b: the OS asks now, at the tap, and only if it never asked before.
    if (!(await askForNotifications())) {
      end()
      setPhase('denied')
      return
    }
    try {
      const saved = await clientRef.setNotifications(phoneTurnOn(rules))
      setNotifierRules(saved)
      await writeNotificationsCache(saved, Date.now())
    } catch {
      // The Mac never took it: the offer stands, nothing changed.
      setPhase('offer')
      return
    }
    end()
    setPhase('on')
  }

  if (phase === 'on') {
    // 2c: exactly what was switched on, ticked in the accent.
    return (
      <PinnedNotice label="NOTIFICATIONS · ON" closeLabel="Close" onClose={close}>
        <div className="flex flex-col gap-1.5 text-[14px] font-semibold text-text-bright">
          {['Needs input', 'Errors'].map((row) => (
            <span key={row} className="flex items-center gap-[9px]">
              <span aria-hidden className="w-3.5 text-accent">
                ✓
              </span>
              {row}
            </span>
          ))}
        </div>
        <p className="mt-1.5 pr-3.5 pt-1 text-[13px] leading-[1.45] text-[rgba(160,190,225,.75)] [text-wrap:pretty]">
          Everything else stays off.{' '}
          <button type="button" onClick={toSettings} className="text-[rgba(214,226,242,.92)] underline">
            Settings
          </button>
        </p>
      </PinnedNotice>
    )
  }

  if (phase === 'denied') {
    // 2d: nothing switched on; the phone's own settings, offered once.
    return (
      <PinnedNotice
        label="NOTIFICATIONS · NOT ALLOWED"
        onClose={close}
        actions={
          <NoticeButton
            onClick={() => {
              void openPhoneNotificationSettings()
              close()
            }}
          >
            Open phone settings
          </NoticeButton>
        }
      >
        <PinnedNoticeText>The phone didn&rsquo;t allow notifications, so nothing was switched on.</PinnedNoticeText>
      </PinnedNotice>
    )
  }

  return (
    <PinnedNotice
      label="NOTIFICATIONS · OFF"
      onClose={dismiss}
      actions={
        <>
          <NoticeButton lit disabled={phase === 'asking' || !ready} onClick={() => void turnOn()}>
            Turn on
          </NoticeButton>
          <NoticeButton onClick={toSettings}>Settings</NoticeButton>
        </>
      }
    >
      <PinnedNoticeText>
        Orbital can notify you when a session needs your answer or finishes. This is off by default.
      </PinnedNoticeText>
    </PinnedNotice>
  )
}
