import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import {
  BROWSER_BRIDGE_SETTING,
  browserBridgeEnabled,
  pairingCodeHalves,
  type BrowserPairing,
  type BrowserStatus,
} from '../lib/browserBridge'
import { browserExtensionPath, canShowBrowserExtension, showBrowserExtension } from '../lib/desktop'
import { reportError } from '../lib/errors'
import { homePath } from '../lib/format'
import { onBrowserStatus } from '../lib/useBrowserBridge'
import { Button } from '../ui/Button'
import { Toggle } from '../ui/Checkbox'
import { Row } from './settingsRows'

/**
 * Settings → Labs → Browser bridge (spec 2026-11-05-browser-bridge-design
 * § Pairing, § Installing it; canvas `Feature - Browser bridge` 64e/64f): the
 * switch, and while it is on the paired browsers of this Mac, the pairing
 * code and where the extension is.
 */
export function BrowserBridgeRows({
  settings,
  patchAndSet,
}: {
  settings: Record<string, string | undefined>
  patchAndSet: (patch: Record<string, string>) => Promise<boolean>
}) {
  const enabled = browserBridgeEnabled(settings)
  const [status, setStatus] = useState<BrowserStatus | null>(null)

  // Read when the switch is on, then followed live on the `browser` topic.
  useEffect(() => {
    if (!enabled) return
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
  }, [enabled])

  return (
    <>
      <Row
        title="Browser bridge"
        setting={BROWSER_BRIDGE_SETTING}
        labs
        desc={
          // 64f: two lines, 2px apart.
          <span className="flex flex-col gap-0.5">
            <span>
              Chrome, Arc, Dia or Vivaldi sends what you select on a page, and the screenshots you take, to
              the session open in Orbital.
            </span>
            <span>The agent can take a screenshot of the browser’s active tab.</span>
          </span>
        }
      >
        <Toggle
          aria-label="Browser bridge"
          checked={enabled}
          onChange={(checked) => void patchAndSet({ [BROWSER_BRIDGE_SETTING]: checked ? 'true' : 'false' })}
        />
        {enabled && status && (
          // 64f-2: where Orbital listens — the port the extension's Advanced field takes.
          <span className="font-mono fs-11 leading-[1.5] text-ink-500/82">
            on · listening on localhost:{status.port}
          </span>
        )}
      </Row>
      {enabled && <BrowserPairings status={status} onStatus={setStatus} />}
    </>
  )
}

/** 64f's kicker: mono 10 at .18em in the muted ink. */
function Kicker({ children }: { children: string }) {
  return <span className="font-mono fs-10 tracking-[0.18em] text-ink-900/68">{children}</span>
}

/** The day as the rows say it: `3 Nov`, with the year only when it is not this one. */
function dayLabel(ts: number, now: number): string {
  const at = new Date(ts)
  const sameYear = at.getFullYear() === new Date(now).getFullYear()
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })
}

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 64f-4: `paired 3 Nov`, or `paired just now` for one made in the last minute. */
function pairedLabel(ts: number, now: number): string {
  return now - ts < 60_000 ? 'paired just now' : `paired ${dayLabel(ts, now)}`
}

