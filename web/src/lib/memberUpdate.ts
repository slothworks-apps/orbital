/**
 * Updating a member from Settings → Devices (canvas `Feature - Remote
 * update` 50q–50t; spec 2026-10-19-headless-server-design § Updating from
 * the group): what this device knows of each member's update, how a read or
 * a start moves it, and what the member's row says about it — on the
 * desktop's row and line, and on the phone's row and its sheet. Pure: the
 * reads, the timer and the screens are elsewhere (`useMemberUpdates`).
 *
 * Only the words change. No spinner, no countdown, no percentage, and
 * nothing outside Settings → Devices.
 */
import { updateAvailableLine, updateFailedLine, updateFailedWhy } from '@orbital/shared/remote/groupWords'
import {
  UPDATE_TIMEOUT_MS, updateIsNewer, watchUpdate, watchVerdict, type ServerUpdateRefusal, type ServerUpdateState,
  type UpdateAsker, type UpdateFailReason, type UpdateWatch,
} from '@orbital/shared/remote/serverUpdate'

/**
 * An update being watched from here: the version it started on, the one it
 * brings, and who started it. `unconfirmed`: a start whose answer never came
 * — it may have landed, or not — read again on the poll until a read says
 * which; the row shows only what the reads say meanwhile.
 */
export type MemberWatch = UpdateWatch & { target: string; from: UpdateAsker | null; unconfirmed?: true }

/** What this device knows of one member's update. */
export interface MemberUpdate {
  /** The member's last answer; kept while it cannot be read. Null before the first. */
  state: ServerUpdateState | null
  /** The last read reached it. */
  reachable: boolean
  /** An update started here (a 202) or seen `updating`, until it is back or the wait runs out. */
  watch: MemberWatch | null
  /** It went away for an update and was not back within the wait; until it answers again. */
  timedOut: MemberWatch | null
  /** The version an update watched here was meant to bring, when it came back without it. */
  failed: string | null
  /** Why it failed, when the member said (`ServerUpdateState.failedReason`). */
  failedReason: UpdateFailReason | null
  /** A start the member refused for a reason no read shows, until the next start. */
  refused: Extract<ServerUpdateRefusal, 'not_set_up' | 'not_packaged'> | null
}

const NOTHING: MemberUpdate = {
  state: null, reachable: false, watch: null, timedOut: null, failed: null, failedReason: null, refused: null,
}

function watchOf(state: ServerUpdateState, now: number): MemberWatch {
  return { ...watchUpdate(state, now), target: state.candidate ?? state.installed, from: state.startedBy }
}

/**
 * A read of the member: `latest` is its answer, null when it could not be
 * read (offline, or restarting). While an update is watched, the watch's
 * verdict decides (`watchVerdict`); a member that never answered within the
 * wait has timed out. Otherwise the member's own answer is the truth, and a
 * timed-out member that answers again is no longer timed out.
 */
export function applyRead(prev: MemberUpdate | undefined, latest: ServerUpdateState | null, now: number): MemberUpdate {
  const u = prev ?? NOTHING
  if (u.watch?.unconfirmed) {
    // Only an answer settles a start that was not answered; with none, it is read again until the wait runs out.
    if (latest === null) {
      return { ...u, reachable: false, watch: now - u.watch.since >= UPDATE_TIMEOUT_MS ? null : u.watch }
    }
    return applyRead({ ...u, watch: null }, latest, now)
  }
  if (u.watch) {
    const verdict = watchVerdict(u.watch, latest, now)
    if (verdict === 'updating') {
      return {
        ...u,
        state: latest ?? u.state,
        reachable: latest !== null,
        watch: latest?.startedBy ? { ...u.watch, from: latest.startedBy } : u.watch,
      }
    }
    if (verdict === 'updated') {
      return { ...u, state: latest, reachable: true, watch: null, timedOut: null, failed: null, failedReason: null }
    }
    if (latest === null) return { ...u, reachable: false, watch: null, timedOut: u.watch }
    return {
      ...u, state: latest, reachable: true, watch: null, timedOut: null,
      failed: latest.failed ?? u.watch.target, failedReason: latest.failedReason ?? null,
    }
  }
  if (latest === null) return { ...u, reachable: false }
  return {
    ...u,
    state: latest,
    reachable: true,
    watch: latest.updating ? watchOf(latest, now) : null,
    timedOut: null,
    failed: latest.failed,
    failedReason: latest.failedReason ?? null,
  }
}

/**
 * A start whose answer never came (its bound ran out): it may have reached
 * the member. The member is watched, unconfirmed, so the poll reads it again
 * and the row shows `updating` as soon as a read says so — or stays as it was
 * when a read says it is not. A member never read has nothing to watch from.
 */
