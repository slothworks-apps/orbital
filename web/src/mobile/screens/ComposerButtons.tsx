import type { AttachmentsHandle } from '../../panels/useAttachments'
import { PHOTO_FAILED_LINE } from '../composer'
import { pickPhoto, type PhotoSource } from '../platform/photo'

/** The error line's word when the camera permission was refused (spec § 6.2). */
const CAMERA_DENIED = "Orbital can't use the camera — allow it in Android settings."

/**
 * A photo pick under way. Module-wide, not per composer: the system picker is
 * one, and a composer remounted while it is open must not start another.
 */
let photoInFlight = false

/**
 * One photo from the camera or the gallery into `attachments`' well, for a
 * session's composer and the New session screen's first prompt alike.
 * `stillHere` is asked once the picker closes: a well the user left while it
 * was open takes nothing. What went wrong comes back as a line for `onError`;
 * a new pick clears it with `null`.
 */
export function attachPhoto(
  source: PhotoSource,
  attachments: AttachmentsHandle,
  stillHere: () => boolean,
  onError: (line: string | null) => void,
) {
  // One picker at a time: the plugin keeps one saved call, and a second tap
  // while it is open would be a second pick racing the first.
  if (photoInFlight) return
  photoInFlight = true
  onError(null)
  pickPhoto(source)
    .then((picked) => {
      if (!stillHere()) return
      if (picked === 'cancelled') return
      if (picked === 'denied') {
        onError(CAMERA_DENIED)
        return
      }
      attachments.accept([picked.file], source, undefined, picked.original)
    })
    .catch((err: unknown) => {
      console.warn('[mobile] could not take the photo', err)
      if (stillHere()) onError(PHOTO_FAILED_LINE)
    })
    .finally(() => {
      photoInFlight = false
    })
}

const iconButton = 'flex h-11 w-11 items-center justify-center rounded-[12px] text-ink-500/80 disabled:opacity-40'

/** 9b's camera and gallery: plain line icons, side by side. */
export function PhotoButtons({ disabled, onPhoto }: { disabled: boolean; onPhoto(source: PhotoSource): void }) {
  return (
    <>
      <button type="button" aria-label="Take a photo" className={iconButton} disabled={disabled} onClick={() => onPhoto('camera')}>
        <CameraIcon />
      </button>
      <button type="button" aria-label="Choose from gallery" className={iconButton} disabled={disabled} onClick={() => onPhoto('gallery')}>
        <GalleryIcon />
      </button>
    </>
  )
}

/** Starts a slash command: the slash sits on the symbols page of a phone keyboard. */
export function SlashButton({ disabled, onSlash }: { disabled: boolean; onSlash(): void }) {
  return (
    <button
      type="button"
      aria-label="Commands and skills"
      className={iconButton}
      disabled={disabled}
      // Keeps the field focused, so the keyboard stays up and the caret where it was.
      onPointerDown={(e) => e.preventDefault()}
      onClick={onSlash}
    >
      <SlashIcon />
    </button>
  )
}

// Line glyphs; the fidelity pass owns their drawing.
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

// Drawn, not typed: a glyph sits taller than the line icons beside it; this spans the same rows.
function SlashIcon() {
  return (
    <svg aria-hidden width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M15 5L9 19" />
    </svg>
  )
}
