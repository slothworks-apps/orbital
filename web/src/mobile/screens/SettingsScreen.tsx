import { useEffect, useRef, useState } from 'react'
import { notificationsAllOff, type NotificationSettings } from '@orbital/shared/notifications'
import { confirmIdentity } from '../lockFlow'
import { setRules as setNotifierRules } from '../notify'
import { usePhoneTip } from '../phoneTip'
import { askForNotifications } from '../platform/push'
import { saveAppLock } from '../platform/appLock'
import { readNotificationsCache, writeNotificationsCache } from '../platform/cache'
import { useMobile } from '../state'
import { DiagnosticsSetting } from '../update/DiagnosticsSetting'
import { usePhoneUpdate } from '../update/state'
import { clientRef } from '../transport/clientRef'
import { CARD, MobileScreen, SectionLabel, SheetPresence, Toggle } from '../ui'
import { DevicesSection } from './DevicesSection'
import { FeedbackSheet } from './FeedbackSheet'
import { isDemo } from '../../lib/demo'

/**
 * The desktop's five rows, in its order (Settings → Notifications). Three
 * keep the desktop's words; `onlyWhenBackground` and `sound` are reworded
 * for the phone (spec "As built (2a)") since the desktop's copy ("Only
 * when Orbital is in the background", "they still appear in Notification
 * Centre") names desktop-only concepts.
 */
export const NOTIFICATION_ROWS: readonly { key: keyof NotificationSettings; label: string; desc: string }[] = [
  {
    key: 'needsInput',
    label: 'A session needs your input',
    desc: 'A turn finished, a permission prompt is waiting, or the session asked a question.',
  },
  {
    key: 'sessionEnded',
    label: 'A session ends',
    desc: 'Only when it was working — a terminal session ageing out on the idle timer is the clock talking, not the session, and never notifies.',
  },
  {
    key: 'sessionFailed',
    label: 'A session fails',
    desc: 'The process died or never started. The body stays on the map and the error is kept in the log either way.',
  },
  {
    key: 'onlyWhenBackground',
    label: 'Only when the app is in the background',
    desc: 'Skip the system notification while the app is open — the banner shows it instead.',
  },
  {
    key: 'sound',
    label: 'Play a sound',
    desc: 'Off delivers them silently.',
  },
]

