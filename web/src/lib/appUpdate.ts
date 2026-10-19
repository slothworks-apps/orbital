import { updateAvailableLine } from '@orbital/shared/remote/groupWords'
import type { UpdateAction, UpdateCheckAnswer, UpdateExtras, UpdatePrompt, UpdateReceipt } from './desktop'

/**
 * The desktop app's update, in words: what the notice toast's UPDATE kind
 * says in each state, and what Settings › Updates says about the last check
 * (canvas `Feature - App update`; spec 2026-10-08-builds-for-testers-design
 * § The desktop app updates itself).
 */

/**
 * Settings › Updates › "Download updates automatically". On only for the
 * literal 'true'; the server seeds 'false'. The desktop's main process reads
 * the same key (`desktop/src/lib/updates.ts` `AUTO_DOWNLOAD_KEY`).
 */
export const AUTO_DOWNLOAD_KEY = 'update_auto_download'

export function autoDownloadOn(settings: Record<string, string | undefined>): boolean {
  return settings[AUTO_DOWNLOAD_KEY] === 'true'
}

/** The installed version's release on GitHub; the release workflow tags it `v<version>`. */
export function releaseNotesUrl(version: string): string {
  return `https://github.com/slothworks-apps/orbital/releases/tag/v${version}`
}

export interface UpdateNoticeButton {
  label: string
  action: UpdateAction
}

/** One state of the prompt, ready to draw in the toast's shell. */
export interface UpdateNoticeContent {
  /** The mono head. */
  label: string
  text: string
  /** The download line (state 2): how far, and the readout beside it. */
  progress?: { percent: number; readout: string }
  /** The quiet text button, left of the primary. */
  secondary?: UpdateNoticeButton
  primary?: UpdateNoticeButton
  /** × and what it does; absent where the canvas has no ×. */
  close?: UpdateNoticeButton
}

const workingSessions = (n: number): string => (n === 1 ? '1 working session' : `${n} working sessions`)

/**
 * Whether the UPDATE message is on the map. Not while waiting: whoever chose
 * to restart when sessions finish has decided, and the wait — with its
 * Cancel — lives in Settings › Updates instead.
 */
export function updateNoticeOnMap(prompt: UpdatePrompt): boolean {
  return prompt.phase !== 'none' && prompt.phase !== 'waiting'
}

/** "the last working session finishes" — what a waiting restart waits for. */
function waitingFor(workingCount: number): string {
  return workingCount <= 1 ? 'the last working session finishes' : `the ${workingCount} working sessions finish`
}

/** `38 of 92 MB` beside the download line; empty when the size is not known. */
function downloadReadout(percent: number, totalMB: number): string {
  return totalMB > 0 ? `${Math.round((totalMB * percent) / 100)} of ${totalMB} MB` : ''
}

/**
 * What the restart of a member's update stops here (canvas 50v 01): `the 2
 * running sessions here stop`. Null when nothing works, and the sentence
 * ends at the restart.
 */
function stopsHere(working: number): string | null {
  if (working <= 0) return null
  return working === 1 ? 'the running session here stops' : `the ${working} running sessions here stop`
}

/** 50v 02's second sentence: ` The 2 running sessions stop now.`; empty when nothing works. */
function stopsNow(working: number): string {
  if (working <= 0) return ''
  return working === 1 ? ' The running session stops now.' : ` The ${working} running sessions stop now.`
}

/**
 * The canvas's states on the map. Null for `none` and `waiting`, which are
 * not on it, and for `restarting`, where the toast keeps what it last showed
 * until the app quits — except the restart of an update another member
 * started, which says so in its last line (canvas 50v 02).
 *
 * A download another member started (50v 01) names it in the head and the
 * line, and asks nothing: no actions, no ×.
 */
export function updateNoticeContent(prompt: UpdatePrompt & UpdateExtras): UpdateNoticeContent | null {
  const remote = prompt.remote ?? null
  if (prompt.phase === 'restarting' && remote) {
    return {
      label: `UPDATE · ORBITAL ${prompt.version} · RESTARTING`,
      text: `Restarting on ${prompt.version} · started on ${remote.by}.${stopsNow(remote.working)}`,
    }
  }
  if (prompt.phase === 'none' || prompt.phase === 'waiting' || prompt.phase === 'restarting') return null
  const v = prompt.version
  const head = `UPDATE · ORBITAL ${v}`
  const closeReady: UpdateNoticeButton = {
    label: `Close · Orbital ${v} installs when you quit Orbital`,
    action: 'close',
  }
  switch (prompt.phase) {
    case 'available':
      return {
        label: head,
        text: `Orbital ${v} is available. Nothing is downloaded until you ask.`,
        primary: { label: 'Download', action: 'download' },
        close: { label: `Skip ${v} · a newer version is offered again`, action: 'skip' },
      }
    case 'downloading': {
      const progress = { percent: prompt.percent, readout: downloadReadout(prompt.percent, prompt.totalMB) }
      if (remote) {
        const stops = stopsHere(remote.working)
        return {
          label: `${head} · STARTED ON ${remote.by.toUpperCase()}`,
          text: `${remote.by} is updating this Mac to ${v}. When the download finishes, Orbital restarts${
            stops ? ` and ${stops}` : ''
          }.`,
          progress,
        }
      }
      return {
        label: `${head} · DOWNLOADING`,
        text: `Downloading Orbital ${v}. Sessions keep running.`,
        progress,
      }
    }
    case 'ready':
      if (prompt.buttons === 'one') {
        return {
          label: head,
          text: `Orbital ${v} is downloaded. No session is working, so restarting interrupts nothing.`,
          // Restarts at once when nothing works — and waits, rather than
          // interrupting, if a session started since the prompt appeared.
          primary: { label: 'Restart', action: 'restart-when-idle' },
          close: closeReady,
        }
      }
      return {
        label: head,
        text:
          prompt.workingCount > 0
            ? `Orbital ${v} is downloaded. Restarting now interrupts ${workingSessions(prompt.workingCount)}.`
            : `Orbital ${v} is downloaded. No session is working now, so restarting interrupts nothing.`,
        secondary: { label: 'Restart now', action: 'restart-now' },
        primary: { label: 'Restart when sessions finish', action: 'restart-when-idle' },
        close: closeReady,
      }
    case 'closed':
      return {
        label: head,
        text: `Orbital ${v} installs when you quit Orbital.`,
        primary: { label: 'OK', action: 'ok' },
      }
  }
}

