/**
 * Composer attachment facts and copy (spec: 2026-09-20-composer-design
 * § Image intake; canvas 9c/9d/9e).
 *
 * Everything here is pure, and everything here MIRRORS A SERVER FACT: the
 * media-type whitelist is `server/src/images/store.ts`'s, the byte ceiling is
 * `ATTACHMENT_MAX_BYTES` in `server/src/api/routes.ts`. The client re-states
 * them so a file that the route would refuse is refused at intake instead —
 * with the measured fact in hand and no upload spent — and that is the only
 * reason for the duplication. If the server's list moves, this one moves with
 * it or the composer starts lying about what it will take.
 */

import { formatBytes } from './format'
import type { AttachmentSource, ImageRefEntry } from './types'

/**
 * The store's own whitelist. Not a second opinion — a refusal here must be a
 * refusal there, because the server's 415 is `putBytes` saying no.
 */
export const ATTACHMENT_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])

/**
 * The route's ceiling. Deviation from the canvas's 10 MB, and a deliberate
 * one: the Anthropic API caps an image source at roughly this, so a bigger
 * upload would fail a turn later inside the SDK (spec § Deviations). The
 * refusal copy names this number, so it is derived from here and never typed
 * out a second time.
 */
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024

/** Chips per composer (canvas 9e). The sixth hides the placeholder, never text. */
export const MAX_ATTACHMENTS = 6

/**
 * Failed retries after which the `retry` word goes away and the chip is only a
 * record you can remove (canvas 9d-B: "Orbital never asks three times").
 */
export const ATTACHMENT_RETRY_LIMIT = 2

/** How the ceiling reads in prose — one derivation, every caller. */
const CEILING = formatBytes(ATTACHMENT_MAX_BYTES)

/** The drop marker's sub-line (canvas 9c-1), with the ceiling above baked in. */
export const ATTACHMENT_TYPES_LINE = `png · jpg · gif · webp · up to ${CEILING} each`

/**
 * One file the composer would not even try to upload, and why. Both kinds
 * carry the measured fact the refusal line prints — a refusal that cannot name
 * what it measured is just a "no".
 */
export type Refusal =
  | { kind: 'too_large'; name: string; size: number }
  | { kind: 'not_image'; name: string; mediaType: string }

/**
 * The client pre-check (canvas 9d-C). Type first: a 99 MB PDF is refused for
 * being a PDF, because "mention the path instead" is the useful sentence and
 * "too large" would send the reader to shrink a file that would never be
 * accepted at any size.
 *
 * A typeless file — which is what a dropped FOLDER is — is not an image.
 */
export function precheckFile(file: File): Refusal | null {
  if (!ATTACHMENT_MEDIA_TYPES.has(file.type)) {
    return { kind: 'not_image', name: file.name, mediaType: file.type || 'unknown' }
  }
  if (file.size > ATTACHMENT_MAX_BYTES) {
    return { kind: 'too_large', name: file.name, size: file.size }
  }
  return null
}

/**
 * The refusal line's three parts (canvas 9d-C): a tracked label, the measured
 * fact in brighter ink, and one sentence. Rendered as one line replacing the
 * hint line in place.
 */
export interface RefusalNotice {
  label: string
  fact: string
  tail: string
}

/**
 * One notice for a whole gesture — refusals collapse, they never stack
 * (canvas 9d-C: "Drop five files where two are PDFs … one line says `2 files
 * weren't images`").
 *
 * A single refusal names the file and its fact. Several of one kind collapse
 * to a count, which is the only fact that stays true of all of them — summing
 * sizes would invent a number no file has. A mixed gesture collapses further
 * still, to the count alone: with two different reasons there is no shared
 * sentence left, and the label stops claiming one (judgement call — the canvas
 * shows the single-kind collapse only).
 */