/** 9f (spec § 5): the group's devices (canvas 50i), this phone's notification rules, the app lock. */
export function SettingsScreen() {
  const shell = usePhoneUpdate((s) => s.shell)
  const ready = useMobile((s) => s.ready)
  const goBack = useMobile((s) => s.goBack)
  const [rules, setRules] = useState<NotificationSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const notificationsGroup = useRef<HTMLDivElement>(null)

  // Opened from the notifications tip: scrolled to this group, with no
  // highlight (canvas `Feature - Notifications off` 2e). Once.
  useEffect(() => {
    if (usePhoneTip.getState().settingsTarget !== 'notifications') return
    usePhoneTip.setState({ settingsTarget: null })
    notificationsGroup.current?.scrollIntoView({ block: 'start' })
  }, [])

  // Read on open: from the Mac when the tunnel is up, as last read when it is not.
  useEffect(() => {
    let current = true
    void (async () => {
      const cached = await readNotificationsCache()
      if (current && cached) setRules(cached.value)
      if (!ready) return
      try {
        const fresh = await clientRef.getNotifications()
        if (!current) return
        setRules(fresh)
        await writeNotificationsCache(fresh, Date.now())
      } catch {
        // The cached rules, or none, stand.
      }
    })()
    return () => {
      current = false
    }
  }, [ready])

  const toggle = async (key: keyof NotificationSettings, value: boolean) => {
    if (!rules) return
    setSaving(true)
    // Any switch changed ends the tip for good (spec
    // 2026-10-08-notifications-off-by-default-design § 5).
    usePhoneTip.getState().end()
    try {
      // 2e: one that notifies asks the phone the first time, as the tip's Turn
      // on does. Saved either way: a refusal is the OS's to undo, not the rule's.
      if (value && key !== 'onlyWhenBackground') await askForNotifications()
      const saved = await clientRef.setNotifications({ ...rules, [key]: value })
      setRules(saved)
      setNotifierRules(saved)
      await writeNotificationsCache(saved, Date.now())
    } catch {
      // Unchanged: the Mac never took it, and the row still shows what it holds.
    } finally {
      setSaving(false)
    }
  }

  const header = (
    <div className="flex h-13 items-center gap-1 px-1.5">
      <button
        type="button"
        aria-label="Back"
        onClick={() => goBack()}
        className="grid h-11 w-11 place-items-center text-[28px] leading-none text-[rgba(220,235,255,.85)]"
      >
        ‹
      </button>
      <h1 className="flex-1 text-[17px] font-bold">Settings</h1>
    </div>
  )

  return (
    <MobileScreen header={header}>
      <div className="flex flex-col px-4 pb-4 pt-1.5">
        <DevicesSection />

        <div ref={notificationsGroup} />
        <SectionLabel>NOTIFICATIONS</SectionLabel>
        <div className={CARD}>
          {NOTIFICATION_ROWS.map((row, i) => (
            <div
              key={row.key}
              className={['flex min-h-15 items-center gap-2.5 py-2 pl-3.5 pr-1.5', i > 0 ? 'border-t border-[rgba(150,205,255,.08)]' : ''].join(' ')}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[14px] font-semibold">{row.label}</span>
                <span className="text-[11.5px] leading-[1.4] text-[rgba(160,190,225,.6)]">{row.desc}</span>
              </span>
              <Toggle
                label={row.label}
                checked={rules?.[row.key] ?? false}
                disabled={!rules || !ready || saving}
                onChange={(next) => void toggle(row.key, next)}
              />
            </div>
          ))}
        </div>
        {/* 2e: replaces "Copied from your Mac when you paired." */}
        <p className="px-1 pt-2 text-[12px] leading-[1.5] text-[rgba(160,190,225,.65)]">
          {rules && !notificationsAllOff(rules)
            ? 'Just for this phone.'
            : 'Just for this phone. All off until you turn one on. The first one asks the phone for permission.'}
        </p>

        <SecuritySection />

        <SectionLabel>ADVANCED</SectionLabel>
        {/* Provisional place, until Claude Design gives it one. */}
        <DiagnosticsSetting />

        {/* Not in the website's demo, where it would open a real issue form. */}
        {!isDemo() && <AboutSection />}
        {/* Canvas `Feature - Phone update`: the app's version and the shell's on one line; 50i's note on names. */}
        <footer className="px-1 pt-[18px] font-mono text-[10px] leading-[1.7] text-[rgba(160,190,225,.6)]">
          <p>{shell ? `${__MOBILE_VERSION__} · shell ${shell}` : __MOBILE_VERSION__} · each device names itself</p>
        </footer>
      </div>
    </MobileScreen>
  )
}

/**
 * 9f's SECURITY group (spec 2026-10-06-pairing-code-and-app-lock-design
 * § 3): one toggle, named after what the phone authenticates with. Turning
 * it off asks for that first, so whoever holds an unlocked app cannot
 * switch it off for later; a failed or cancelled prompt leaves it on.
 */
function SecuritySection() {
  const on = useMobile((s) => s.appLock)
  const label = useMobile((s) => s.lockLabel)
  const [saving, setSaving] = useState(false)
  const title = `Require ${label} to open`

  const change = async (next: boolean) => {
    setSaving(true)
    try {
      if (!next && !(await confirmIdentity())) return
      await saveAppLock(next)
      useMobile.setState({ appLock: next })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <SectionLabel>SECURITY</SectionLabel>
      <div className={CARD}>
        <div className="flex min-h-15 items-center gap-2.5 py-2 pl-3.5 pr-1.5">
          <span className="min-w-0 flex-1 text-[14px] font-semibold">{title}</span>
          <Toggle label={title} checked={on} disabled={saving} onChange={(next) => void change(next)} />
        </div>
      </div>
      <p className="px-1 pt-2 text-[12px] leading-[1.5] text-[rgba(160,190,225,.65)]">Asks again after a minute in the background.</p>
    </>
  )
}

/** `Feature - Feedback` 61i: ABOUT, whose one row opens Send feedback. */
function AboutSection() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <SectionLabel>ABOUT</SectionLabel>
      <div className={CARD}>
        <button type="button" onClick={() => setOpen(true)} className="flex min-h-13 w-full items-center gap-2.5 px-3.5 text-left">
          <span className="flex-1 text-[14px] font-semibold">Send feedback</span>
          <span className="font-mono text-[11px] text-[rgba(160,190,225,.6)]">opens GitHub ↗</span>
        </button>
      </div>
      <SheetPresence>{open && <FeedbackSheet onClose={() => setOpen(false)} />}</SheetPresence>
    </>
  )
}
