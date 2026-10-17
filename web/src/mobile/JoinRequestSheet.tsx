import { useEffect, useRef, useState } from 'react'
import type { PendingPair } from '@orbital/shared/remote/ceremony'
import { codeLeft } from '../lib/remote'
import { attemptsLine, joinSentence, kindTile, whereLine } from '../lib/joinRequest'
import { useNow } from '../lib/useNow'
import { KindGlyph } from '../ui/KindGlyph'
import { PAIRING_CODE_LENGTH, PairingCodeInput } from '../ui/PairingCodeInput'
import { refreshGroupState } from './connect'
import { useMobile } from './state'
import { groupRef } from './transport/groupRef'
import { BottomSheet, PrimaryButton, SecondaryButton, SheetPresence } from './ui'

/**
 * A device asking to join through this phone's code (canvas 50i, the phone
 * as member; 50c's tile, sentence and six boxes): up wherever the user is,
 * while the group holds the request. The user types the code the device
 * shows; the group compares. Accept leads to the joined sheet; Reject, the
 * backdrop and the back button reject, as Esc does on the desktop.
 */
export function JoinRequestSheet() {
  const pending = useMobile((s) => s.pendingPair)
  const ownCode = useMobile((s) => s.ownCode)
  // The request stays drawn while the sheet sinks after the group drops it.
  const shown = useRef<PendingPair | null>(null)
  if (pending) shown.current = pending
  const [joined, setJoined] = useState<string | null>(null)

  // A new request replaces a joined sheet still up.
  useEffect(() => {
    if (pending) setJoined(null)
  }, [pending?.phone]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <SheetPresence>
      {joined !== null ? (
        <JoinedSheet name={joined} onDone={() => setJoined(null)} />
      ) : (
        pending && (
          <RequestSheet key={pending.phone} request={pending} expiresAt={ownCode?.expiresAt ?? null} onJoined={setJoined} />
        )
      )}
    </SheetPresence>
  )
}

function RequestSheet({
  request,
  expiresAt,
  onJoined,
}: {
  request: PendingPair
  expiresAt: number | null
  onJoined: (name: string) => void
}) {
  const now = useNow(true)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [relayFailed, setRelayFailed] = useState(false)
  /** Set by a wrong code: how many more the group takes before it rejects. */
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null)
  const complete = code.length === PAIRING_CODE_LENGTH
  const expired = expiresAt !== null && now >= expiresAt

  // The group says nothing when the code runs out; it drops the request when next asked.
  useEffect(() => {
    if (expired) refreshGroupState()
  }, [expired])

  const answer = async (accept: boolean) => {
    const group = groupRef.current?.group
    if (!group || busy || (accept && !complete)) return
    setBusy(true)
    setRelayFailed(false)
    try {
      const res = accept ? await group.confirmPairing(true, request.phone, code) : await group.confirmPairing(false, request.phone)
      if ('ok' in res) {
        if (accept) onJoined(request.name)
      } else if (res.error === 'relay_error') {
        setRelayFailed(true)
      } else if (res.error === 'code_mismatch') {
        // The boxes clear and one quiet line counts what is left.
        setCode('')
        setAttemptsLeft(res.attemptsLeft)
      }
      // `code_rejected` and `no_pending`: the group dropped the request, and the sheet goes with it.
    } finally {
      setBusy(false)
      refreshGroupState()
    }
  }

  const tile = kindTile(request.kind)
  const eyebrow = expiresAt !== null ? `JOIN REQUEST · EXPIRES IN ${codeLeft(expiresAt, now).label}` : 'JOIN REQUEST'
  const line = relayFailed
    ? "The relay didn't answer. Try again."
    : attemptsLeft !== null
      ? attemptsLine(attemptsLeft)
      : whereLine(request.kind, request.name)

  return (
    <BottomSheet label={joinSentence(request)} onDismiss={() => void answer(false)} variant="device">
      <div className="flex flex-col items-center gap-[13px] pb-2 text-center">
        <div className="font-mono text-[9.5px] tracking-[0.2em] text-[rgba(160,190,225,.55)]">{eyebrow}</div>
        {/* Canvas 50c "KIND, THREE TIMES": the glyph, the kind word and its meaning, then the sentence. */}
        <div className="flex w-full items-center gap-3.5 rounded-[14px] border border-[rgba(150,205,255,.26)] bg-[rgba(4,8,16,.6)] px-3.5 py-3 text-left">
          <span className="grid h-[52px] w-[52px] shrink-0 place-items-center rounded-[12px] border border-[rgba(150,205,255,.2)] text-text-bright">
            <KindGlyph kind={request.kind} scale={2.6} untitled />
          </span>
          <span className="flex min-w-0 flex-col gap-1">
            <span className="font-mono text-[15px] tracking-[0.2em]">{tile.word}</span>
            <span className="text-[12.5px] leading-[1.4] text-[rgba(160,190,225,.78)]">{tile.note}</span>
          </span>
        </div>
        <h2 className="text-[19px] font-bold leading-[1.3] [text-wrap:balance]">{joinSentence(request)}</h2>
        <p className="text-[13px] leading-[1.5] text-[rgba(200,214,235,.82)] [text-wrap:pretty]">
          Once in, it sees and drives every session on every device in this group.
        </p>
        {/* Never disabled while an answer is in flight: after a wrong code the user types straight on. */}
        <PairingCodeInput size="sm" value={code} onChange={setCode} onSubmit={() => void answer(true)} />
        <div className="min-h-[18px] font-mono text-[11px] text-[rgba(160,190,225,.75)]">{line}</div>
        <div className="grid w-full grid-cols-2 gap-2.5">
          <SecondaryButton disabled={busy} onClick={() => void answer(false)}>
            Reject
          </SecondaryButton>
          <PrimaryButton variant="sheet" disabled={busy || !complete} onClick={() => void answer(true)}>
            Accept
          </PrimaryButton>
        </div>
      </div>
    </BottomSheet>
  )
}

/** After Accept (canvas 50i `p2Done`): the device is in, and the rest link to it without the user. */
function JoinedSheet({ name, onDone }: { name: string; onDone: () => void }) {
  return (
    <BottomSheet label={`${name} joined`} onDismiss={onDone} variant="device">
      <div className="flex flex-col items-center gap-3 pb-2 pt-3 text-center">
        <span
          aria-hidden
          className="grid h-[52px] w-[52px] place-items-center rounded-full border-2 border-[oklch(85%_.12_205)] text-[20px] text-[oklch(85%_.12_205)]"
        >
          ✓
        </span>
        <h2 className="text-[18px] font-bold">{name} joined</h2>
        <p className="text-[13px] leading-[1.5] text-[rgba(160,190,225,.72)]">The other devices link to it on their own.</p>
        <SecondaryButton onClick={onDone}>Done</SecondaryButton>
      </div>
    </BottomSheet>
  )
}
