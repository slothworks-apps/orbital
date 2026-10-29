import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import type { PendingPair } from '@orbital/shared/remote/ceremony'
import { kindTile, whereLine } from '../lib/joinRequest'
import { GROUP_FULL, JOIN_REACH, attemptsLine, joinSentence, managerWords } from '@orbital/shared/remote/groupWords'
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
 * shows; the group compares. Accept leads to the joined sheet; only Reject
 * rejects. The backdrop and the back button put the sheet away while the
 * request stays open, and Settings → Devices brings it back (`useJoinSheet`).
 */
export function JoinRequestSheet() {
  const pending = useMobile((s) => s.pendingPair)
  const ownCode = useMobile((s) => s.ownCode)
  const setAside = useJoinSheet((s) => s.setAside)
  // The request stays drawn while the sheet sinks after the group drops it.
  const shown = useRef<PendingPair | null>(null)
  if (pending) shown.current = pending
  const [joined, setJoined] = useState<{ name: string; done: string | null } | null>(null)
  /** The device an Accept could not add, the group having no room (canvas 50o's words). */
  const [full, setFull] = useState<string | null>(null)

  // A new request replaces a joined or full sheet still up. A request gone
  // takes its put-away mark with it, so the same device asking again is shown.
  useEffect(() => {
    if (pending) {
      setJoined(null)
      setFull(null)
    } else useJoinSheet.setState({ setAside: null })
  }, [pending?.phone]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <SheetPresence>
      {joined !== null ? (
        <JoinedSheet name={joined.name} done={joined.done} onDone={() => setJoined(null)} />
      ) : full !== null ? (
        <FullSheet name={full} onDone={() => setFull(null)} />
      ) : (
        pending && pending.phone !== setAside && (
          <RequestSheet
            key={pending.phone}
            request={pending}
            expiresAt={ownCode?.expiresAt ?? null}
            onJoined={setJoined}
            onFull={setFull}
          />
        )
      )}
    </SheetPresence>
  )
}

/**
 * The join request whose sheet the user put away by the backdrop or the back
 * button, by the asking device's id: the request stays open, and Settings →
 * Devices offers it again until it is answered or gone.
 */
export const useJoinSheet = create<{ setAside: string | null }>(() => ({ setAside: null }))

