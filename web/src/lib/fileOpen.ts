import { createContext, useContext, useEffect, useMemo, useRef } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import type { ChatMessage, ImageRefEntry } from './types'
import { findPathMatches, isImagePath } from './pathLinks'

/**
 * What a press on a path or an image thumbnail does, when something other
 * than the desktop decides (spec 2026-10-05-mobile-next § 2, "Two seams in
 * `web/`"). Unconfigured — the desktop — nothing here is consulted:
 * `PathButton` opens the file viewer or the `Lightbox`, `ImageThumb` its
 * `Lightbox`, and a path that is not pressable stays plain text, exactly as
 * before this existed.
 *
 * Configured — the phone — a press calls `open` with the message it came
 * from, and a long-press on a path calls `longPress`: on a link, and on a
 * path the phone cannot show, which is then drawn as a plain mono span that
 * carries nothing but the long-press (spec § 8 Decision 8: such a path is
 * never a link).
 *
 * Set once at start-up, never toggled while the transcript is on screen, so
 * the components read it at render time instead of subscribing.
 */
export type FileOpenTarget =
  | {
      kind: 'path'
      path: string
      line: number | null
      messageId?: string
      /** The `cwd` the message was written in, when it came from a transcript (`FileCwdContext`). */
      cwd?: string
    }
  | { kind: 'ref'; ref: string; messageId?: string }

export interface FileOpenHandlers {
  open(target: FileOpenTarget): void
  longPress?(path: string): void
}

let handlers: FileOpenHandlers | null = null

/** Routes presses away from the desktop's viewers; `null` restores them. */
export function configureFileOpen(next: FileOpenHandlers | null): void {
  handlers = next
}

export function fileOpenHandlers(): FileOpenHandlers | null {
  return handlers
}

/**
 * How long a finger rests before it is a long-press, and how far it may
 * drift meanwhile. No canvas value exists for either; these are the
 * platforms' own long-press conventions, not a design choice.
 */
export const LONG_PRESS_MS = 500
export const LONG_PRESS_SLOP_PX = 10

export interface LongPressProps {
  onPointerDown?: (event: ReactPointerEvent) => void
  onPointerMove?: (event: ReactPointerEvent) => void
  onPointerUp?: () => void
  onPointerCancel?: () => void
  onPointerLeave?: () => void
  onContextMenu?: (event: ReactMouseEvent) => void
  onClickCapture?: (event: ReactMouseEvent) => void
}

const NO_PROPS: LongPressProps = {}

/**
 * The handlers that turn a resting finger on `path` into `longPress(path)`.
 * Empty — so spreading them changes nothing — when no `longPress` is
 * configured or there is no path. The click a long-press ends in is
 * swallowed, so the element's own press does not run as well.
 */
export function useLongPress(path: string | null): LongPressProps {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  const fired = useRef(false)
  const longPress = handlers?.longPress

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  return useMemo(() => {
    if (!longPress || path === null) return NO_PROPS
    const cancel = () => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      start.current = null
    }
    return {
      onPointerDown: (event) => {
        cancel()
        fired.current = false
        start.current = { x: event.clientX, y: event.clientY }
        timer.current = setTimeout(() => {
          timer.current = null
          fired.current = true
          longPress(path)
        }, LONG_PRESS_MS)
      },
      onPointerMove: (event) => {
        const from = start.current
        if (!from) return
        if (Math.hypot(event.clientX - from.x, event.clientY - from.y) > LONG_PRESS_SLOP_PX) cancel()
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
      onPointerLeave: cancel,
      // The WebView's own long-press (select, callout) would race this one.
      onContextMenu: (event) => event.preventDefault(),
      onClickCapture: (event) => {
        if (!fired.current) return
        fired.current = false
        event.preventDefault()
        event.stopPropagation()
      },
    }
  }, [longPress, path])
}

/** One image a message carries, in the order a viewer pages through them. */
export type MessageImage =
  | { kind: 'ref'; ref: string; image: ImageRefEntry }
  | { kind: 'path'; path: string }

/**
 * The images of one message, in order: the refs it carries (an attached
 * image, a tool result's screenshot), then the image paths its text names —
 * only in agent prose, the one place a path in text is pressable. A path
 * named twice is listed once.
 */
export function messageImages(message: Pick<ChatMessage, 'role' | 'text' | 'images'>): MessageImage[] {
  const out: MessageImage[] = (message.images ?? []).map((image) => ({ kind: 'ref', ref: image.ref, image }))
  if (message.role !== 'assistant' || !message.text) return out
  const seen = new Set<string>()
  for (const match of findPathMatches(message.text)) {
    if (!isImagePath(match.path) || seen.has(match.path)) continue
    seen.add(match.path)
    out.push({ kind: 'path', path: match.path })
  }
  return out
}

/** The message a press came from, so the viewer can page through its images. */
export interface FileMessage {
  messageId: string
  images: MessageImage[]
}

export const FileMessageContext = createContext<FileMessage | null>(null)

export function useFileMessage(): FileMessage | null {
  return useContext(FileMessageContext)
}

/**
 * The `cwd` the transcript entry a path sits in was written in (spec
 * 2026-10-07-live-working-tree-design § 4): a press sends it along, so the
 * file opens from the tree the agent wrote the path in — the session's own
 * line or a subagent's. Provided by the transcript's message and tool rows on
 * the desktop and the phone alike; a path anywhere else (the composer, the
 * header) has none, and the server falls back to the session's trees.
 */
export const FileCwdContext = createContext<string | undefined>(undefined)

export function useFileCwd(): string | undefined {
  return useContext(FileCwdContext)
}

/**
 * The transcript message a press sits in, on the desktop too — where
 * `FileMessageContext` is the phone's alone. The media view opens a named
 * path on the item of this message (spec 2026-10-09-session-media-design).
 */
export const MessageIdContext = createContext<string | undefined>(undefined)

export function useMessageId(): string | undefined {
  return useContext(MessageIdContext)
}
