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
import type { AttachmentSource, FileEntry, ImageRefEntry } from './types'

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

/**
 * The route's ceiling for a file that rides by path (`FILE_ATTACHMENT_MAX_BYTES`
 * in `server/src/api/routes.ts`). Only an upload is held to it: a desktop drop
 * with a path behind it sends no bytes at all.
 */
export const FILE_ATTACHMENT_MAX_BYTES = 100 * 1024 * 1024

/** Chips per composer (canvas 9e). The sixth hides the placeholder, never text. */
export const MAX_ATTACHMENTS = 6

/**
 * Failed retries after which the `retry` word goes away and the chip is only a
 * record you can remove (canvas 9d-B: "Orbital never asks three times").
 */
export const ATTACHMENT_RETRY_LIMIT = 2

/** How the ceilings read in prose — one derivation, every caller. */
const CEILING = formatBytes(ATTACHMENT_MAX_BYTES)
const FILE_CEILING = formatBytes(FILE_ATTACHMENT_MAX_BYTES)

/** The drop marker's sub-line (canvas 9c-1), with the ceiling above baked in. */
export const ATTACHMENT_TYPES_LINE = `any file · images up to ${CEILING} go inline`

/**
 * One file the composer would not even try to take, and why. Both kinds
 * carry the measured fact the refusal line prints — a refusal that cannot name
 * what it measured is just a "no".
 */
export type Refusal =
  | { kind: 'too_large'; name: string; size: number }
  | { kind: 'folder'; name: string }

/**
 * Whether a file rides as an `image` block. Anything else — an `.xlsx`, an
 * image too big for the API — rides by path (spec:
 * 2026-10-01-file-attachments-design § What is an image and what is a file).
 */
export function isInlineImage(file: File): boolean {
  return ATTACHMENT_MEDIA_TYPES.has(file.type) && file.size <= ATTACHMENT_MAX_BYTES
}

/**
 * The client pre-check (canvas 9d-C). `hasPath` is a desktop drop the agent
 * can read where it lies: nothing is uploaded, so no ceiling applies and a
 * folder is as good as a file. Without one, a folder cannot be uploaded and a
 * file past the route's ceiling would only be refused by it.
 */