export function applyStartUnanswered(prev: MemberUpdate | undefined, now: number): MemberUpdate {
  const u = prev ?? NOTHING
  if (u.state === null || u.watch) return u
  return { ...u, watch: { ...watchOf(u.state, now), from: null, unconfirmed: true } }
}

/** A start's answer: the start function's, which is null for a member that does not serve the route. */
export type StartAnswer = { ok: true; state: ServerUpdateState } | { ok: false; error: ServerUpdateRefusal }

/**
 * A start's answer applied: a 202 is watched from its own state. `updating`
 * (someone else started one) and `no_update` (the member moved on) are
 * shown by reading it again (`reread`); the two a read cannot show are kept.
 */
export function applyStart(
  prev: MemberUpdate | undefined, answer: StartAnswer, now: number,
): { next: MemberUpdate; reread: boolean } {
  const u = { ...(prev ?? NOTHING), refused: null }
  if (answer.ok) {
    return {
      next: {
        ...u, state: answer.state, reachable: true, watch: watchOf(answer.state, now), timedOut: null, failed: null,
        failedReason: null,
      },
      reread: false,
    }
  }
  if (answer.error === 'updating' || answer.error === 'no_update') return { next: u, reread: true }
  return { next: { ...u, refused: answer.error }, reread: false }
}

/** Where an update stands as the row says it. */
export type UpdatePhase = 'idle' | 'available' | 'installing' | 'restarting' | 'failed' | 'timeout'

/**
 * `installing` while the member still answers, `restarting` once it does
 * not (canvas 50t UPDATING); `timeout` after the wait; `failed` when it came
 * back on the old version; `available` when it has a newer release.
 * `online`: the member's presence lets it be asked now.
 */
export function updatePhase(u: MemberUpdate | undefined, online: boolean): UpdatePhase {
  if (!u) return 'idle'
  if (u.watch && !u.watch.unconfirmed) return online && u.reachable ? 'installing' : 'restarting'
  if (u.timedOut) return 'timeout'
  if (u.failed !== null && u.state && !u.state.updating) return 'failed'
  if (u.state && updateIsNewer(u.state.installed, u.state.candidate)) return 'available'
  return 'idle'
}

/** 0 sessions there: one press starts it. 1 or more: the inline confirm names the count and the device first. */
export function updateNeedsConfirm(u: MemberUpdate | undefined): boolean {
  return (u?.state?.sessions ?? 0) > 0
}

/** Said in place, never as a toast, when a press could not reach the member (not in the canvas). */
export const UPDATE_UNREACHABLE = 'Couldn’t reach it to start the update. Try again.'

/** What a press of Update or Try again does, decided on a fresh read. */
export type StartDecision = 'confirm' | 'start' | 'unreachable' | 'none'

/**
 * Update and Try again read the member again first and decide on that
 * answer, never on an older one: `fresh` null (the read failed) is
 * `unreachable`, and nothing starts; a member that is no longer offered an
 * update (someone else started it, or it is current now) is `none`, and its
 * row already says why; otherwise the sessions it runs now decide whether
 * to ask first.
 */
export function startDecision(fresh: MemberUpdate | null, online: boolean): StartDecision {
  if (fresh === null || !fresh.reachable || fresh.state === null) return 'unreachable'
  const phase = updatePhase(fresh, online)
  if (phase !== 'available' && phase !== 'failed') return 'none'
  return updateNeedsConfirm(fresh) ? 'confirm' : 'start'
}

/**
 * The confirm's Update, decided on a fresh read as a press is: `shown` is
 * the session count the confirm named. More sessions there now than it
 * named is `confirm` again, with the new count, rather than a start the
 * user agreed to for fewer; the same or fewer starts. The member decides at
 * the landing only against the sessions working when the request arrived.
 */
export function confirmDecision(shown: number, fresh: MemberUpdate | null, online: boolean): StartDecision {
  const decision = startDecision(fresh, online)
  if (decision === 'unreachable' || decision === 'none') return decision
  return (fresh?.state?.sessions ?? 0) > shown ? 'confirm' : 'start'
}

export interface UpdateRowInput {
  name: string
  kind: string
  /** Its presence lets it be asked: online, linked and not too old. */
  online: boolean
  /** The row's own state words (`online`, `asleep · seen 2 h ago`). */
  words: string
  /** The version its hello named, shown until a read gives the installed one. */
  helloVersion: string | null
  /** This device's id: `started on …` is said only where it did not start the update. */
  selfId: string | null
  /** The phone says `wakes` where the desktop says `is online`, and has its own state line. */
  surface: 'desktop' | 'phone'
}

/** The line under a desktop row (canvas 50q, 50t), and the same words in the phone's sheet (50s). */
export interface UpdateLine {
  text: string
  /** The quiet second line: who started it, where to look, or why Update is not offered yet. */
  sub: string | null
  /** `update available` reads in the brighter ink; every other line in the muted one. */
  bright: boolean
  /** The phone sheet's heading for the same state. */
  head: string
  action: 'update' | 'retry' | null
}