/** `14:02`: when a member updated this Mac, as the receipt and Settings › Updates say it. */
export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

/**
 * The line heading WHAT’S NEW after an update another member made (canvas
 * 50v 04): who, when, and how many sessions it stopped — the second
 * sentence only when it stopped any. The release notes follow it
 * (`panels/WhatsNew`), whose end clears the receipt (`receipt-close`).
 */
export function receiptLine(receipt: UpdateReceipt, clock: (at: number) => string = clockTime): string {
  const n = receipt.stopped
  const stopped = n <= 0 ? '' : n === 1 ? ' The session running then was stopped.' : ` The ${n} sessions running then were stopped.`
  return `${receipt.by} updated this Mac at ${clock(receipt.at)}.${stopped}`
}

/**
 * This Mac's own row in Settings → Devices (canvas 50u A) while an update
 * another member started runs here, or waits after a session started here
 * (canvas 50v): the version the third line points to (`0.35.2 → 0.36.0`),
 * the line under the row, and whether it links to Settings › Updates. Null
 * otherwise: the row says what it always does.
 */
export function selfUpdateStrip(
  state: (UpdatePrompt & UpdateExtras) | null,
): { to: string | null; line: string; link: boolean } | null {
  if (!state) return null
  const remote = state.remote ?? null
  if (state.phase === 'downloading' && remote) {
    return { to: state.version, line: `updating to ${state.version} · started on ${remote.by}`, link: true }
  }
  if (state.phase === 'restarting' && remote) {
    return {
      to: state.version,
      line: remote.working > 0 ? `restarting on ${state.version} · sessions here stop now` : `restarting on ${state.version}`,
      link: false,
    }
  }
  if (state.phase === 'ready' && state.sessionStarted) {
    return { to: null, line: `${updateAvailableLine(state.version)} · downloaded`, link: true }
  }
  return null
}

/** "2 h", "12 min", "3 d" — how long ago the last check was. */
function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h`
  return `${Math.floor(hours / 24)} d`
}

/**
 * Settings › Updates' result line under Check now: what this visit's check
 * found and what became of it, the one running now, a restart waiting for
 * sessions to finish, a prompt already on the map, or when the last check was.
 * An update another member started says what the map prompt says (canvas
 * 50v): its download, its restart, that it waits here after a session
 * started, and after the restart, who updated this Mac and when.
 */
export function updateCheckLine({
  checking,
  answer,
  prompt,
  checkedAt,
  now,
  clock = clockTime,
}: {
  checking: boolean
  /** What this visit's Check now found, if it pressed it. */
  answer: UpdateCheckAnswer | null
  prompt: UpdatePrompt & UpdateExtras
  checkedAt: number | null
  now: number
  clock?: (at: number) => string
}): string {
  if (checking) return 'Checking…'
  if (answer?.kind === 'error') return 'Could not check · try again later'
  if (answer?.kind === 'unsupported') return 'This build does not update itself'
  const remote = prompt.remote ?? null
  if (prompt.phase === 'downloading' && remote) {
    const readout = downloadReadout(prompt.percent, prompt.totalMB)
    return `Updating to ${prompt.version} · started on ${remote.by}${readout ? ` · ${readout}` : ''}`
  }
  if (prompt.phase === 'restarting' && remote) return `Restarting on ${prompt.version} · started on ${remote.by}`
  if (prompt.phase === 'ready' && prompt.sessionStarted) {
    return `Orbital ${prompt.version} is downloaded · a session started here, so it waits for you`
  }
  if (answer?.kind === 'found') {
    const v = answer.version
    switch (answer.outcome) {
      case 'downloading':
        return `Orbital ${v} found · downloading; the prompt appears on the map when it is ready`
      case 'installs-on-quit':
        return `Orbital ${v} is downloaded · installs when you quit Orbital`
      case 'held':
      case 'skipped':
        return `Orbital ${v} found · offered after Orbital restarts`
      // The version the prompt is about: where the prompt has gone since —
      // waiting, restarting — wins; the answer can land before the prompt.
      case 'offered':
      case 'none':
        if (prompt.phase !== 'waiting' && prompt.phase !== 'restarting') return `Orbital ${v} found · offered on the map`
        break
      case 'waiting':
        break
    }
  }
  if (prompt.phase === 'restarting') return `Orbital ${prompt.version} · restarting`
  if (prompt.phase === 'waiting') return `Orbital ${prompt.version} restarts when ${waitingFor(prompt.workingCount)}`
  if (prompt.phase !== 'none') return `Orbital ${prompt.version} found · offered on the map`
  if (prompt.receipt) return `Up to date · updated from ${prompt.receipt.by} at ${clock(prompt.receipt.at)}`
  if (checkedAt === null) return 'Not checked yet'
  const elapsed = Math.max(0, now - checkedAt)
  return elapsed < 60_000 ? 'Checked just now · up to date' : `Checked ${ago(elapsed)} ago · up to date`
}
