import { useEffect, useState } from 'react'
import { useOrbital } from '../store/store'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { useNow } from '../lib/useNow'
import type { PeerMac } from '../lib/types'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { SectionLabel } from './settingsRows'

const MUTED = 'text-[rgba(160,190,225,.6)]'
const CAPTION = 'font-mono text-[11px] text-[rgba(160,190,225,.55)]'
const BLOCK = 'border-t border-[rgba(150,205,255,.08)] py-[13px]'

function shortDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/**
 * Settings → Devices → Macs section (spec 2026-10-06-peer-macs-design § 3):
 * List of paired Macs, show this Mac's pairing code, and pair with another Mac.
 */
export function MacsSection({
  onSaved,
}: {
  onSaved: () => void
}) {
  const peers = useOrbital((s) => s.peers)
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null)
  const [codeLoading, setCodeLoading] = useState(false)
  const [pairingCode, setPairingCode] = useState('')
  const [pairingBusy, setPairingBusy] = useState(false)
  const [pendingMac, setPendingMac] = useState<{ mac: string; name: string; code: string } | null>(null)

  // Clear pending pairing when it completes or expires
  useEffect(() => {
    if (!pendingMac || !peers) return
    // Check if this peer has appeared in the list
    const hasPaired = peers.peers.some((p) => p.id === pendingMac.mac)
    // Or if pairing was canceled on the other Mac
    const stillPairing = peers.pairing?.mac === pendingMac.mac
    if (hasPaired || !stillPairing) {
      setPendingMac(null)
    }
  }, [peers, pendingMac])

  if (!peers) return null

  async function generateCode() {
    if (codeLoading) return
    setCodeLoading(true)
    try {
      const res = await api.generatePeerCode()
      if ('error' in res) {
        const messages: Record<string, string> = {
          disabled: 'Turn on Mobile and set a relay first — Macs pair through it',
          offline: 'The relay is offline',
          relay_error: "The relay didn't answer",
          relay_too_old: 'The relay needs an update',
        }
        reportError(null, messages[res.error] || 'Failed to generate pairing code')
        return
      }
      setCode({
        code: res.code,
        expiresAt: res.expiresAt,
      })
    } catch (err) {
      reportError(err, 'Failed to generate pairing code')
    } finally {
      setCodeLoading(false)
    }
  }

  async function pair() {
    if (pairingBusy || !pairingCode.trim()) return
    setPairingBusy(true)
    try {
      const res = await api.pairWithPeer(pairingCode.trim())
      if ('error' in res) {
        const messages: Record<string, string> = {
          bad_code: 'Invalid code',
          already_paired: 'Already paired with this Mac',
          relay_unreachable: 'The relay is unreachable',
          code_refused: 'The code was refused',
        }
        reportError(null, messages[res.error] || 'Pairing failed')
        return
      }
      setPendingMac(res)
      setPairingCode('')
    } catch (err) {
      reportError(err, 'Pairing failed')
    } finally {
      setPairingBusy(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-col overflow-y-auto px-8 pb-5 pt-2">
      <SectionLabel first>PAIRED MACS</SectionLabel>
      {peers.peers.length === 0 ? (
        <div className={`${BLOCK} flex flex-col gap-1`}>
          <span className="text-[13px] font-semibold text-text-bright">No Macs yet</span>
          <span className={`text-[12px] ${MUTED}`}>Pair a Mac below to see it here.</span>
        </div>
      ) : (
        peers.peers.map((peer) => <PairedMacRow key={peer.id} peer={peer} onSaved={onSaved} />)
      )}

      <SectionLabel>THIS MAC'S CODE</SectionLabel>
      <PeeringCodeSection code={code} loading={codeLoading} onGenerate={generateCode} />

      <SectionLabel>PAIR WITH ANOTHER MAC</SectionLabel>
      <PairingInput
        value={pairingCode}
        onChange={setPairingCode}
        onPair={pair}
        busy={pairingBusy}
        pendingMac={pendingMac}
        onCancel={() => setPendingMac(null)}
      />
    </div>
  )
}

function PairedMacRow({ peer, onSaved }: { peer: PeerMac; onSaved: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [removing, setRemoving] = useState(false)

  async function forget() {
    if (removing) return
    setRemoving(true)
    try {
      await api.forgetPeer(peer.id)
      setConfirming(false)
      onSaved()
    } catch (err) {
      reportError(err, 'Failed to forget the Mac')
    } finally {
      setRemoving(false)
    }
  }

  const statusText = peer.online ? 'connected · now' : 'offline'

  return (
    <div className={`${BLOCK} flex flex-col gap-2.5`}>
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-[13.5px] font-semibold text-text-bright">{peer.name}</span>
          <span className={`${CAPTION}`}>
            paired {shortDate(peer.pairedAt)} · {statusText}
          </span>
        </div>
        {confirming ? null : (
          <Button variant="ghost" size="sm" onClick={() => setConfirming(true)}>
            Forget
          </Button>
        )}
      </div>
      {confirming && (
        <div className="flex items-center gap-3 rounded-[10px] border border-[rgba(150,205,255,.14)] bg-[rgba(4,8,16,.35)] px-3 py-2.5">
          <span className="min-w-0 flex-1 text-[12px] leading-[1.5] text-[rgba(220,235,255,.9)] [text-wrap:pretty]">
            Forget {peer.name}? It will need to pair again.
          </span>
          <Button variant="ghost" size="sm" disabled={removing} onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" disabled={removing} onClick={() => void forget()}>
            Forget
          </Button>
        </div>
      )}
    </div>
  )
}

function PeeringCodeSection({
  code,
  loading,
  onGenerate,
}: {
  code: { code: string; expiresAt: number } | null
  loading: boolean
  onGenerate: () => Promise<void>
}) {
  const ticking = code !== null
  const now = useNow(ticking)

  const timeLeft = code ? Math.max(0, code.expiresAt - now) : 0
  const expired = timeLeft === 0 && code !== null
  const minutesLeft = Math.ceil(timeLeft / 60000)

  if (!code || expired) {
    return (
      <div className={`${BLOCK} flex flex-col items-start gap-2`}>
        {expired && (
          <>
            <span className="font-mono text-[10px] tracking-[0.18em] text-[rgba(160,190,225,.6)]">CODE EXPIRED</span>
            <span className={`text-[12.5px] ${MUTED}`}>expired · make a new code to pair</span>
          </>
        )}
        <Button variant="primary" size="sm" disabled={loading} onClick={() => void onGenerate()}>
          {loading ? 'Generating…' : 'Generate code'}
        </Button>
      </div>
    )
  }

  return (
    <div className={`${BLOCK} flex flex-col gap-2`}>
      <div className="text-[13px] font-semibold text-text-bright">Share with another Mac</div>
      <Input
        readOnly
        value={code.code}
        onClick={(e) => {
          e.currentTarget.select()
          void navigator.clipboard.writeText(code.code)
        }}
        className="w-full font-mono text-[12px]"
      />
      <div className={`flex items-center justify-between ${CAPTION}`}>
        <span>expires in {minutesLeft}m · click to copy</span>
      </div>
    </div>
  )
}

function PairingInput({
  value,
  onChange,
  onPair,
  busy,
  pendingMac,
  onCancel,
}: {
  value: string
  onChange: (v: string) => void
  onPair: () => Promise<void>
  busy: boolean
  pendingMac: { mac: string; name: string; code: string } | null
  onCancel: () => void
}) {
  if (pendingMac) {
    return (
      <div className={`${BLOCK} flex flex-col gap-2`}>
        <div className="text-[13px] font-semibold text-text-bright">Type this code on {pendingMac.name}</div>
        <div className="rounded-[10px] bg-[rgba(4,8,16,.35)] px-4 py-3 font-mono text-[18px] font-semibold tracking-widest text-text-bright">
          {pendingMac.code}
        </div>
        <div className="flex items-center gap-2">
          <span className={`flex-1 text-[12px] ${MUTED}`}>Waiting for confirmation…</span>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className={`${BLOCK} flex flex-col gap-2`}>
      <div className="text-[12.5px] text-[rgba(160,190,225,.7)] [text-wrap:pretty]">
        Paste a code from another Mac running Orbital
      </div>
      <div className="flex gap-2">
        <Input
          placeholder="Paste code here"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void onPair()
          }}
          className="flex-1"
        />
        <Button variant="primary" size="sm" disabled={busy || !value.trim()} onClick={() => void onPair()}>
          {busy ? 'Pairing…' : 'Pair'}
        </Button>
      </div>
    </div>
  )
}