export function refusalNotice(refusals: readonly Refusal[]): RefusalNotice | null {
  if (refusals.length === 0) return null

  if (refusals.length === 1) {
    const only = refusals[0]
    return only.kind === 'too_large'
      ? {
          label: 'TOO LARGE TO ATTACH',
          fact: only.name,
          tail: `${formatBytes(only.size)} over the ${CEILING} ceiling.`,
        }
      : {
          label: 'IMAGES ONLY',
          fact: only.mediaType,
          tail: '— mention the path instead.',
        }
  }

  const fact = `${refusals.length} files`
  const kinds = new Set(refusals.map((r) => r.kind))
  if (kinds.size === 1) {
    return refusals[0].kind === 'too_large'
      ? { label: 'TOO LARGE TO ATTACH', fact, tail: `over the ${CEILING} ceiling.` }
      : { label: 'IMAGES ONLY', fact, tail: "weren't images." }
  }
  return { label: "CAN'T ATTACH", fact, tail: "weren't images or were too large." }
}

/**
 * What the chip calls the file (canvas 9c-2). A pasted image has no honest
 * name — the clipboard's own `image.png` is the browser's invention, not the
 * user's — so it is called what it is. A nameless dropped file borrows the
 * same line for the same reason.
 */
export function attachmentName(file: File, source: AttachmentSource): string {
  if (source === 'clipboard' || !file.name) return 'Clipboard image'
  return file.name
}

/** Where one chip's upload stands. `exiting` is the ×'s fade, not a state of the file. */
export type AttachmentState = 'uploading' | 'uploaded' | 'failed'

/** One pending attachment, as the chip row and the send path both read it. */
export interface Attachment {
  /** Local id — the chips are a list of files, and two files can be identical. */
  id: string
  name: string
  source: AttachmentSource
  /** The local file's byte length; the stored entry's `bytes` once uploaded. */
  size: number
  /** `createObjectURL` of the local file — revoked on remove and on unmount. */
  previewUrl: string
  state: AttachmentState
  /** Present exactly when `state` is `uploaded`. */
  entry?: ImageRefEntry
  /** Percent, or null before the first tick / when there is nothing to show. */
  progress: number | null
  /** Failed attempts spent. Past `ATTACHMENT_RETRY_LIMIT` the word goes away. */
  retries: number
  /** True for the ×'s fade-out frame, before the chip is dropped from the list. */
  exiting?: boolean
}

/**
 * The chip's second line (canvas 9c/9d-A/9d-B). The percentage sits exactly
 * where the size normally does, which is why this is one function and not
 * three fragments in the markup.
 */
export function attachmentMeta(
  chip: Pick<Attachment, 'state' | 'size' | 'progress' | 'entry'>,
): string {
  if (chip.state === 'failed') return `${formatBytes(chip.size)} · didn't upload`
  if (chip.state === 'uploading') {
    const pct = chip.progress === null ? '' : ` ${chip.progress} %`
    return `${formatBytes(chip.size)} · uploading${pct}`
  }
  const entry = chip.entry
  const dims = entry?.w && entry?.h ? `${entry.w}×${entry.h} · ` : ''
  return `${dims}${formatBytes(entry?.bytes ?? chip.size)}`
}

/**
 * Whether a drag should arm the drop state (canvas 9c-1: "A drag carrying no
 * image files never arms the state — no flash, no 'can't drop that'").
 *
 * `items` is the authority, because during a drag it is the only thing that
 * reports a per-file media type; a dragged FOLDER reports an empty one, which
 * is what keeps a folder from arming. `types` is a fallback for a DataTransfer
 * without items, and a string drag (a tag rule being reordered) matches
 * neither.
 */
export function dragCarriesImages(dt: DataTransfer | null | undefined): boolean {
  if (!dt) return false
  const items = dt.items
  if (items && items.length > 0) {
    return Array.from(items).some(
      (item) => item.kind === 'file' && item.type.startsWith('image/'),
    )
  }
  return Array.from(dt.types ?? []).some((type) => type.startsWith('image/'))
}

/**
 * Every file a drop or paste carries, images and refusals alike — the refusals
 * included on purpose, because a file that cannot be attached still has to be
 * named by the refusal line.
 *
 * `files` first, `items` as a fallback: a screenshot on the clipboard reaches
 * `files` in every browser that matters, but a paste from an application that
 * only writes `items` entries (and some do) would otherwise look like a paste of
 * nothing at all.
 */
export function filesFrom(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return []
  const direct = dt.files ? Array.from(dt.files) : []
  if (direct.length > 0) return direct
  if (!dt.items) return []
  return Array.from(dt.items)
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
}
