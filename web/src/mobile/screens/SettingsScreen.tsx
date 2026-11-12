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
import { useAppliedChannel } from '../update/channel'
import { installId } from '../update/platform'
import { copyToClipboard } from '../../lib/clipboard'
import { usePhoneUpdate } from '../update/state'
import { clientRef } from '../transport/clientRef'
import { PRIVACY_POLICY_URL } from '../constants'
import { CARD, MobileScreen, SectionLabel, SheetPresence, Toggle } from '../ui'
import { AppearanceSection } from './AppearanceSection'
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

/** 9f (spec § 5): the group's devices (canvas 50i), this phone's colours (1k), its notification rules, the app lock. */
export function SettingsScreen() {
  const shell = usePhoneUpdate((s) => s.shell)
  // This phone took experimental updates (canvas `Feature - Experimental updates` 1g): said, not switched,
  // here. What the plugin applied, not the group's setting: an older shell that refused it says nothing.
  const experimental = useAppliedChannel((s) => s.channel === 'experimental')
  const version = experimental ? `${__MOBILE_VERSION__} · experimental` : __MOBILE_VERSION__
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
        className="grid h-11 w-11 place-items-center fs-28 leading-none text-ink-200/85"
      >
        ‹
      </button>
      <h1 className="flex-1 fs-17 font-bold">Settings</h1>
    </div>
  )

  return (
    <MobileScreen header={header}>
      <div className="flex flex-col px-4 pb-4 pt-1.5">
        <DevicesSection />

        {/* Canvas `Feature - Colour themes` 1k A: between the Mac and the notifications. */}
        <AppearanceSection />

        <div ref={notificationsGroup} />
        <SectionLabel>NOTIFICATIONS</SectionLabel>
        <div className={CARD}>
          {NOTIFICATION_ROWS.map((row, i) => (
            <div
              key={row.key}
              className={['flex min-h-15 items-center gap-2.5 py-2 pl-3.5 pr-1.5', i > 0 ? 'border-t border-line/8' : ''].join(' ')}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="fs-14 font-semibold">{row.label}</span>
                <span className="fs-11.5 leading-[1.4] text-ink-900/60">{row.desc}</span>
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
        <p className="px-1 pt-2 fs-12 leading-[1.5] text-ink-900/65">
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
        {experimental && (
          // 1g: one line on what it means and where it is changed; no link, the switch lives on a Mac.
          <p className="px-1 pt-2 fs-12 leading-[1.5] text-ink-900/65">
            Experimental updates are on for your group, so this phone gets each release early. They’re turned on and
            off on a Mac, in Settings → Updates.
          </p>
        )}
        {/* Canvas `Feature - Phone update`: the app's version and the shell's on one line; 50i's note on names. */}
        <footer className="px-1 pt-[18px] font-mono fs-10 leading-[1.7] text-ink-900/60">
          <p>{shell ? `${version} · shell ${shell}` : version} · each device names itself</p>
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
          <span className="min-w-0 flex-1 fs-14 font-semibold">{title}</span>
          <Toggle label={title} checked={on} disabled={saving} onChange={(next) => void change(next)} />
        </div>
      </div>
      <p className="px-1 pt-2 fs-12 leading-[1.5] text-ink-900/65">Asks again after a minute in the background.</p>
    </>
  )
}

/**
 * `Feature - Feedback` 61i: ABOUT, whose row opens Send feedback; under it
 * the privacy policy, which the App Store asks to be reachable in the app,
 * and the install id a request to delete this phone's data names
 * (provisional place, until Claude Design gives it one).
 */
function AboutSection() {
  const [open, setOpen] = useState(false)
  const [id, setId] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    void installId().then(setId)
  }, [])
  return (
    <>
      <SectionLabel>ABOUT</SectionLabel>
      <div className={CARD}>
        <button type="button" onClick={() => setOpen(true)} className="flex min-h-13 w-full items-center gap-2.5 px-3.5 text-left">
          <span className="flex-1 fs-14 font-semibold">Send feedback</span>
          <span className="font-mono fs-11 text-ink-900/60">opens GitHub ↗</span>
        </button>
        <button
          type="button"
          onClick={() => window.open(PRIVACY_POLICY_URL, '_blank', 'noopener')}
          className="flex min-h-13 w-full items-center gap-2.5 border-t border-line/8 px-3.5 text-left"
        >
          <span className="flex-1 fs-14 font-semibold">Privacy policy</span>
          <span className="font-mono fs-11 text-ink-900/60">opens the website ↗</span>
        </button>
        {id && (
          <button
            type="button"
            onClick={() => void copyToClipboard(id).then(setCopied)}
            className="flex min-h-13 w-full flex-col items-start justify-center gap-0.5 border-t border-line/8 px-3.5 py-2 text-left"
          >
            <span className="flex w-full items-center gap-2.5">
              <span className="flex-1 fs-14 font-semibold">Install ID</span>
              <span className="font-mono fs-11 text-ink-900/60">{copied ? 'copied' : 'copy'}</span>
            </span>
            <span data-selectable className="break-all font-mono fs-11 text-ink-900/60">
              {id}
            </span>
            <span className="fs-12 leading-[1.5] text-ink-900/65">
              Send it to orbital@slothworks.io to have this phone’s update data deleted.
            </span>
          </button>
        )}
      </div>
      <SheetPresence>{open && <FeedbackSheet onClose={() => setOpen(false)} />}</SheetPresence>
    </>
  )
}
