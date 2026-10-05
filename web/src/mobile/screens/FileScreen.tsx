import { useMemo } from 'react'
import { messageImages, type MessageImage } from '../../lib/fileOpen'
import type { ChatMessage } from '../../lib/types'
import { useOrbital } from '../../store/store'
import { CantShow } from '../files/CantShow'
import { ImageViewer } from '../files/ImageViewer'
import { fileKindOf } from '../files/route'
import { pushedTop, useMobile, type PushedOf } from '../state'

const NO_MESSAGES: ChatMessage[] = []

function clock(timestamp: string | undefined): string | null {
  if (!timestamp) return null
  const at = new Date(timestamp)
  return Number.isNaN(at.getTime()) ? null : at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
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

/** An image or a text file the transcript named, pushed over its session (canvas 10d, 10e). */
export function FileScreen() {
  const item = useMobile((s) => pushedTop(s, 'file'))
  const goBack = useMobile((s) => s.goBack)
  const back = useMemo(() => () => goBack(), [goBack])
  const messages = useOrbital((s) => (item ? (s.transcripts[item.sessionId] ?? NO_MESSAGES) : NO_MESSAGES))
  const title = useOrbital((s) => (item ? s.sessions[item.sessionId]?.title : undefined))
  if (!item) return null

  const message = item.messageId ? messages.find((m) => m.id === item.messageId) : undefined
  const kind = item.ref ? 'image' : item.path ? fileKindOf(item.path) : null

  if (kind === 'image') {
    const { items, start } = pagesFor(item, message)
    const caption = [title, clock(message?.timestamp)].filter(Boolean).join(' ')
    return <ImageViewer sessionId={item.sessionId} items={items} start={start} caption={caption} onBack={back} />
  }
  // Text previews are not built yet; until then, and for a path that did not
  // come from a link (Decision 8), it says so.
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
