import { useEffect, useState } from 'react'
import { formatFingerprint } from '@orbital/shared/remote/keys'
import type { NotificationSettings } from '@orbital/shared/remote/messages'
import { useOrbital } from '../../store/store'
import { forgetEverything } from '../forget'
import { relayHost } from '../format'
import { readNotificationsCache, writeNotificationsCache } from '../platform/cache'
import { useMobile } from '../state'
import { clientRef } from '../transport/clientRef'
import { MobileScreen, PrimaryButton, SecondaryButton, SectionLabel, Toggle } from '../ui'

/** The desktop's five rows, in its order and with its words (Settings → Notifications). */
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
    label: 'Only when Orbital is in the background',
    desc: 'A focused map already shows every one of these states, so interrupting over it is noise. Turn this off to be notified even with the window in front of you.',
  },
  {
    key: 'sound',
    label: 'Play a sound',
    desc: 'Off delivers them silently — they still appear in Notification Centre.',
  },
]

/** 9f (spec § 5): the Mac, this phone's notification rules, the relay. */
export function SettingsScreen() {
  const pairing = useMobile((s) => s.pairing)
  const macName = useMobile((s) => s.macName)
  const macOnline = useMobile((s) => s.macOnline)
  const ready = useMobile((s) => s.ready)
  const goBack = useMobile((s) => s.goBack)
  const live = useOrbital((s) => Object.values(s.sessions).filter((x) => x.status !== 'ended').length)
  const [rules, setRules] = useState<NotificationSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const name = macName ?? pairing?.macName ?? 'Your Mac'

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
    try {
      const saved = await clientRef.setNotifications({ ...rules, [key]: value })
      setRules(saved)
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
    <div className="flex items-center gap-1 px-1 py-1">
      <button type="button" aria-label="Back" onClick={() => goBack()} className="min-h-11 min-w-11 text-[22px] text-text-soft">
        ‹
      </button>
      <h1 className="text-[17px] font-semibold">Settings</h1>
    </div>
  )

  return (
    <MobileScreen header={header}>
      <SectionLabel>MAC</SectionLabel>
      <div className="mx-4 rounded-[12px] border border-panel-border px-4 py-3">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[15px] text-text-bright">{name}</span>
          <span className="ml-auto shrink-0 font-mono text-[11px] text-text-muted">{macOnline ? 'online' : 'offline'}</span>
        </div>
        <div className="mt-0.5 font-mono text-[11px] text-text-muted">
          {live} live {live === 1 ? 'session' : 'sessions'}
        </div>
        <div className="mt-3">
          <SecondaryButton onClick={() => setConfirming(true)}>Pair a different Mac</SecondaryButton>
          <p className="mt-2 text-center font-mono text-[10.5px] text-text-muted">one Mac per phone · the name is set on the Mac</p>
        </div>
      </div>

      <SectionLabel>NOTIFICATIONS</SectionLabel>
      <div className="mx-4 rounded-[12px] border border-panel-border">
        {NOTIFICATION_ROWS.map((row) => (
          <div key={row.key} className="flex min-h-12 items-center gap-3 border-b border-panel-border px-4 py-3 last:border-b-0">
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] text-text-soft">{row.label}</span>
              <span className="mt-0.5 block text-[12px] leading-[1.45] text-text-muted">{row.desc}</span>
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
      <p className="px-4 pt-2 text-[12px] text-text-muted">Just for this phone. Copied from your Mac when you paired.</p>

      <SectionLabel>ADVANCED</SectionLabel>
      <div className="mx-4 rounded-[12px] border border-panel-border px-4 py-3">
        <div className="flex items-baseline gap-2">
          <span className="text-[14px] text-text-soft">Relay</span>
          <span className="ml-auto truncate font-mono text-[12px] text-text-muted">{pairing ? relayHost(pairing.relay) : '—'}</span>
        </div>
        <p className="mt-1 text-[12px] text-text-muted">Must match the relay set on the Mac.</p>
      </div>

      <footer className="px-4 py-8 text-center font-mono text-[10.5px] text-text-muted">
        orbital mobile {__MOBILE_VERSION__}
        {pairing && ` · fingerprint ${formatFingerprint(pairing.fingerprint)}`}
      </footer>

      {confirming && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Replace ${name}?`}
          onClick={() => setConfirming(false)}
          className="fixed inset-0 z-20 flex items-end bg-[rgba(2,4,9,.6)]"
        >
          <div
            onClick={(event) => event.stopPropagation()}
            className="w-full rounded-t-[16px] border-t border-panel-border bg-panel-solid px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-5"
          >
            <h2 className="text-[17px] font-semibold">Replace {name}?</h2>
            <p className="mt-2 text-[14px] text-text-soft">
              This phone forgets {name} and its key, then opens the scanner. Sessions on the Mac keep running.
            </p>
            <div className="mt-5 flex flex-col gap-2">
              <PrimaryButton onClick={() => void replace()}>Forget and scan</PrimaryButton>
              <SecondaryButton onClick={() => setConfirming(false)}>Cancel</SecondaryButton>
            </div>
          </div>
        </div>
      )}
    </MobileScreen>
  )
}
