import { useEffect, useRef, useState } from 'react'
import { formatFingerprint } from '@orbital/shared/remote/keys'
import { notificationsAllOff, type NotificationSettings } from '@orbital/shared/notifications'
import { useOrbital } from '../../store/store'
import { forgetEverything } from '../forget'
import { confirmIdentity } from '../lockFlow'
import { relayHost } from '../format'
import { setRules as setNotifierRules } from '../notify'
import { usePhoneTip } from '../phoneTip'
import { askForNotifications } from '../platform/push'
import { saveAppLock } from '../platform/appLock'
import { readNotificationsCache, writeNotificationsCache } from '../platform/cache'
import { useMobile } from '../state'
import { DiagnosticsSetting } from '../update/DiagnosticsSetting'
import { usePhoneUpdate } from '../update/state'
import { clientRef } from '../transport/clientRef'
import { CARD, MobileScreen, PrimaryButton, SecondaryButton, SectionLabel, Toggle } from '../ui'

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

/** 9f (spec § 5): the Mac, this phone's notification rules, the app lock, the relay. */
export function SettingsScreen() {
  const pairing = useMobile((s) => s.pairing)
  const shell = usePhoneUpdate((s) => s.shell)
  const macName = useMobile((s) => s.macName)
  const macOnline = useMobile((s) => s.macOnline)
  const ready = useMobile((s) => s.ready)
  const goBack = useMobile((s) => s.goBack)
  const live = useOrbital((s) => Object.values(s.sessions).filter((x) => x.status !== 'ended').length)
  const [rules, setRules] = useState<NotificationSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [relayOpen, setRelayOpen] = useState(false)
  const name = macName ?? pairing?.macName ?? 'Your Mac'
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

  const replace = async () => {
    setConfirming(false)
    // Forget the pairing, the identity and the cache; the scanner comes next.
    await forgetEverything({ unpaired: false })
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
        <SectionLabel first>MAC</SectionLabel>
        <div className={CARD}>
          <div className="flex min-h-16 items-center gap-3 px-3.5">
            <span
              aria-hidden
              className={[
                'block h-2 w-2 shrink-0 rounded-full',
                macOnline ? 'bg-[oklch(85%_.12_205)] shadow-[0_0_8px_oklch(85%_.12_205)]' : 'border-[1.5px] border-[rgba(200,215,235,.6)]',
              ].join(' ')}
            />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-[14.5px] font-semibold">{name}</span>
              <span className="font-mono text-[10.5px] text-[rgba(160,190,225,.65)]">
                {macOnline ? 'online' : 'offline'} · {live} live {live === 1 ? 'session' : 'sessions'}
              </span>
            </span>
          </div>
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="flex min-h-13 w-full items-center border-t border-[rgba(150,205,255,.08)] px-3.5 text-left text-[14px] font-semibold text-text-bright"
          >
            Pair a different Mac
          </button>
        </div>
        <p className="px-1 pt-2 font-mono text-[10px] leading-[1.6] text-[rgba(160,190,225,.5)]">one Mac per phone · the name is set on the Mac</p>

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
        <div className={[CARD, 'mt-2'].join(' ')}>
          <button
            type="button"
            aria-expanded={relayOpen}
            onClick={() => setRelayOpen(!relayOpen)}
            className="flex min-h-13 w-full items-center gap-2.5 px-3.5 text-left"
          >
            <span aria-hidden className="text-[9px] text-[rgba(160,190,225,.6)]">
              {relayOpen ? '▾' : '▸'}
            </span>
            <span className="flex-1 text-[14px] font-semibold">Relay</span>
            <span className="min-w-0 truncate font-mono text-[11px] text-[rgba(160,190,225,.6)]">{pairing ? relayHost(pairing.relay) : '—'}</span>
          </button>
          {relayOpen && (
            <p className="px-3.5 pb-3.5 text-[11.5px] leading-[1.45] text-[rgba(160,190,225,.6)]">
              Must match the relay set on the Mac. The relay only sees encrypted bytes.
            </p>
          )}
        </div>

        {/* Canvas `Feature - Phone update`: the app's version and the shell's on one line, the fingerprint on its own. */}
        <footer className="px-1 pt-[18px] font-mono text-[10px] leading-[1.7] text-[rgba(160,190,225,.6)]">
          <p>{shell ? `${__MOBILE_VERSION__} · shell ${shell}` : __MOBILE_VERSION__}</p>
          {pairing && <p>fingerprint {formatFingerprint(pairing.fingerprint)}</p>}
        </footer>
      </div>

      {confirming && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Replace ${name}?`}
          onClick={() => setConfirming(false)}
          className="fixed inset-0 z-20 flex items-end bg-[rgba(2,3,8,.62)]"
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="flex w-full flex-col gap-3 rounded-t-[26px] border-t border-[rgba(150,205,255,.18)] bg-[rgba(10,16,28,.98)] px-4 pb-[calc(30px+env(safe-area-inset-bottom))] pt-2.5 shadow-[0_-20px_60px_rgba(0,0,0,.5)]"
          >
            <span aria-hidden className="mx-auto mb-1.5 block h-1 w-9 rounded-full bg-[rgba(232,238,248,.25)]" />
            <h2 className="text-[18px] font-bold">Replace {name}?</h2>
            <p className="text-[14px] leading-[1.5] text-[rgba(200,214,235,.85)]">
              This phone forgets {name} and its key, then opens the scanner. Sessions on the Mac keep running.
            </p>
            <div className="mt-1.5 flex flex-col gap-3">
              <PrimaryButton onClick={() => void replace()}>Forget and scan</PrimaryButton>
              <SecondaryButton onClick={() => setConfirming(false)}>Cancel</SecondaryButton>
            </div>
          </div>
        </div>
      )}
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
