import { continuesAtReset, formatResetAt, formatResetPhrase, limitWaitCopy, type LimitNoticeAction } from '../../lib/limits'
import type { LimitWait } from '../../lib/types'
import { UNNAMED_MAC } from '../composer'

/**
 * The words of the phone's limit notice (spec 2026-10-05-mobile-next § 5;
 * canvas 10k, 10l "LIMIT NOTICE · FOUR STATES"). Pure; `session/LimitNotice`
 * draws it. The live states are the desktop's own copy (`limitWaitCopy`),
 * fed the Mac's two settings off the wait itself — the phone cannot read the
 * settings. The fourth state, the divider a fired wait folds into, is the
 * transcript's own row.
 *
 * Every time is absolute; nothing counts down (spec § 8 Decision 9).
 */

/** Under each queued bubble (canvas 10k `wQueueNote`). */
export const QUEUED_NOTE = 'queued · sent at the reset'

export type PhoneLimitNotice =
  | {
      kind: 'live'
      /** "Limit reached, continues at 14:05" / "…, resets at 14:05". */
      title: string
      /** "5-hour window · then sends “continue”", or what replaces the send. */
      sub: string
      /** The quiet line beside the button: "5-hour window · 100% · resets 14:05". */
      meta: string
      /** Cancel while it will continue, Undo once cancelled, nothing with auto-continue off. */
      action: LimitNoticeAction
    }
  | {
      /** The Mac asleep (canvas 10k, second phone): no button, the reset needs the Mac awake. */
      kind: 'asleep'
      title: string
      /** Why the time is not a promise; absent when the reset sends nothing anyway. */
      body: string | null
      /** "5-hour window · auto-continue on · 1 queued". */
      meta: string
    }

export interface LimitNoticeInput {
  offline: boolean
  macName: string | null
  now: number
}

export function phoneLimitNotice(wait: LimitWait, { offline, macName, now }: LimitNoticeInput): PhoneLimitNotice {
  const copy = limitWaitCopy(wait, undefined, now)
  if (offline) {
    const auto =
      copy.action === 'cancel' ? 'auto-continue on' : copy.action === 'undo' ? 'auto-continue cancelled' : 'auto-continue off'
    const queued = wait.queued.length
    return {
      kind: 'asleep',
      title: `Limit resets ${formatResetPhrase(wait.resetsAt, now)}`,
      body: continuesAtReset(wait)
        ? `It continues only if ${macName ?? UNNAMED_MAC} is awake then. Asleep, it stays waiting and continues when the Mac wakes.`
        : null,
      meta: [wait.windowLabel, auto, queued > 0 ? `${queued} queued` : null].filter(Boolean).join(' · '),
    }
  }
  return {
    kind: 'live',
    title: copy.title,
    sub: copy.sub,
    // A wait opens only on a full window, so its share is always the whole of it.
    meta: `${wait.windowLabel} · 100% · resets ${formatResetAt(wait.resetsAt, now)}`,
    action: copy.action,
  }
}

/** The notice's footer key: changes with every word it shows. */
export function limitNoticeKey(wait: LimitWait, offline: boolean): string {
  return [
    'limit', wait.resetsAt, wait.cancelled, wait.willContinue, wait.autoContinue ?? '-', wait.continueText ?? '-',
    wait.queued.length, offline ? 'asleep' : 'live',
  ].join(':')
}
