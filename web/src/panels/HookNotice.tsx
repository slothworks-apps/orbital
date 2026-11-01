import { useEffect, useState, type CSSProperties } from 'react'
import {
  STOP_HOOK_EVENT, hookNoticeDetail, hookNoticeLead, hookWaitCaption, type LiveHookNotice,
} from '@orbital/shared/hookNotice'
import { api } from '../lib/api'
import { reportError } from '../lib/errors'
import { stateColor } from '../lib/stateStyle'
import type { ChatMessage } from '../lib/types'
import { Button } from '../ui/Button'
import { usePresence } from '../ui/usePresence'

/**
 * The live row while a hook holds the session (canvas `Feature - Stop hook`
 * 1a–1e; spec 2026-10-31-message-beats-stop-hook-design): a block tinted
 * with the WORKING colour, not a NOTICE printout, since something runs. Only
 * a `Stop` hook's row carries Cancel, which interrupts the session; the
 * server takes an interrupt then for the hooks' cancel, and a message
 * waiting behind them is answered at once. Every other event's row has no
 * action: stopping it stops the turn, which is the Stop button's (1e). The
 * row goes when the server takes the notice down; nothing changes here.
 */

/** 1d TIMING: the row fades in and out over this; nothing else on it moves. */
export const HOOK_ROW_FADE_MS = 200

/** The WORKING state's colour: the row's only hue (1d ACCEPTANCE). */
const WORKING = stateColor('working')

/** A share of the WORKING colour, for the row's border and fill. */
function working(share: number): string {
  return `color-mix(in oklab, ${WORKING} ${share}%, transparent)`
}

/** 1d PROPOSED: the border at 35% over a 6% fill. */
const ROW_TINT: CSSProperties = { borderColor: working(35), background: working(6) }

/**
 * What the row says. A Mac that predates `notice.hook` sends only the text,
 * and only for `Stop` hooks, which it let be cancelled.
 */
export function hookRowOf(message: ChatMessage): { hook: LiveHookNotice | null; lead: string; detail: string[]; cancellable: boolean } {
  const hook = message.notice?.hook ?? null
  if (!hook) return { hook: null, lead: message.text ?? '', detail: [], cancellable: true }
  return { hook, lead: hookNoticeLead(hook), detail: hookNoticeDetail(hook), cancellable: hook.cancellable }
}

/**
 * The row's tooltip (1d, 1e): a Stop row shows its commands in full, which
 * the line truncates first, and none where it names none; a row without
 * Cancel says what stops it instead.
 */
export function hookRowTip(message: ChatMessage): string | undefined {
  const { hook, detail, cancellable } = hookRowOf(message)
  if (cancellable) return hook?.commands?.length ? hook.commands.join(' · ') : undefined
  return ['Stopping this hook stops the turn: use Stop.', detail.join(' · ')].filter(Boolean).join(' ')
}

/**
 * The row's presence and its Cancel: `message` is the notice up now, or
 * undefined once it went down, when the row still fades out with what it
 * said last. `onError` says a refused Cancel where the surface says errors.
 */
export function useHookRow(sessionId: string, message: ChatMessage | undefined, onError: (err: unknown) => void) {
  const { mounted, state } = usePresence(message !== undefined, HOOK_ROW_FADE_MS, HOOK_ROW_FADE_MS)
  const [shown, setShown] = useState(message)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (message) setShown(message)
  }, [message])
  // A new notice is a new row: whatever the last one's Cancel was doing is
  // over. A row fading out keeps what its Cancel said.
  const id = message?.id
  useEffect(() => {
    if (id !== undefined) setBusy(false)
  }, [id])
  const cancel = () => {
    if (busy || !shown) return
    setBusy(true)
    api
      .interrupt(sessionId, { stopHookNotice: shown.id })
      .catch(onError)
      .finally(() => setBusy(false))
  }
  const row = message ?? shown
  return {
    row: mounted && row ? row : null,
    leaving: message === undefined,
    visible: state === 'entered',
    busy,
    cancel,
  }
}