export function precheckFile(file: File, opts: { hasPath: boolean; folder: boolean }): Refusal | null {
  if (opts.hasPath || isInlineImage(file)) return null
  if (opts.folder) return { kind: 'folder', name: file.name }
  if (file.size > FILE_ATTACHMENT_MAX_BYTES) {
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
 * (canvas 9d-C). A single refusal names the file and its fact; several of one
 * kind collapse to a count; a mixed gesture collapses to the count alone.
 */
export function refusalNotice(refusals: readonly Refusal[]): RefusalNotice | null {
  if (refusals.length === 0) return null

  if (refusals.length === 1) {
    const only = refusals[0]
    return only.kind === 'too_large'
      ? {
          label: 'TOO LARGE TO ATTACH',
          fact: only.name,
          tail: `${formatBytes(only.size)} over the ${FILE_CEILING} ceiling.`,
        }
      : { label: "CAN'T ATTACH", fact: only.name, tail: '— a folder needs the desktop app.' }
  }

  const fact = `${refusals.length} files`
  const kinds = new Set(refusals.map((r) => r.kind))
  if (kinds.size === 1) {
    return refusals[0].kind === 'too_large'
      ? { label: 'TOO LARGE TO ATTACH', fact, tail: `over the ${FILE_CEILING} ceiling.` }
      : { label: "CAN'T ATTACH", fact: `${refusals.length} folders`, tail: '— folders need the desktop app.' }
  }
  return { label: "CAN'T ATTACH", fact, tail: 'were folders or too large.' }
}

/**
 * What the chip calls the file (canvas 9c-2). A pasted image has no honest
 * name — the clipboard's own `image.png` is the browser's invention, not the
 * user's — so it is called what it is. A dropped file and a phone photo
 * (`camera`, `gallery`) wear their own name; a nameless one borrows the paste
 * line for the same reason.
 */
export function attachmentName(file: File, source: AttachmentSource): string {
  if ((source === 'clipboard' && file.type.startsWith('image/')) || !file.name) return 'Clipboard image'
  return file.name
}

/** Where one chip's upload stands. `exiting` is the ×'s fade, not a state of the file. */
export type AttachmentState = 'uploading' | 'uploaded' | 'failed'

/** One pending attachment, as the chip row and the send path both read it. */
export interface Attachment {
  /** Local id — the chips are a list of files, and two files can be identical. */
  id: string
  /** `image` rides as an image block; `file` rides by path. */
  kind: 'image' | 'file'
  name: string
  source: AttachmentSource
  /** The local file's byte length; the stored entry's `bytes` once uploaded. */
  size: number
  /** `createObjectURL` of the local image — revoked on remove and on unmount. Null for a file. */
  previewUrl: string | null
  state: AttachmentState
  /** Present exactly when `state` is `uploaded`: the stored image, or the file's path. */
  entry?: ImageRefEntry | FileEntry
  /** Percent, or null before the first tick / when there is nothing to show. */
  progress: number | null
  /** Failed attempts spent. Past `ATTACHMENT_RETRY_LIMIT` the word goes away. */
  retries: number
  /** True for the ×'s fade-out frame, before the chip is dropped from the list. */
  exiting?: boolean
  /**
   * The photo's size before the phone downscaled it (spec
   * 2026-10-02-mobile-app-design § 6.2). Absent on the desktop and for a
   * photo that was sent as it was.
   */
  original?: { w: number; h: number }
}

/**
 * The chip's second line (canvas 9c/9d-A/9d-B, and the phone's 9b). The
 * percentage sits exactly where the size normally does, and a downscaled
 * photo's original size and sent edge sit where the dimensions and size do,
 * which is why this is one function and not fragments in the markup.
 */
export function attachmentMeta(
  chip: Pick<Attachment, 'state' | 'size' | 'progress' | 'entry' | 'original'>,
): string {
  if (chip.state === 'failed') return `${formatBytes(chip.size)} · didn't upload`
  if (chip.state === 'uploading') {
    const pct = chip.progress === null ? '' : ` ${chip.progress} %`
    return `${formatBytes(chip.size)} · uploading${pct}`
  }
  const entry = chip.entry
  if (chip.original && entry && 'w' in entry && entry.w && entry.h) {
    return `${chip.original.w}×${chip.original.h} → sent at ${Math.max(entry.w, entry.h)} px`
  }
  const dims = entry && 'w' in entry && entry.w && entry.h ? `${entry.w}×${entry.h} · ` : ''
  return `${dims}${formatBytes(entry?.bytes ?? chip.size)}`
}

/**
 * Whether a drag should arm the drop state (canvas 9c-1: a drag carrying no
 * files never arms — no flash, no "can't drop that"). Any file arms it now,
 * folders included (spec: 2026-10-01-file-attachments-design § Composer);
 * text out of the transcript or a tag rule being reordered still does not.
 */
export function dragCarriesFiles(dt: DataTransfer | null | undefined): boolean {
  if (!dt) return false
  const items = dt.items
  if (items && items.length > 0) {
    return Array.from(items).some((item) => item.kind === 'file')
  }
  return Array.from(dt.types ?? []).includes('Files')
}

/**
 * The names of the folders a drop carries. Only a drop can tell — `items`
 * answers `webkitGetAsEntry` only while the event is being dispatched — and a
 * folder's `File` looks like any typeless file otherwise.
 */
export function folderNames(dt: DataTransfer | null | undefined): Set<string> {
  const names = new Set<string>()
  for (const item of Array.from(dt?.items ?? [])) {
    if (item.kind !== 'file') continue
    const entry = item.webkitGetAsEntry?.()
    if (entry?.isDirectory) names.add(entry.name)
  }
  return names
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
