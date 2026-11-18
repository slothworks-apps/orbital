import { z } from 'zod'
import { VIEW_SEND_MAX_BYTES, viewValueBytes } from '@orbital/shared/views'
import { MESSAGE_TAG } from './bridge'

/**
 * The parent's half of the bridge (spec 2026-11-18-generated-views-design §
 * The bridge): what a message from a view's frame is allowed to do. Pure, so
 * the rules a page cannot get around are tested without a frame.
 *
 * Nothing the page posts is trusted. A message counts only when it comes from
 * the frame's own window and has the bridge's shape. `send` and `open`
 * additionally need a user gesture that went into this frame: this window
 * has transient activation right now (the frame's click activates its
 * ancestors too, a timer in the page does not) AND the frame holds the focus
 * (a click into the frame moves the focus into it, a click or typing anywhere
 * else in Orbital moves it out) — so a page cannot ride on a click the user
 * made elsewhere in Orbital. Each goes at most once a second. `send` also
 * needs room: a waiting view takes its first send as the answer and nothing
 * after, and a view that does not wait cannot send while the session waits on
 * something else — the message would answer that.
 */

/** A view sends, and opens a link, at most once per this many ms. */
export const VIEW_SEND_INTERVAL_MS = 1000

const Tag = z.literal(MESSAGE_TAG)

const FrameMessage = z.discriminatedUnion('type', [
  z.object({ tag: Tag, type: z.literal('ready') }),
  z.object({ tag: Tag, type: z.literal('height'), height: z.number().nonnegative() }),
  z.object({
    tag: Tag,
    type: z.literal('error'),
    kind: z.enum(['script', 'page']),
    message: z.string().max(4000),
    url: z.string().max(2000).optional(),
  }),
  z.object({ tag: Tag, type: z.literal('open'), url: z.string().max(4000) }),
  z.object({ tag: Tag, type: z.literal('escape') }),
  z.object({ tag: Tag, type: z.literal('send'), value: z.unknown() }),
])

export type ViewError = { kind: 'script' | 'page'; message: string; url?: string }

/** What a message from the frame comes to. */
export type FrameAction =
  | { kind: 'ignore' }
  | { kind: 'ready' }
  | { kind: 'height'; height: number }
  | { kind: 'error'; error: ViewError }
  | { kind: 'open'; url: string }
  | { kind: 'escape' }
  /** `answer`: it becomes the waiting call's result; `message`: the user's message to the session. */
  | { kind: 'send'; as: 'answer' | 'message'; value: unknown }
  /** Refused, and why: `blocked` is the one the view says something about (another decision is pending). */
  | { kind: 'refused'; reason: 'gesture' | 'rate' | 'size' | 'answered' | 'blocked' | 'offline' }

export interface FrameContext {
  /** The frame's `contentWindow`, the only source a message is taken from. */
  frame: unknown
  /** Whether this window has transient user activation now (`navigator.userActivation.isActive`). */
  userActive: boolean
  /** Whether the frame holds the focus now (`document.activeElement` is the iframe): the gesture went into it. */
  frameFocused: boolean
  now: number
  /** When this view last sent, ms; null for never. */
  lastSendAt: number | null
  /** When this view last opened a link, ms; null for never. */
  lastOpenAt?: number | null
  /** The call waits on the user and nothing has answered it yet. */
  waiting: boolean
  /** The call waited and was answered, or this view already sent its answer: it is read-only. */
  answered: boolean
  /** The session waits on a decision that is not this view (a question, a permission, another view). */
  otherDecisionPending: boolean
  /** The session's device cannot be reached: nothing can be sent. */
  offline?: boolean
}

/** Only http(s) and mailto links leave the frame, to the user's browser. */
function openable(url: string): boolean {
  return /^(https?:|mailto:)/i.test(url)
}

/** Reads one `message` event from a view's frame. */
export function readFrameMessage(event: { source: unknown; data: unknown }, ctx: FrameContext): FrameAction {
  if (ctx.frame == null || event.source !== ctx.frame) return { kind: 'ignore' }
  const parsed = FrameMessage.safeParse(event.data)
  if (!parsed.success) return { kind: 'ignore' }
  const message = parsed.data
  switch (message.type) {
    case 'ready':
      return { kind: 'ready' }
    case 'height':
      return { kind: 'height', height: Math.round(message.height) }
    case 'error':
      return { kind: 'error', error: { kind: message.kind, message: message.message, ...(message.url ? { url: message.url } : {}) } }
    case 'open':
      if (!openable(message.url)) return { kind: 'ignore' }
      if (!gestureInFrame(ctx)) return { kind: 'refused', reason: 'gesture' }
      if (tooSoon(ctx.lastOpenAt ?? null, ctx.now)) return { kind: 'refused', reason: 'rate' }
      return { kind: 'open', url: message.url }
    case 'escape':
      return { kind: 'escape' }
    case 'send':
      return readSend(message.value, ctx)
  }
}

/** A user gesture right now, and one that went into this frame. */
function gestureInFrame(ctx: FrameContext): boolean {
  return ctx.userActive && ctx.frameFocused
}

function tooSoon(last: number | null, now: number): boolean {
  return last !== null && now - last < VIEW_SEND_INTERVAL_MS
}

function readSend(value: unknown, ctx: FrameContext): FrameAction {
  if (ctx.answered) return { kind: 'refused', reason: 'answered' }
  if (!gestureInFrame(ctx)) return { kind: 'refused', reason: 'gesture' }
  if (tooSoon(ctx.lastSendAt, ctx.now)) return { kind: 'refused', reason: 'rate' }
  const bytes = viewValueBytes(value)
  if (bytes === null || bytes > VIEW_SEND_MAX_BYTES) return { kind: 'refused', reason: 'size' }
  if (ctx.offline) return { kind: 'refused', reason: 'offline' }
  if (ctx.waiting) return { kind: 'send', as: 'answer', value }
  if (ctx.otherDecisionPending) return { kind: 'refused', reason: 'blocked' }
  return { kind: 'send', as: 'message', value }
}

/** The parent's message to the frame: the colour theme's variables changed. */
export function themeMessage(vars: Record<string, string>): { tag: string; type: 'theme'; vars: Record<string, string> } {
  return { tag: MESSAGE_TAG, type: 'theme', vars }
}

/**
 * The failure's two lines (69c FAILED): what happened, and the first line of
 * the error — for a script, where it was and that it did not load.
 */
export function failureText(error: ViewError): { title: string; detail: string; hint: string } {
  if (error.kind === 'script') {
    const where = error.url ? error.url.replace(/^https?:\/\//, '') : 'A script'
    return {
      title: 'A script it needs didn’t load',
      detail: `${where} · ${error.message}`,
      hint: 'Offline, or the CDN is blocked here. Reload tries again.',
    }
  }
  return {
    title: 'This view stopped working',
    detail: error.message.split('\n')[0],
    hint: 'The page threw an error. The session wasn’t told; you can send it.',
  }
}
