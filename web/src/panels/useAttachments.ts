import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { desktopPathFor } from '../lib/desktop'
import {
  MAX_ATTACHMENTS,
  attachmentName,
  isInlineImage,
  precheckFile,
  refusalNotice,
  type Attachment,
  type Refusal,
  type RefusalNotice,
} from '../lib/attachments'
import type { AttachmentSource, FileEntry } from '../lib/types'
import type { SentAttachment } from '../store/store'

/**
 * The composer's attachment state machine (spec: 2026-09-20-composer-design
 * § Image intake; canvas 9c/9d).
 *
 * A hook rather than component state because three surfaces read it: the well
 * draws the chips, the panel's Send button reads whether anything is armed, and
 * the send path takes the uploaded entries. Keeping it out of `Composer` is
 * what lets the same component serve both mounts while only one of them has a
 * session to upload to.
 *
 * ## Why a ref is the source of truth
 *
 * The list lives in `listRef` and is mirrored into state for rendering. That is
 * deliberate: every transition here is driven by an event or by a settling
 * promise, several of them land in the same tick (six dropped files start six
 * uploads), and two of them — starting an upload, and handing the turn its
 * images — need to READ the post-transition list rather than describe it. A
 * `setState` updater that started a fetch or resolved a promise would be an
 * impure reducer; this keeps the effects where they belong and makes the
 * ordering legible.
 */

/** How often an in-flight upload's estimate is refreshed. */
const UPLOAD_TICK_MS = 200

/**
 * Time constant of the progress estimate. See `estimateProgress` — the one
 * invented number in this feature, invented because `fetch` cannot report how
 * much of a request body has gone out.
 */
const UPLOAD_ESTIMATE_TAU_MS = 900

/** The estimate never claims more than this until the response actually lands. */
const UPLOAD_ESTIMATE_CEILING = 95

/** The ×'s fade before the row reflows (canvas 9e chip enter/exit). */
export const CHIP_EXIT_MS = 100

/** How long the refusal line holds, and how long its fade-out lasts (canvas 9e). */
const REFUSAL_HOLD_MS = 4000
const REFUSAL_OUT_MS = 200

/**
 * An upload's progress as a percentage.
 *
 * `fetch` resolves once, at the end, so there are no real chunk boundaries to
 * report: the honest options were a rail that jumps 0 → 100 (useless) or an
 * elapsed-time estimate. This is the estimate, shaped so it cannot lie in the
 * direction that matters — it approaches `UPLOAD_ESTIMATE_CEILING`
 * asymptotically and only the response itself completes the chip. Nothing is
 * reported before the first `UPLOAD_TICK_MS`, which is also how the canvas's
 * "under 200 ms the rail never appears" falls out for free.
 */
function estimateProgress(elapsedMs: number): number {
  const share = 1 - Math.exp(-elapsedMs / UPLOAD_ESTIMATE_TAU_MS)
  return Math.min(UPLOAD_ESTIMATE_CEILING, Math.round(UPLOAD_ESTIMATE_CEILING * share))
}

export interface AttachmentsHandle {
  items: readonly Attachment[]
  /** The line currently replacing the hint line, or null. */
  refusal: (RefusalNotice & { exiting: boolean }) | null
  /**
   * At least one chip is uploaded or still uploading — the Send button's other
   * arming condition. A failed chip alone does NOT arm it (spec § Send).
   */
  armed: boolean
  /** Any upload still in flight, which is what makes a send queue. */
  uploading: boolean
  /**
   * Take a gesture's files: pre-check, chip the keepers, collapse the
   * refusals. `folders` names the folders a drop carries (`folderNames`).
   */
  accept(files: readonly File[], source: AttachmentSource, folders?: ReadonlySet<string>): void
  remove(id: string): void
  retry(id: string): void
  /**
   * Hands the turn its attachments and clears the row in the same beat (canvas
   * 9c-3: "Text and chips clear together"). Every chip that is not failed
   * leaves at once; the promise resolves when the uploads among them have
   * settled, with the images and the files that landed. Failed chips stay
   * behind — not in the turn, and not lost either.
   */
  takeForSend(): Promise<TakenAttachments>
  /** Drops everything, revoking the previews. */
  reset(): void
}

/** What a send takes out of the well: images ride as blocks, files by path. */
export interface TakenAttachments {
  images: SentAttachment[]
  files: FileEntry[]
}

/** Per-chip bookkeeping that never needs to re-render anything. */
interface ChipWork {
  file: File
  controller?: AbortController
  /** Resolves when the current attempt settles, however it settles. */
  run?: Promise<void>
  ticker?: ReturnType<typeof setInterval>
  /** Set once the bytes are stored (or the path is known) — what the send path collects. */
  result?: SentAttachment | FileEntry
}

let chipCounter = 0

