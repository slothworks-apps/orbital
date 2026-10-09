import { useState } from 'react'
import { CARD, Toggle } from '../ui'
import { setDiagnostics } from './platform'
import { usePhoneUpdate } from './state'

const TITLE = 'Send diagnostics'

/**
 * 9f's "Send diagnostics" row (spec 2026-10-09-phone-ota-updates-design →
 * Privacy), on by default. A card of its own so it can move: its place in
 * Settings is provisional until Claude Design gives it one.
 */
export function DiagnosticsSetting() {
  const on = usePhoneUpdate((s) => s.diagnostics)
  const [saving, setSaving] = useState(false)

  const change = async (next: boolean) => {
    setSaving(true)
    try {
      await setDiagnostics(next)
    } catch (err) {
      console.warn('[mobile] could not change Send diagnostics', err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className={CARD}>
      <div className="flex min-h-15 items-center gap-2.5 py-2 pl-3.5 pr-1.5">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[14px] font-semibold">{TITLE}</span>
          <span className="text-[11.5px] leading-[1.4] text-[rgba(160,190,225,.6)]">
            Helps catch a broken update: install results, crashes and errors, the phone model and
            its system. Never your name, your sessions or anything on your Mac.
          </span>
        </span>
        <Toggle
          label={TITLE}
          checked={on ?? true}
          disabled={on === null || saving}
          onChange={(next) => void change(next)}
        />
      </div>
    </div>
  )
}