/** 64f-4: `connected`, or `not connected · last seen yesterday`. */
function stateLabel(pairing: BrowserPairing, now: number): string {
  if (pairing.connected) return 'connected'
  if (pairing.lastSeenAt === null) return 'not connected'
  const days = Math.round((startOfDay(now) - startOfDay(pairing.lastSeenAt)) / 86_400_000)
  const when =
    days <= 0
      ? `at ${new Date(pairing.lastSeenAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
      : days === 1
        ? 'yesterday'
        : dayLabel(pairing.lastSeenAt, now)
  return `not connected · last seen ${when}`
}

function BrowserPairings({
  status,
  onStatus,
}: {
  status: BrowserStatus | null
  onStatus: (update: (current: BrowserStatus | null) => BrowserStatus | null) => void
}) {
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null)
  const [expired, setExpired] = useState(false)
  const [busy, setBusy] = useState(false)
  const [stepsOpen, setStepsOpen] = useState(false)
  const [folder, setFolder] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void browserExtensionPath().then((path) => live && setFolder(path))
    return () => {
      live = false
    }
  }, [])

  // 64f-3: the validity line stands still — no countdown (why-orbital) — and
  // when the code lapses it says so in place.
  useEffect(() => {
    if (!code) return
    setExpired(false)
    const timer = setTimeout(() => setExpired(true), Math.max(0, code.expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [code])

  // A new pairing used the code: it is spent, so the panel closes and the row is there.
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

  // 64f: Unpair is immediate, without a confirm — pairing again takes a minute.
  async function unpair(pairing: BrowserPairing) {
    try {
      await api.unpairBrowser(pairing.id)
      onStatus((current) =>
        current ? { ...current, pairings: current.pairings.filter((p) => p.id !== pairing.id) } : current,
      )
    } catch (err) {
      reportError(err, `Failed to unpair ${pairing.browser}`)
    }
  }

  const pairings = status?.pairings ?? []
  const none = status !== null && pairings.length === 0
  const now = Date.now()
  const [left, right] = code ? pairingCodeHalves(code.code) : ['', '']
  // The steps are open while nothing is paired; once anything is, they fold
  // into one line (64f-4).
  const showSteps = none || stepsOpen

  return (
    <>
      {/* 64f: PAIRED BROWSERS · THIS MAC, Pair a browser at its right end. */}
      <div className="flex min-h-[34px] items-center gap-3 pb-1.5 pt-3">
        <Kicker>PAIRED BROWSERS · THIS MAC</Kicker>
        <span className="flex-1" />
        {!code && (
          <Button variant="hairline" size="labs" disabled={busy} onClick={() => void newCode()}>
            Pair a browser
          </Button>
        )}
      </div>

      {code && (
        // 64f-3: Pair a browser turns into the code panel in place.
        <div className="mb-2 flex items-center gap-5 rounded-[12px] border border-line/16 bg-space/55 px-[18px] py-4">
          <div className="flex flex-1 flex-col gap-1.5">
            <Kicker>TYPE THIS IN THE EXTENSION</Kicker>
            <span
              data-selectable
              aria-label="Browser pairing code"
              className={[
                'font-mono fs-28 font-medium tracking-[0.24em] text-ink-100',
                expired ? 'opacity-30' : '',
              ].join(' ')}
            >
              {left}
              {/* The halves stand a space apart, and copy as one code. */}
              <span className="select-none"> </span>
              {right}
            </span>
            <span className="font-mono fs-11 text-ink-500/82">
              {expired ? (
                <>
                  expired ·{' '}
                  <Button variant="dashed-link" size="inline" disabled={busy} onClick={() => void newCode()}>
                    Make a new code
                  </Button>
                </>
              ) : (
                'valid for 5 minutes · works once'
              )}
            </span>
          </div>
          <Button variant="hairline" size="labs" onClick={() => setCode(null)}>
            Cancel
          </Button>
        </div>
      )}

      {none && !code && (
        <div className="border-t border-line/8 py-3 fs-12.5 text-ink-900/68">
          No browser paired yet. Load the extension below, then press Pair a browser.
        </div>
      )}

      {pairings.map((pairing) => (
        <div
          key={pairing.id}
          className="grid grid-cols-[minmax(0,1fr)_250px_auto] items-center gap-4 border-t border-line/8 py-2.5"
        >
          <div className="flex min-w-0 items-baseline gap-2.5">
            <span className="truncate fs-13.5 font-semibold text-ink-100">{pairing.browser}</span>
            <span className="flex-none font-mono fs-11 text-ink-900/68">{pairedLabel(pairing.pairedAt, now)}</span>
          </div>
          <div className="flex items-center gap-2 whitespace-nowrap font-mono fs-11 text-ink-500/82">
            {/* The accent dot every "on" uses; a hollow one when not connected. */}
            <span
              aria-hidden
              className={[
                'box-border block h-[7px] w-[7px] flex-none rounded-full border',
                pairing.connected ? 'border-accent bg-accent' : 'border-line/30',
              ].join(' ')}
            />
            {stateLabel(pairing, now)}
          </div>
          <Button variant="hairline" size="labs-row" onClick={() => void unpair(pairing)}>
            Unpair
          </Button>
        </div>
      ))}

      <div className="pb-1.5 pt-4">
        <Kicker>EXTENSION</Kicker>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-6 border-t border-line/8 py-3">
        <div>
          <div className="fs-12.5 leading-[1.5] text-ink-500/82 [text-wrap:pretty]">
            It isn’t in a store. Each browser loads it once, from this folder.
          </div>
          {folder && (
            <div data-selectable className="mt-1 break-all font-mono fs-11 text-ink-900/68">
              {homePath(folder)}
            </div>
          )}
        </div>
        {canShowBrowserExtension() && (
          <Button variant="hairline" size="labs" onClick={() => showBrowserExtension()}>
            Show the extension folder
          </Button>
        )}
      </div>
      {!none && (
        <button
          type="button"
          aria-expanded={stepsOpen}
          onClick={() => setStepsOpen((open) => !open)}
          className="self-start py-1 text-left font-mono fs-11 text-ink-500/82"
        >
          How to install in another browser {stepsOpen ? '▾' : '▸'}
        </button>
      )}
      {showSteps && (
        <ol className="mt-1 flex list-decimal flex-col gap-[5px] pl-5 fs-12.5 leading-[1.5] text-ink-500/82">
          <li>
            Press <span className="text-ink-100">Show the extension folder</span>.
          </li>
          <li>
            In the browser, open <span className="font-mono fs-11.5 text-ink-100">chrome://extensions</span>. It works
            in Arc, Dia and Vivaldi too.
          </li>
          <li>
            Turn on <span className="text-ink-100">Developer mode</span>, top right.
          </li>
          <li>
            <span className="text-ink-100">Load unpacked</span> → choose the folder.
          </li>
          <li>
            Open the extension from the toolbar and type the code from{' '}
            <span className="text-ink-100">Pair a browser</span>.
          </li>
        </ol>
      )}
    </>
  )
}