/** 1d: the steady ‖ hold glyph — two bars, never animated. */
export function HoldGlyph({ phone = false }: { phone?: boolean }) {
  const bar = `block w-[2px] rounded-[1px] bg-current ${phone ? 'h-[10px]' : 'h-[9px]'}`
  return (
    <span aria-hidden className="flex gap-[2px]">
      <span className={bar} />
      <span className={bar} />
    </span>
  )
}

/** The fade both rows share: opacity only, and none under reduced motion. Its duration is `HOOK_ROW_FADE_MS`, spelled out for Tailwind. */
export function hookRowFade(visible: boolean, leaving: boolean): string {
  return [
    'motion-safe:transition-opacity motion-safe:duration-[200ms] motion-safe:ease-out',
    visible ? 'opacity-100' : 'opacity-0',
    leaving ? 'pointer-events-none' : '',
  ].join(' ')
}

/** The Mac's row (1d MAC PROPOSED): one line, 33 px, the command truncated first. */
export function HookNotice({ sessionId, message }: { sessionId: string; message: ChatMessage | undefined }) {
  const live = useHookRow(sessionId, message, (err: unknown) => reportError(err, 'Could not cancel the Stop hook'))
  if (!live.row) return null
  const { lead, detail, cancellable } = hookRowOf(live.row)
  return (
    <div
      data-hook-notice
      title={hookRowTip(live.row)}
      inert={live.leaving || undefined}
      className={[
        'flex items-center gap-[9px] rounded-[8px] border py-[6px] pl-[11px] pr-2',
        'shadow-[inset_0_1px_0_color-mix(in_oklab,_var(--color-highlight)_6%,_transparent)]',
        hookRowFade(live.visible, live.leaving),
      ].join(' ')}
      style={ROW_TINT}
    >
      <span className="grid w-[10px] flex-none place-items-center self-center" style={{ color: WORKING }}>
        <HoldGlyph />
      </span>
      <span className="min-w-0 flex-1 truncate fs-12.5 font-semibold leading-[1.5] text-ink-100">
        {lead}
        {detail.length > 0 && (
          <span className="font-mono fs-11 font-normal text-ink-900/60"> · {detail.join(' · ')}</span>
        )}
      </span>
      {cancellable && (
        <Button
          variant="muted-chip"
          size="row-action"
          // 1d: the −2px margin keeps the row at its text's height.
          className="-my-[2px] -mr-[2px] shrink-0"
          title="Stops the hook. Its check won't finish."
          onClick={live.cancel}
          disabled={live.busy}
        >
          {live.busy ? 'Cancelling' : 'Cancel'}
        </Button>
      )}
    </div>
  )
}

/**
 * Under the messages that wait for the hooks, once for the group (1a, 1g):
 * the row's ‖ and how many wait for what.
 */
export function HookWaitCaption({ hook, count, phone = false }: { hook: Pick<LiveHookNotice, 'event' | 'count'>; count: number; phone?: boolean }) {
  return (
    <div
      data-hook-wait-caption
      className={[
        'flex items-center justify-end gap-[7px] pr-1 font-mono text-ink-900/60',
        phone ? 'fs-11' : 'fs-10.5',
      ].join(' ')}
    >
      <span style={{ color: WORKING }}>
        <HoldGlyph phone={phone} />
      </span>
      {hookWaitCaption(hook, count)}
    </div>
  )
}

/** What the waiting messages wait for: the notice's hooks, or Stop hooks from a Mac that predates `hook`. */
export function waitedFor(message: ChatMessage): Pick<LiveHookNotice, 'event' | 'count'> {
  return message.notice?.hook ?? { event: STOP_HOOK_EVENT, count: /hooks running/.test(message.text ?? '') ? 2 : 1 }
}
