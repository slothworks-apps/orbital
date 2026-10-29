import { useContext, useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { promptWithFiles } from '../../lib/attachedFiles'
import { COMPACTING_PLACEHOLDER } from '../../lib/compaction'
import { isReadOnly } from '../../lib/types'
import { Composer, ComposerLockContext, type ComposerControl } from '../../panels/Composer'
import { StopDialog } from '../../panels/StopDialog'
import { useAttachments } from '../../panels/useAttachments'
import { questionComposerTarget, useOrbital, type SentAttachment } from '../../store/store'
import { refreshQuestionSetting } from '../questionSetting'
import {
  DESKTOP_COMMAND_LINE, composerPlaceholder, footerMode, humanizeError, isDesktopCommand, phoneError,
  reopenHint,
} from '../composer'
import type { PhotoSource } from '../platform/photo'
import { useMobile } from '../state'
import { useSessionAsleep, useSessionDeviceName, useSessionReady, useSessionRefusedLine } from '../useDevice'
import { PhotoButtons, SlashButton, attachPhoto } from './ComposerButtons'

/**
 * The session screen's footer (spec 2026-10-02-mobile-app-design § 6.1;
 * canvas 9b, 9p): the shared composer's well with the phone's controls on a
 * row of their own under it, or one of the two lines that stand in for the
 * well — the Mac asleep, or a session the terminal owns. The desktop's mount
 * is `DetailPanel`; this is its phone subset, with no IDE slot, rewind, drop
 * target or tooltips.
 */
export function SessionComposer({ id }: { id: string }) {
  const session = useOrbital((s) => s.sessions[id])
  // Its own device asleep or too old; the others' sessions take answers as usual (canvas 50j).
  const offline = useSessionAsleep(id)
  const refused = useSessionRefusedLine(id)
  const macName = useSessionDeviceName(id)
  const mode = footerMode({ offline, macName, readOnly: session ? isReadOnly(session) : true })

  if (mode.kind === 'asleep') {
    // 9p "MAC OFFLINE · LOCKED": the well's place, dashed and inert, and the
    // controls under it dimmed with nothing to act on.
    return (
      <div className="border-t border-line/10 bg-shade/94 px-3 pb-1 pt-2.5">
        <div className="flex items-center gap-2.5 rounded-[10px] border border-dashed border-line/22 px-3 py-3 fs-13 text-ink-900/70">
          <LockIcon />
          <span className="min-w-0 truncate">{refused ?? `${mode.macName} is asleep — read only`}</span>
        </div>
        <Controls inert />
      </div>
    )
  }
  if (mode.kind === 'terminal') {
    // 9p "TERMINAL SESSION · NO COMPOSER".
    return (
      <div className="border-t border-line/14 px-4 py-3 text-center font-mono fs-11 text-ink-900/70">
        Started in Terminal — reply there.
      </div>
    )
  }
  return <LiveComposer id={id} />
}

function LiveComposer({ id }: { id: string }) {
  const status = useOrbital((s) => s.sessions[id]?.status)
  // 26c: an Orbital session compacting its context takes no message (as `DetailPanel`).
  const compacting = useOrbital((s) => s.sessions[id]?.source === 'web' && s.sessions[id]?.compacting != null)
  // A composer locked from outside (`ComposerLockContext`; the website's
  // phone demo) takes no photo either: a photo alone would arm Send.
  const lockedFromOutside = useContext(ComposerLockContext) !== null
  const locked = compacting || lockedFromOutside
  const draft = useOrbital((s) => s.composerDrafts[id] ?? '')
  const setComposerDraft = useOrbital((s) => s.setComposerDraft)
  const sendPrompt = useOrbital((s) => s.sendPrompt)
  const pending = useOrbital((s) => s.pendingDecisions[id])
  // Where the pending question card is — a question, or its review (spec
  // 2026-10-21-question-card-go-back-design § Composer).
  const target = useOrbital(useShallow((s) => questionComposerTarget(s, id)))
  const reviewHeld = target?.kind === 'review'
  const limitWait = useOrbital((s) => s.sessions[id]?.limitWait ?? null)
  const ready = useSessionReady(id)
  const macName = useSessionDeviceName(id)
  // A gate's Reopen, asked from the card (canvas 10b, third phone).
  const intent = useMobile((s) => (s.composerIntent?.sessionId === id ? s.composerIntent : null))
  const clearComposerIntent = useMobile((s) => s.clearComposerIntent)
  const reopenStep = intent?.intent.kind === 'reopen' ? intent.intent.step : null
  const attachments = useAttachments(id)
  const [stopOpen, setStopOpen] = useState(false)
  const composer = useRef<ComposerControl>(null)
  // The phone has no toast surface: what this client's own requests raise (a
  // send, an answer, a verdict on a card) and what its photos raise is said on
  // a line under the well. The Mac's error records (`source: 'log'`) are not.
  const [error, setError] = useState<string | null>(null)
  const raised = useOrbital((s) => phoneError(s.toast))
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // Taken off the store as it lands, so the next failure — even with the same words — lands again.
  useEffect(() => {
    if (raised === null) return
    setError(humanizeError(raised, macName))
    useOrbital.setState({ toast: null })
  }, [raised, macName])

  // Every request focuses the field once, also a second Reopen of the same step.
  const intentSeq = intent?.seq
  useEffect(() => {
    if (intentSeq === undefined) return
    document.querySelector<HTMLElement>('[data-composer-field]')?.focus()
  }, [intentSeq])

  // A question card reads the Mac's setting as it comes up, so a change made
  // on the Mac reaches the next card here (canvas 9h PHONE).
  const questionId = pending?.kind === 'question' ? pending.id : null
  useEffect(() => {
    if (questionId) refreshQuestionSetting()
  }, [questionId])

  const { text: placeholder, answering } = composerPlaceholder({
    pending,
    target,
    ended: status === 'ended',
    reopenStep,
    limitWait,
  })

  // A send waits for its uploads: the well is taken only once every chip has landed.
  // During the review ↑ stays disabled until the answers are sent (canvas 9i C).
  const canSend =
    ready && !locked && !reviewHeld && !attachments.uploading && Boolean(draft.trim() || attachments.armed)

  function send(text: string, images?: readonly SentAttachment[]) {
    void sendPrompt(id, text, images)
  }

  function handleSend() {
    if (!canSend) return
    const text = draft.trim()
    setError(null)
    if (isDesktopCommand(text) && !attachments.armed) {
      setComposerDraft(id, '')
      setError(DESKTOP_COMMAND_LINE)
      return
    }
    setComposerDraft(id, '')
    // What the reopened step was waiting for has been written.
    clearComposerIntent()
    if (!attachments.armed) {
      send(text)
      return
    }
    // As `DetailPanel.handleSend`: images ride as blocks, files by path, and
    // a well whose every upload failed still sends its text.
    void attachments.takeForSend().then(({ images, files }) => {
      const outgoing = promptWithFiles(text, files.map((file) => file.path))
      if (images.length > 0) send(outgoing, images)
      else if (outgoing) send(outgoing)
    })
  }

  // Left the session, or the well, while the picker was open: the photo goes nowhere.
  const stillHere = () => mounted.current && useMobile.getState().sessionId === id

  return (
    <div className="border-t border-line/10 bg-shade/94 px-3 pb-1 pt-2.5">
      <Composer
        sessionKey={{ session: id }}
        value={draft}
        onChange={(text) => setComposerDraft(id, text)}
        // The keyboard's return key makes a line; only Send sends (§ 6.1).
        enter="newline"
        placement="above"
        variant="panel"
        // No chords to name on a phone, and errors have their own line: the
        // hint row stays empty and the phone's CSS drops it.
        hint=""
        placeholder={compacting ? COMPACTING_PLACEHOLDER : placeholder}
        answering={answering}
        locked={locked}
        attachments={attachments}
        aria-label="Prompt"
        control={composer}
      />
      {error && (
        <div role="alert" className="mt-2 px-1 font-mono fs-11 text-[var(--state-input)]">
          {error}
        </div>
      )}
      <Controls
        hint={reopenStep !== null ? reopenHint(reopenStep) : undefined}
        toolsDisabled={!ready || locked}
        onPhoto={(source) => attachPhoto(source, attachments, stillHere, setError)}
        onSlash={() => composer.current?.startCommand()}
        onStop={status === 'working' ? () => setStopOpen(true) : undefined}
        onSend={handleSend}
        sendDisabled={!canSend}
      />
      <StopDialog open={stopOpen} sessionId={id} onClose={() => setStopOpen(false)} />
    </div>
  )
}

/**
 * 9b's controls, on a row under the well: camera and gallery as plain line
 * icons at the left, Stop and Send at the right. `inert` is 9p's locked row:
 * every control dimmed and disabled, and no Stop.
 */
function Controls(
  props:
    | { inert: true }
    | {
        inert?: false
        /** A line in the photos' place: where a reopened step's message goes (canvas 10b, third phone). */
        hint?: string
        toolsDisabled: boolean
        onPhoto(source: PhotoSource): void
        /** Starts a slash command: the slash sits on the symbols page of a phone keyboard. */
        onSlash(): void
        onStop?: () => void
        onSend(): void
        sendDisabled: boolean
      },
) {
  const live = props.inert ? null : props
  return (
    <div className={['mt-1 flex items-center gap-0.5', live ? '' : 'opacity-40'].join(' ')}>
      {live?.hint ? (
        // Canvas 10b, third phone: the hint takes the photos' place.
        <span className="min-w-0 flex-1 truncate pl-1.5 font-mono fs-10.5 text-ink-900/55">
          {live.hint}
        </span>
      ) : (
        <>
          <PhotoButtons disabled={!live || live.toolsDisabled} onPhoto={(source) => live?.onPhoto(source)} />
          <SlashButton disabled={!live || live.toolsDisabled} onSlash={() => live?.onSlash()} />
          <span aria-hidden className="flex-1" />
        </>
      )}
      {live?.onStop && (
        <button
          type="button"
          aria-label="Stop"
          onClick={live.onStop}
          className="flex h-11 items-center gap-2 rounded-[12px] border border-[oklch(80%_.13_60/.5)] px-4 fs-14 font-semibold text-warning"
        >
          <span aria-hidden className="block h-[9px] w-[9px] rounded-[1.5px] bg-current" />
          Stop
        </button>
      )}
      <button
        type="button"
        aria-label="Send"
        onClick={() => live?.onSend()}
        disabled={!live || live.sendDisabled}
        // A round cyan disc that glows, faded while there is nothing to send (9b).
        className="ml-1.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent fs-18 font-bold text-space-deep shadow-[0_0_18px_color-mix(in_oklab,var(--color-accent)_40%,transparent)] disabled:opacity-35 disabled:shadow-none"
      >
        ↑
      </button>
    </div>
  )
}

// The locked line's glyph; the fidelity pass owns its drawing.
function LockIcon() {
  return (
    <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" className="shrink-0">
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  )
}
