import { useContext, useEffect, useRef, useState } from 'react'
import { promptWithFiles } from '../../lib/attachedFiles'
import { COMPACTING_PLACEHOLDER } from '../../lib/compaction'
import { isReadOnly } from '../../lib/types'
import { Composer, ComposerLockContext } from '../../panels/Composer'
import { StopDialog } from '../../panels/StopDialog'
import { useAttachments } from '../../panels/useAttachments'
import { useOrbital, type SentAttachment } from '../../store/store'
import {
  DESKTOP_COMMAND_LINE, PHOTO_FAILED_LINE, composerPlaceholder, footerMode, humanizeError, isDesktopCommand, phoneError,
  reopenHint,
} from '../composer'
import { pickPhoto, type PhotoSource } from '../platform/photo'
import { isMacAsleep, useMobile } from '../state'

/** The error line's word when the camera permission was refused (spec § 6.2). */
const CAMERA_DENIED = "Orbital can't use the camera — allow it in Android settings."

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
  const offline = useMobile(isMacAsleep)
  const macName = useMobile((s) => s.macName)
  const mode = footerMode({ offline, macName, readOnly: session ? isReadOnly(session) : true })

  if (mode.kind === 'asleep') {
    // 9p "MAC OFFLINE · LOCKED": the well's place, dashed and inert, and the
    // controls under it dimmed with nothing to act on.
    return (
      <div className="border-t border-[rgba(150,205,255,.1)] bg-[rgba(6,10,20,.94)] px-3 pb-1 pt-2.5">
        <div className="flex items-center gap-2.5 rounded-[10px] border border-dashed border-[rgba(150,205,255,.22)] px-3 py-3 text-[13px] text-text-muted">
          <LockIcon />
          <span className="min-w-0 truncate">{mode.macName} is asleep — read only</span>
        </div>
        <Controls inert />
      </div>
    )
  }
  if (mode.kind === 'terminal') {
    // 9p "TERMINAL SESSION · NO COMPOSER".
    return (
      <div className="border-t border-panel-border px-4 py-3 text-center font-mono text-[11px] text-text-muted">
        Started in Terminal — reply there.
      </div>
    )
  }
  return <LiveComposer id={id} />
}

/**
 * A photo pick under way. Module-wide, not per composer: the system picker is
 * one, and a composer remounted while it is open must not start another.
 */
let photoInFlight = false

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
  const answers = useOrbital((s) => (pending?.kind === 'question' ? s.decisionAnswers[pending.id] : undefined))
  const limitWait = useOrbital((s) => s.sessions[id]?.limitWait ?? null)
  const ready = useMobile((s) => s.ready)
  const macName = useMobile((s) => s.macName)
  // A gate's Reopen, asked from the card (canvas 10b, third phone).
  const intent = useMobile((s) => (s.composerIntent?.sessionId === id ? s.composerIntent : null))
  const clearComposerIntent = useMobile((s) => s.clearComposerIntent)
  const reopenStep = intent?.intent.kind === 'reopen' ? intent.intent.step : null
  const attachments = useAttachments(id)
  const [stopOpen, setStopOpen] = useState(false)
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

  const { text: placeholder, answering } = composerPlaceholder({
    pending,
    answers,
    ended: status === 'ended',
    reopenStep,
    limitWait,
  })

  // A send waits for its uploads: the well is taken only once every chip has landed.
  const canSend = ready && !locked && !attachments.uploading && Boolean(draft.trim() || attachments.armed)

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

  function attachPhoto(source: PhotoSource) {
    // One picker at a time: the plugin keeps one saved call, and a second tap
    // while it is open would be a second pick racing the first.
    if (photoInFlight) return
    photoInFlight = true
    setError(null)
    pickPhoto(source)
      .then((picked) => {
        // Left the session, or the well, while the picker was open: the photo goes nowhere.
        if (!mounted.current || useMobile.getState().sessionId !== id) return
        if (picked === 'cancelled') return
        if (picked === 'denied') {
          setError(CAMERA_DENIED)
          return
        }
        attachments.accept([picked.file], source, undefined, picked.original)
      })
      .catch((err: unknown) => {
        console.warn('[mobile] could not take the photo', err)
        if (mounted.current) setError(PHOTO_FAILED_LINE)
      })
      .finally(() => {
        photoInFlight = false
      })
  }

  return (
    <div className="border-t border-[rgba(150,205,255,.1)] bg-[rgba(6,10,20,.94)] px-3 pb-1 pt-2.5">
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
      />
      {error && (
        <div role="alert" className="mt-2 px-1 font-mono text-[11px] text-[var(--state-input)]">
          {error}
        </div>
      )}
      <Controls
        hint={reopenStep !== null ? reopenHint(reopenStep) : undefined}
        photosDisabled={!ready || locked}
        onPhoto={attachPhoto}
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
        photosDisabled: boolean
        onPhoto(source: PhotoSource): void
        onStop?: () => void
        onSend(): void
        sendDisabled: boolean
      },
) {
  const live = props.inert ? null : props
  const iconButton = 'flex h-11 w-11 items-center justify-center rounded-[12px] text-[rgba(200,220,245,.8)] disabled:opacity-40'
  return (
    <div className={['mt-1 flex items-center gap-0.5', live ? '' : 'opacity-40'].join(' ')}>
      {live?.hint ? (
        // Canvas 10b, third phone: the hint takes the photos' place.
        <span className="min-w-0 flex-1 truncate pl-1.5 font-mono text-[10.5px] text-[rgba(160,190,225,.55)]">
          {live.hint}
        </span>
      ) : (
        <>
          <button
            type="button"
            aria-label="Take a photo"
            className={iconButton}
            disabled={!live || live.photosDisabled}
            onClick={() => live?.onPhoto('camera')}
          >
            <CameraIcon />
          </button>
          <button
            type="button"
            aria-label="Choose from gallery"
            className={iconButton}
            disabled={!live || live.photosDisabled}
            onClick={() => live?.onPhoto('gallery')}
          >
            <GalleryIcon />
          </button>
          <span aria-hidden className="flex-1" />
        </>
      )}
      {live?.onStop && (
        <button
          type="button"
          aria-label="Stop"
          onClick={live.onStop}
          className="flex h-11 items-center gap-2 rounded-[12px] border border-[oklch(80%_.13_60/.5)] px-4 text-[14px] font-semibold text-[oklch(85%_.12_60)]"
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
        className="ml-1.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[oklch(85%_.12_205)] text-[18px] font-bold text-[#03111a] shadow-[0_0_18px_oklch(85%_.12_205/.4)] disabled:opacity-35 disabled:shadow-none"
      >
        ↑
      </button>
    </div>
  )
}

// Line glyphs for the controls and the locked line; the fidelity pass owns their drawing.
function CameraIcon() {
  return (
    <svg aria-hidden width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      <path d="M4 8h3l1.5-2h7L17 8h3v11H4z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  )
}

function GalleryIcon() {
  return (
    <svg aria-hidden width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="M4 17l5-4 4 3 3-2 4 3" />
    </svg>
  )
}

function LockIcon() {
  return (
    <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" className="shrink-0">
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  )
}