export interface UpdateRow {
  phase: UpdatePhase
  /** `0.35.2`, or `0.35.2 → 0.36.0` while updating; null when not known. */
  version: string | null
  /** The state words: `updating` and the like replace the row's own while an update says so. */
  words: string
  /**
   * The dot instead of the row's own: dashed while updating (the `linking`
   * family — never the offline ring), the ring after a timeout. Null leaves the row's own.
   */
  dot: 'linking' | 'offline' | null
  /** The row reads as away: name and state in the dim ink. Never during an update. */
  dim: boolean | null
  line: UpdateLine | null
}

/** Where to look after a failed update, on the member itself (canvas 50t FAILED). */
function whereToLook(name: string, kind: string): string {
  return `on ${name}: ${kind === 'headless' ? 'journalctl -u orbital-update' : 'Settings → Updates'}`
}

/** A refusal no read shows (not in the canvas: the CLI's words for the same refusals). */
function refusedSub(refused: NonNullable<MemberUpdate['refused']>, name: string): string {
  return refused === 'not_set_up' ? `not set up for updates · on ${name}: orbital setup` : `${name} can’t update itself`
}

/**
 * A member's row as its update says it (canvas 50t, logic `model()`): the
 * phase, the version, the state words and dot, and the line under the row.
 * A phone's row says nothing about updates but its version: its store
 * updates it.
 */
export function updateRow(u: MemberUpdate | undefined, input: UpdateRowInput): UpdateRow {
  const { name, kind, online, words, surface } = input
  const installed = u?.state?.installed ?? input.helloVersion
  if (kind === 'phone') return { phase: 'idle', version: installed, words, dot: null, dim: null, line: null }
  const phase = updatePhase(u, online)
  const reach = online && (u?.reachable ?? false) && u?.state !== null
  const watch = u?.watch ?? null
  const from = watch?.from && watch.from.id !== input.selfId ? `started on ${watch.from.name}` : null
  const failedOn = u?.state?.installed ?? installed ?? ''

  switch (phase) {
    case 'installing':
    case 'restarting': {
      const target = watch!.target
      const line: UpdateLine = phase === 'installing'
        ? {
          text: `installing ${target} · ${kind === 'headless' ? 'apt' : 'its updater'}`,
          sub: from, bright: false, head: `Installing ${target}`, action: null,
        }
        : {
          text: 'restarting · offline until it’s back',
          sub: from, bright: false, head: `Restarting on ${target} · offline until it’s back`, action: null,
        }
      return {
        phase,
        version: `${watch!.installed} → ${target}`,
        words: surface === 'phone' ? `updating to ${target}` : 'updating',
        dot: 'linking',
        dim: false,
        line,
      }
    }
    case 'timeout':
      return {
        phase,
        version: installed,
        words: surface === 'phone' ? 'offline · since the update' : 'offline',
        dot: 'offline',
        dim: true,
        line: {
          text: 'didn’t come back after the update', sub: whereToLook(name, kind), bright: false,
          head: `${name} didn’t come back after the update`, action: null,
        },
      }
    case 'failed':
      return {
        phase,
        version: installed,
        words: surface === 'phone' && online ? 'online · update didn’t finish' : words,
        dot: null,
        dim: null,
        line: {
          text: updateFailedLine(failedOn),
          sub: updateFailedWhy(u?.failedReason, name) ?? whereToLook(name, kind),
          bright: false,
          head: `The update didn’t finish · still on ${failedOn}`, action: reach ? 'retry' : null,
        },
      }
    case 'available': {
      const candidate = u!.state!.candidate!
      const later = `Update shows once ${name} ${surface === 'phone' ? 'wakes' : 'is online'}`
      return {
        phase,
        version: installed,
        words: surface === 'phone' ? `${words} · update available${reach ? ` · ${candidate}` : ''}` : words,
        dot: null,
        dim: null,
        line: {
          text: updateAvailableLine(candidate),
          sub: !reach ? later : u!.refused ? refusedSub(u!.refused, name) : null,
          bright: true,
          head: `Update available · ${candidate}`,
          action: reach ? 'update' : null,
        },
      }
    }
    case 'idle':
      return { phase, version: installed, words, dot: null, dim: null, line: null }
  }
}

/**
 * This device's own row on a Mac (canvas 50u A): only `update available ·
 * 0.36.0`, pointing at Settings → Updates, which owns this Mac's install —
 * no Update here. The version a newer release brings; null for none, and
 * while it is already updating.
 */
export function selfUpdateAvailable(u: MemberUpdate | undefined): string | null {
  const state = u?.state
  if (!state || state.updating || !updateIsNewer(state.installed, state.candidate)) return null
  return state.candidate
}
