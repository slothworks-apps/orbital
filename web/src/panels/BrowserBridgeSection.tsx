import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import {
  BROWSER_BRIDGE_SETTING,
  browserBridgeEnabled,
  type BrowserPairing,
  type BrowserStatus,
} from '../lib/browserBridge'
import { canShowBrowserExtension, showBrowserExtension } from '../lib/desktop'
import { reportError } from '../lib/errors'
import { codeLeft } from '../lib/remote'
import { onBrowserStatus } from '../lib/useBrowserBridge'
import { useNow } from '../lib/useNow'
import { Button } from '../ui/Button'
import { Toggle } from '../ui/Checkbox'
import { MemberDot } from '../ui/MemberDot'
import { Row } from './settingsRows'

/**
 * Settings → Labs → Browser bridge (spec 2026-11-05-browser-bridge-design
 * § Pairing, § Installing it): the switch, and while it is on the pairing
 * code, the paired extensions and how to install one.
 *
 * Provisional look: the settings rows, buttons and dots that exist, until
 * Claude Design draws the section.
 */
export function BrowserBridgeRows({
  settings,
  patchAndSet,
}: {
  settings: Record<string, string | undefined>
  patchAndSet: (patch: Record<string, string>) => Promise<boolean>
}) {
  const enabled = browserBridgeEnabled(settings)
  return (
    <>
      <Row
        title="Browser bridge"
        setting={BROWSER_BRIDGE_SETTING}
        desc="An extension for Chrome, Arc and other Chromium browsers. What you select in a page, and a screenshot you take, lands in the composer of the session open in Orbital; a session can also take a screenshot of the browser when it needs to see the page."
      >
        <Toggle
          aria-label="Browser bridge"
          checked={enabled}
          onChange={(checked) => void patchAndSet({ [BROWSER_BRIDGE_SETTING]: checked ? 'true' : 'false' })}
        />
      </Row>
      {enabled && <BrowserPairingRows />}
    </>
  )
}

function pairedDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

function BrowserPairingRows() {
  const [status, setStatus] = useState<BrowserStatus | null>(null)
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const now = useNow(code !== null)
  const left = code ? codeLeft(code.expiresAt, now) : null

  // Read once, then followed live on the `browser` topic.
  useEffect(() => {
    let live = true
    api
      .browserStatus()
      .then((next) => live && setStatus(next))
      .catch((err) => reportError(err, 'Failed to read the browser bridge'))
    const off = onBrowserStatus((next) => setStatus(next))
    return () => {
      live = false
      off()
    }
  }, [])

  // A new pairing used the code: it is spent, so it goes.
  const pairingCount = status?.pairings.length ?? 0
  const [countAtCode, setCountAtCode] = useState(0)
  useEffect(() => {
    if (code && pairingCount > countAtCode) setCode(null)
  }, [code, pairingCount, countAtCode])

  async function newCode() {
    setBusy(true)
    try {
      const next = await api.browserPairingCode()
      setCountAtCode(pairingCount)
      setCode(next)
    } catch (err) {
      reportError(err, 'Failed to make a pairing code')
    } finally {
      setBusy(false)
    }
  }

  async function unpair(pairing: BrowserPairing) {
    try {
      await api.unpairBrowser(pairing.id)
      setStatus((current) =>
        current ? { ...current, pairings: current.pairings.filter((p) => p.id !== pairing.id) } : current,
      )
    } catch (err) {
      reportError(err, `Failed to unpair ${pairing.browser}`)
    }
  }

  const open = code !== null && left !== null && !left.expired

  return (
    <>
      <Row
        title="Pair a browser"
        desc="Type the code into the extension's popup. It works once, for a few minutes."
      >
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void newCode()}>
          {open ? 'New code' : 'Pair a browser'}
        </Button>
        {code && (
          <div className="flex flex-col gap-1">
            <span
              data-selectable
              aria-label="Browser pairing code"
              className={`select-all font-mono fs-13.5 tracking-[0.18em] text-ink-100 ${open ? '' : 'opacity-30'}`}
            >
              {code.code}
            </span>
            <span className="font-mono fs-10.5 text-ink-900/65">
              {open && left ? `expires in ${left.label}` : 'expired · make a new code'}
            </span>
          </div>
        )}
      </Row>
      <Row title="Paired browsers" desc="Unpair one and its extension stops reaching Orbital until it is paired again.">
        {status === null ? null : status.pairings.length === 0 ? (
          <span className="fs-12.5 text-ink-900/60">None yet</span>
        ) : (
          <ul className="flex w-full flex-col gap-2">
            {status.pairings.map((pairing) => (
              <li key={pairing.id} className="flex items-center gap-2.5">
                <MemberDot state={pairing.connected ? 'online' : 'offline'} sizePx={7} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate fs-13 text-ink-100">{pairing.browser}</span>
                  <span className="block font-mono fs-10.5 text-ink-900/50">
                    {pairing.connected ? 'connected' : 'not connected'} · paired {pairedDate(pairing.pairedAt)}
                  </span>
                </span>
                <Button variant="ghost" size="sm" onClick={() => void unpair(pairing)}>
                  Unpair
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Row>
      <Row
        title="Install the extension"
        desc={
          <ol className="list-decimal pl-4">
            <li>Open chrome://extensions in your browser.</li>
            <li>Turn on Developer mode.</li>
            <li>Choose Load unpacked and pick the extension folder.</li>
            <li>Open the extension's popup and enter the pairing code.</li>
          </ol>
        }
      >
        {canShowBrowserExtension() && (
          <Button variant="outline" size="sm" onClick={() => showBrowserExtension()}>
            Show the extension folder
          </Button>
        )}
      </Row>
    </>
  )
}