function RequestSheet({
  request,
  expiresAt,
  onJoined,
  onFull,
}: {
  request: PendingPair
  expiresAt: number | null
  onJoined: (joined: { name: string; done: string | null }) => void
  onFull: (name: string) => void
}) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [relayFailed, setRelayFailed] = useState(false)
  /** Set by a wrong code: how many more the group takes before it rejects. */
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null)
  const complete = code.length === PAIRING_CODE_LENGTH

  // The group says nothing when the code runs out; it drops the request when next asked.
  useEffect(() => {
    if (expiresAt === null) return
    const timer = setTimeout(refreshGroupState, Math.max(0, expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [expiresAt])

  const answer = async (accept: boolean) => {
    const group = groupRef.current?.group
    if (!group || busy || (accept && !complete)) return
    setBusy(true)
    setRelayFailed(false)
    try {
      const res = accept ? await group.confirmPairing(true, request.phone, code) : await group.confirmPairing(false, request.phone)
      if ('ok' in res) {
        if (accept) onJoined({ name: request.name, done: managerWords(request.manager, request.name).done })
      } else if (res.error === 'relay_error') {
        setRelayFailed(true)
      } else if (res.error === 'code_mismatch') {
        // The boxes clear and one quiet line counts what is left.
        setCode('')
        setAttemptsLeft(res.attemptsLeft)
      } else if (res.error === 'group_full') {
        // The group dropped the request; the answer takes the sheet's place, as 50o does on the desktop.
        onFull(request.name)
      }
      // `code_rejected` and `no_pending`: the group dropped the request, and the sheet goes with it.
    } finally {
      setBusy(false)
      refreshGroupState()
    }
  }

  const tile = kindTile(request.kind)
  // No clock while the user types (canvas 50i): the header says only whether the group is new.
  const manager = managerWords(request.manager, request.name)
  const line = relayFailed
    ? "The relay didn't answer. Try again."
    : attemptsLeft !== null
      ? attemptsLine(attemptsLeft)
      : whereLine(request.kind, request.name)

  return (
    <BottomSheet
      label={joinSentence(request)}
      onDismiss={() => useJoinSheet.setState({ setAside: request.phone })}
      variant="device"
    >
      <div className="flex flex-col items-center gap-[13px] pb-2 text-center">
        <div className="font-mono fs-9.5 tracking-[0.2em] text-[rgba(160,190,225,.55)]">{manager.eyebrow}</div>
        {/* Canvas 50c "KIND, THREE TIMES": the glyph, the kind word and its meaning, then the sentence. */}
        <div className="flex w-full items-center gap-3.5 rounded-[14px] border border-[rgba(150,205,255,.26)] bg-[rgba(4,8,16,.6)] px-3.5 py-3 text-left">
          <span className="grid h-[52px] w-[52px] shrink-0 place-items-center rounded-[12px] border border-[rgba(150,205,255,.2)] text-text-bright">
            <KindGlyph kind={request.kind} scale={2.6} untitled />
          </span>
          <span className="flex min-w-0 flex-col gap-1">
            <span className="font-mono fs-15 tracking-[0.2em]">{tile.word}</span>
            <span className="fs-12.5 leading-[1.4] text-[rgba(160,190,225,.78)]">{tile.note}</span>
          </span>
        </div>
        <h2 className="fs-19 font-bold leading-[1.3] [text-wrap:balance]">{joinSentence(request)}</h2>
        <p className="fs-13 leading-[1.5] text-[rgba(200,214,235,.82)] [text-wrap:pretty]">
          {JOIN_REACH}
        </p>
        {/* Canvas 50i: a boxed line says who will manage the group, a role the pairing makes permanent. */}
        {manager.line && (
          <p className="box-border w-full rounded-[12px] border border-[rgba(150,205,255,.16)] px-3.5 py-2.5 text-left fs-13 leading-[1.5] text-text-bright [text-wrap:pretty]">
            {manager.line}
          </p>
        )}
        {/* Never disabled while an answer is in flight: after a wrong code the user types straight on. */}
        <PairingCodeInput size="sm" value={code} onChange={setCode} onSubmit={() => void answer(true)} />
        <div className="h-fit min-h-[18px] font-mono fs-11 text-[rgba(160,190,225,.75)]">{line}</div>
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

/** After Accept (canvas 50i `p2Done`): the device is in, and who adds the next one. */
function JoinedSheet({ name, done, onDone }: { name: string; done: string | null; onDone: () => void }) {
  return (
    <BottomSheet label={`${name} joined`} onDismiss={onDone} variant="device">
      <div className="flex flex-col items-center gap-3 pb-2 pt-3 text-center">
        <span
          aria-hidden
          className="grid h-[52px] w-[52px] place-items-center rounded-full border-2 border-[oklch(85%_.12_205)] fs-20 text-[oklch(85%_.12_205)]"
        >
          ✓
        </span>
        <h2 className="fs-18 font-bold">{name} joined</h2>
        <p className="fs-13 leading-[1.5] text-[rgba(160,190,225,.72)]">
          {done ?? 'The other devices link to it on their own.'}
        </p>
        <SecondaryButton onClick={onDone}>Done</SecondaryButton>
      </div>
    </BottomSheet>
  )
}

/**
 * An Accept the group had no room for: the desktop's 50o answer in the
 * sheet's place, in its words. A phone adds no one, so only a group that
 * says so brings it here.
 */
function FullSheet({ name, onDone }: { name: string; onDone: () => void }) {
  return (
    <BottomSheet label={GROUP_FULL} onDismiss={onDone} variant="device">
      <div className="flex flex-col items-center gap-3 pb-2 pt-3 text-center">
        <h2 className="fs-18 font-bold [text-wrap:balance]">{GROUP_FULL}</h2>
        <p className="fs-13 leading-[1.5] text-[rgba(160,190,225,.72)] [text-wrap:pretty]">
          {name} wasn’t added and keeps running on its own.
        </p>
        <SecondaryButton onClick={onDone}>OK</SecondaryButton>
      </div>
    </BottomSheet>
  )
}
