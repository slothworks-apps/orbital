import { createContext, useContext, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import type { ChatMessage, MediaItem } from '../lib/types'
import { isPdfPath, mediaPathsInReply } from '../lib/pathLinks'
import { canResolveFile, useMediaSourceUrl } from '../lib/images'
import { fileOpenHandlers } from '../lib/fileOpen'
import { usePdfThumbnail } from '../lib/pdf'
import { useMedia } from '../store/media'
import { GoneMark, PdfTag, isGone, pdfKey } from './MediaParts'
import { MediaViewer } from './MediaViewer'

/**
 * The images and PDFs a reply names, as one row of thumbnails under its text
 * (canvas `Feature - Media` 24f A): in the order named, once each, the paths
 * in the text still links. 96px tall like a tool-result image (7b), aspect
 * kept, 6px apart, wrapping, 8px under the reply.
 *
 * Only inside a session's own transcript — `ReplyMediaSession` says which —
 * because a named file is read through that session's trees: a subagent's
 * reply in its panel names files the session never did. And only where named
 * files can be resolved here (`canResolveFile`).
 */
export const ReplyMediaSession = createContext<string | null>(null)

/** 24f A / 7b: the thumbnails' height, and the width a wide one is held to (7d's 86% of the column). */
const REPLY_THUMB_H_PX = 96
const REPLY_THUMB_MAX_W_PX = 349
/** 24f A: a gone file whose size is unknown keeps the canvas's footprint. */
const GONE_W_PX = 154
/** 24f A: a PDF page's footprint before pdf.js has measured it — US Letter at 96px. */
const PDF_W_PX = 74

export function ReplyMedia({ message }: { message: ChatMessage }) {
  const sessionId = useContext(ReplyMediaSession)
  const paths = useMemo(
    () =>
      message.role === 'assistant' && message.text && !message.partial
        ? mediaPathsInReply(message.text).filter(canResolveFile)
        : [],
    [message.role, message.text, message.partial],
  )
  const items = useMedia((s) => (sessionId ? s.lists[sessionId] : undefined))
  const [open, setOpen] = useState<string | null>(null)
  if (!sessionId || paths.length === 0) return null
  const routed = fileOpenHandlers()

  const itemFor = (path: string): MediaItem | undefined =>
    items?.find((item) => item.messageId === message.id && item.source === 'agent' && item.path === path)

  return (
    <div data-reply-media className="mt-1 flex flex-wrap gap-1.5">
      {paths.map((path) => (
        <ReplyThumb
          key={path}
          sessionId={sessionId}
          path={path}
          cwd={message.cwd}
          item={itemFor(path)}
          onOpen={() =>
            routed
              ? routed.open({ kind: 'path', path, line: null, messageId: message.id, ...(message.cwd ? { cwd: message.cwd } : {}) })
              : setOpen(path)
          }
        />
      ))}
      {!routed && (
        <MediaViewer
          open={open !== null}
          sessionId={sessionId}
          target={open ? { kind: 'path', path: open, cwd: message.cwd, messageId: message.id } : null}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  )
}

const FRAME =
  'relative flex-none overflow-hidden rounded-[6px] border p-0 transition-[border-color,box-shadow] duration-[160ms] ease-out'

function ReplyThumb({
  sessionId,
  path,
  cwd,
  item,
  onOpen,
}: {
  sessionId: string
  path: string
  cwd?: string
  item: MediaItem | undefined
  onOpen: () => void
}) {
  const pdf = isPdfPath(path)
  const [failed, setFailed] = useState(false)
  const { url } = useMediaSourceUrl(sessionId, { path, cwd })
  const thumb = usePdfThumbnail(pdf && !(item && isGone(item)) ? url : null, url ? pdfKey(url, item ?? {}) : '')
  const gone = (item ? isGone(item) : false) || failed || thumb.failed

  const box: CSSProperties = { height: REPLY_THUMB_H_PX }
  if (item?.w && item.h) box.width = Math.min(Math.round((item.w * REPLY_THUMB_H_PX) / item.h), REPLY_THUMB_MAX_W_PX)
  else if (pdf) box.width = thumb.thumb ? Math.round(thumb.thumb.aspect * REPLY_THUMB_H_PX) : PDF_W_PX
  else if (gone) box.width = GONE_W_PX

  if (gone) {
    return (
      <button
        type="button"
        title={path}
        aria-label={`${path} — no longer on disk`}
        onClick={onOpen}
        style={box}
        className={[FRAME, 'flex flex-col items-center justify-center gap-1.5 border-[rgba(150,205,255,.1)] bg-[rgba(4,8,16,.6)]'].join(' ')}
      >
        <GoneMark size="reply" />
      </button>
    )
  }

  return (
    <button
      type="button"
      title={path}
      aria-label={`Open ${path}`}
      onClick={onOpen}
      style={{ ...box, cursor: 'zoom-in' }}
      className={[
        FRAME,
        'block border-[rgba(150,205,255,.12)] bg-[rgba(4,8,16,.6)] hover:border-[rgba(150,205,255,.42)] hover:shadow-[0_0_0_3px_rgba(89,228,243,.12)]',
      ].join(' ')}
    >
      {pdf ? (
        <>
          {thumb.thumb && <img src={thumb.thumb.url} alt="" className="block h-full w-full object-cover object-top" />}
          <PdfTag pages={thumb.thumb?.pages ?? null} />
        </>
      ) : (
        url && (
          <img
            src={url}
            alt=""
            loading="lazy"
            onError={() => setFailed(true)}
            // Unknown dimensions: the height holds and the image finds its own width.
            className={box.width ? 'block h-full w-full' : 'block h-full w-auto'}
            style={box.width ? undefined : { maxWidth: REPLY_THUMB_MAX_W_PX }}
          />
        )
      )}
    </button>
  )
}
