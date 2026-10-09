import { useMemo, type ReactNode } from 'react'
import { messageImages, type MessageImage } from '../../lib/fileOpen'
import type { ChatMessage } from '../../lib/types'
import { useSessionMedia } from '../../store/media'
import { useOrbital } from '../../store/store'
import { CantShow } from '../files/CantShow'
import { ImageViewer } from '../files/ImageViewer'
import { mediaItemFor } from '../files/mediaPaging'
import { MediaPager } from '../files/MediaPager'
import { PdfPage } from '../files/PdfViewer'
import { fileKindOf } from '../files/route'
import { TextPreview } from '../files/TextPreview'
import { clockLabel } from '../format'
import { pushedTop, useMobile, type PushedOf } from '../state'

const NO_MESSAGES: ChatMessage[] = []

const ignorePage = () => undefined

/** A lone PDF's foot: 10d's path and session line, with 24g's page chip over it. */
function PdfFoot({ path, caption, page, cached }: { path: string; caption: string; page: string | null; cached: ReactNode }) {
  return (
    <div className="relative z-[2] flex shrink-0 flex-col gap-2.5 bg-[linear-gradient(0deg,rgba(0,0,0,.85),transparent)] px-4 pb-1.5 pt-[18px]">
      {cached}
      <div className="flex items-center gap-2 font-mono text-[11px] text-[rgba(200,215,235,.75)]">
        {page && (
          <span className="rounded-full border border-[rgba(150,205,255,.2)] bg-[rgba(5,7,13,.75)] px-2 py-[3px] text-[#e8eef8]">
            {page}
          </span>
        )}
        <span className="flex-1" />
        <span>scroll</span>
      </div>
      <div className="truncate font-mono text-[11px] text-[rgba(200,215,235,.75)]">
        {path} · {caption}
      </div>
    </div>
  )
}

function clock(timestamp: string | undefined): string | null {
  if (!timestamp) return null
  const at = Date.parse(timestamp)
  return Number.isNaN(at) ? null : clockLabel(at)
}

/**
 * The images to page through, and where the press landed among them: the
 * message's images when the press came from one (spec 2026-10-05-mobile-next
 * § 2, "swipe between the images of the message the tap came from"), else
 * the pressed image alone.
 */
export function pagesFor(
  item: Pick<PushedOf<'file'>, 'path' | 'ref'>,
  message: Pick<ChatMessage, 'role' | 'text' | 'images'> | undefined,
): { items: MessageImage[]; start: number } {
  const all = message ? messageImages(message) : []
  const start = all.findIndex((m) => (m.kind === 'ref' ? m.ref === item.ref : m.path === item.path))
  if (start >= 0) return { items: all, start }
  if (item.ref) return { items: [{ kind: 'ref', ref: item.ref, image: { ref: item.ref, w: null, h: null, bytes: 0 } }], start: 0 }
  return { items: item.path ? [{ kind: 'path', path: item.path }] : [], start: 0 }
}

/**
 * An image, a PDF or a text file the transcript named, pushed over its
 * session (canvas 10d, 10e). One the session's media lists — opened from the
 * gallery, or pressed in the session's own transcript — pages through the
 * session's media (canvas `Feature - Media` 24g); any other keeps paging
 * through its message.
 */
export function FileScreen() {
  const item = useMobile((s) => pushedTop(s, 'file'))
  // Pushed straight over the session: not from a subagent's transcript or a task's output.
  const fromSession = useMobile((s) => s.pushed.length === 1)
  const goBack = useMobile((s) => s.goBack)
  const back = useMemo(() => () => goBack(), [goBack])
  const messages = useOrbital((s) => (item ? (s.transcripts[item.sessionId] ?? NO_MESSAGES) : NO_MESSAGES))
  const title = useOrbital((s) => (item ? s.sessions[item.sessionId]?.title : undefined))
  const media = useSessionMedia(item?.sessionId ?? null, false)
  if (!item) return null

  const message = item.messageId ? messages.find((m) => m.id === item.messageId) : undefined
  const kind = item.ref ? 'image' : item.path ? fileKindOf(item.path) : null
  const listed = kind === 'image' || kind === 'pdf' ? mediaItemFor(item, media, fromSession) : undefined
  const caption = [title, clock(message?.timestamp)].filter(Boolean).join(' ')

  if (listed && media) {
    return <MediaPager key={listed.id} sessionId={item.sessionId} items={media} startId={listed.id} onBack={back} />
  }
  if (kind === 'text' && item.path) {
    return <TextPreview sessionId={item.sessionId} cwd={item.cwd} path={item.path} line={item.line} onBack={back} />
  }
  if (kind === 'image') {
    const { items, start } = pagesFor(item, message)
    return <ImageViewer sessionId={item.sessionId} cwd={item.cwd} items={items} start={start} caption={caption} onBack={back} />
  }
  if (kind === 'pdf' && item.path) {
    // A PDF the media list does not hold — named in a subagent's transcript, or by a Mac without the list.
    return (
      <PdfPage
        sessionId={item.sessionId}
        path={item.path}
        cwd={item.cwd}
        index={0}
        count={1}
        onBack={back}
        onPage={ignorePage}
        foot={({ page, cached }) => <PdfFoot path={item.path ?? ''} caption={caption} page={page} cached={cached} />}
      />
    )
  }
  // Reached only by a path that did not come from a link (Decision 8).
  return (
    <main className="flex h-full flex-col bg-[#05070d] text-[#e8eef8]">
      <div className="flex h-14 shrink-0 items-center pl-1.5">
        <button
          type="button"
          aria-label="Back"
          onClick={back}
          className="grid h-11 w-11 place-items-center text-[28px] leading-none text-[rgba(220,235,255,.85)]"
        >
          ‹
        </button>
      </div>
      <div className="flex flex-1 flex-col justify-center">
        <CantShow path={item.path} size={null} />
      </div>
    </main>
  )
}