/**
 * `sessionId` is `null` in the New Session dialog, which has no session until
 * Launch — `api.uploadAttachment` then posts to the sessionless route. The
 * detail panel keeps passing the empty string for its no-selection render,
 * which is NOT the same thing: nothing can be dropped on a panel that is not
 * there, and an empty id must not quietly become a valid sessionless upload.
 */
export function useAttachments(sessionId: string | null): AttachmentsHandle {
  const [items, setItems] = useState<readonly Attachment[]>([])
  const [refusal, setRefusal] = useState<(RefusalNotice & { exiting: boolean }) | null>(null)

  const listRef = useRef<Attachment[]>([])
  const work = useRef(new Map<string, ChipWork>())
  const refusalTimers = useRef<ReturnType<typeof setTimeout>[]>([])

  /** Publishes the ref into state. Every mutation below ends in one of these. */
  const sync = useCallback(() => {
    setItems(listRef.current.slice())
  }, [])

  const patch = useCallback(
    (id: string, change: Partial<Attachment>) => {
      const index = listRef.current.findIndex((chip) => chip.id === id)
      if (index < 0) return
      listRef.current[index] = { ...listRef.current[index], ...change }
      sync()
    },
    [sync],
  )

  const stopTicker = useCallback((id: string) => {
    const entry = work.current.get(id)
    if (entry?.ticker !== undefined) clearInterval(entry.ticker)
    if (entry) entry.ticker = undefined
  }, [])

  /**
   * Runs (or re-runs) one chip's upload. `isRetry` only decides whether a
   * failure counts against the retry budget — the first failure is not a failed
   * retry (canvas 9d-B: "Two failed retries and the word goes away").
   */
  const startUpload = useCallback(
    (chip: Attachment, isRetry: boolean) => {
      const entry = work.current.get(chip.id)
      if (!entry) return
      const controller = new AbortController()
      entry.controller = controller
      const startedAt = Date.now()
      entry.ticker = setInterval(() => {
        patch(chip.id, { progress: estimateProgress(Date.now() - startedAt) })
      }, UPLOAD_TICK_MS)

      const fail = () => {
        const current = listRef.current.find((c) => c.id === chip.id)
        patch(chip.id, {
          state: 'failed',
          progress: null,
          retries: isRetry ? (current?.retries ?? 0) + 1 : (current?.retries ?? 0),
        })
      }

      entry.run = api
        .uploadAttachment(sessionId, entry.file, { signal: controller.signal })
        .then((result) => {
          if (controller.signal.aborted) return
          if (result.kind !== 'ok') {
            // A 413/415/400 here is the server disagreeing with the client
            // pre-check (a mislabelled file, a ceiling that has moved). That is
            // a failed upload, not a new refusal line: the chip already exists,
            // and the one retry is the right affordance for it.
            fail()
            return
          }
          // The server decides where the bytes went: an image within the
          // block ceiling answers a ref, anything else a path.
          entry.result =
            'kind' in result.entry
              ? result.entry
              : { entry: result.entry, name: chip.name, source: chip.source }
          patch(chip.id, { state: 'uploaded', entry: result.entry, progress: null })
        })
        .catch(() => {
          // An abort is a removal, not a failure — the chip is already leaving.
          if (!controller.signal.aborted) fail()
        })
        .finally(() => {
          stopTicker(chip.id)
          entry.controller = undefined
          entry.run = undefined
        })
    },
    [patch, sessionId, stopTicker],
  )

  /** Releases everything one chip holds: its upload, its ticker, its preview. */
  const release = useCallback(
    (id: string, { abort }: { abort: boolean }) => {
      const entry = work.current.get(id)
      if (!entry) return
      if (entry.ticker !== undefined) clearInterval(entry.ticker)
      if (abort) entry.controller?.abort()
      work.current.delete(id)
    },
    [],
  )

  const showRefusal = useCallback((refusals: Refusal[]) => {
    const notice = refusalNotice(refusals)
    for (const timer of refusalTimers.current) clearTimeout(timer)
    refusalTimers.current = []
    if (!notice) return
    // A second refusal rewrites the line and restarts the clock; it never
    // stacks (canvas 9e refusal line).
    setRefusal({ ...notice, exiting: false })
    refusalTimers.current = [
      setTimeout(
        () => setRefusal((current) => (current ? { ...current, exiting: true } : null)),
        REFUSAL_HOLD_MS,
      ),
      setTimeout(() => setRefusal(null), REFUSAL_HOLD_MS + REFUSAL_OUT_MS),
    ]
  }, [])

  const accept = useCallback(
    (picked: readonly File[], source: AttachmentSource, folders?: ReadonlySet<string>) => {
      if (picked.length === 0) return
      const refusals: Refusal[] = []
      const keepers: { file: File; path: string | null }[] = []
      for (const file of picked) {
        const path = desktopPathFor(file)
        const refused = precheckFile(file, {
          hasPath: path !== null,
          folder: folders?.has(file.name) ?? false,
        })
        if (refused) refusals.push(refused)
        else keepers.push({ file, path })
      }

      // Judgement call: files past the ceiling are simply not taken. The canvas
      // gives the ceiling but no copy for overflowing it, and a line invented
      // here would be the only invented copy in the feature.
      const room = Math.max(0, MAX_ATTACHMENTS - listRef.current.length)
      const fresh: Attachment[] = keepers.slice(0, room).map(({ file, path }) => {
        chipCounter += 1
        const id = `chip:${chipCounter}`
        const name = attachmentName(file, source)
        if (!isInlineImage(file) && path) {
          // A desktop drop the agent can read where it lies: nothing to
          // upload, the chip is done the moment it appears.
          const entry: FileEntry = { kind: 'file', path, name: file.name || name, bytes: file.size }
          work.current.set(id, { file, result: entry })
          return {
            id, kind: 'file', name, source, size: file.size, previewUrl: null,
            state: 'uploaded', entry, progress: null, retries: 0,
          }
        }
        work.current.set(id, { file })
        const image = isInlineImage(file)
        return {
          id,
          kind: image ? 'image' : 'file',
          name,
          source,
          size: file.size,
          previewUrl: image ? URL.createObjectURL(file) : null,
          state: 'uploading',
          progress: null,
          retries: 0,
        }
      })

      if (fresh.length > 0) {
        listRef.current = [...listRef.current, ...fresh]
        sync()
        for (const chip of fresh) if (chip.state === 'uploading') startUpload(chip, false)
      }
      showRefusal(refusals)
    },
    [showRefusal, startUpload, sync],
  )

  const remove = useCallback(
    (id: string) => {
      const chip = listRef.current.find((c) => c.id === id)
      if (!chip) return
      release(id, { abort: true })
      patch(id, { exiting: true })
      setTimeout(() => {
        listRef.current = listRef.current.filter((c) => c.id !== id)
        if (chip.previewUrl) URL.revokeObjectURL(chip.previewUrl)
        sync()
      }, CHIP_EXIT_MS)
    },
    [patch, release, sync],
  )

  const retry = useCallback(
    (id: string) => {
      const chip = listRef.current.find((c) => c.id === id)
      if (!chip || !work.current.has(id)) return
      patch(id, { state: 'uploading', progress: null })
      startUpload(chip, true)
    },
    [patch, startUpload],
  )

  const takeForSend = useCallback(async () => {
    const taken = listRef.current.filter((chip) => chip.state !== 'failed')
    listRef.current = listRef.current.filter((chip) => chip.state === 'failed')
    sync()

    // The uploads are NOT aborted — that is the whole point of the queued send:
    // the chips are gone from the well, the turn waits for their bytes.
    await Promise.all(
      taken.map((chip) => work.current.get(chip.id)?.run).filter((run) => run !== undefined),
    )

    const out: TakenAttachments = { images: [], files: [] }
    for (const chip of taken) {
      const result = work.current.get(chip.id)?.result
      // A chip that failed during the wait is simply not in the turn. It is not
      // put back either: the send already cleared the well, and resurrecting a
      // chip under a message the user has moved on from would be worse.
      if (result && 'kind' in result) out.files.push(result)
      else if (result) out.images.push(result)
      release(chip.id, { abort: false })
      if (chip.previewUrl) URL.revokeObjectURL(chip.previewUrl)
    }
    return out
  }, [release, sync])

  const reset = useCallback(() => {
    for (const chip of listRef.current) {
      release(chip.id, { abort: true })
      if (chip.previewUrl) URL.revokeObjectURL(chip.previewUrl)
    }
    listRef.current = []
    sync()
    for (const timer of refusalTimers.current) clearTimeout(timer)
    refusalTimers.current = []
    setRefusal(null)
  }, [release, sync])

  // Unmount: every object URL is this hook's to release, and every upload still
  // in flight has nothing left to report to.
  // The refs are read INSIDE the cleanup, not captured at mount: the chip list
  // and the timer array are both reassigned as the composer is used, so a
  // snapshot taken here would release an empty list and leak the real one.
  useEffect(
    () => () => {
      for (const entry of work.current.values()) {
        if (entry.ticker !== undefined) clearInterval(entry.ticker)
        entry.controller?.abort()
      }
      work.current.clear()
      for (const timer of refusalTimers.current) clearTimeout(timer)
      for (const chip of listRef.current) if (chip.previewUrl) URL.revokeObjectURL(chip.previewUrl)
      listRef.current = []
    },
    [],
  )

  const armed = items.some((chip) => chip.state !== 'failed')
  const uploading = items.some((chip) => chip.state === 'uploading')

  return useMemo(
    () => ({ items, refusal, armed, uploading, accept, remove, retry, takeForSend, reset }),
    [items, refusal, armed, uploading, accept, remove, retry, takeForSend, reset],
  )
}
