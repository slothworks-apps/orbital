import type { UpdateAction, UpdateCheckAnswer, UpdatePrompt } from './desktop'

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
 * The canvas's six states. Null for `none`, and for `restarting`, where the
 * toast keeps what it last showed until the app quits.
 */
export function updateNoticeContent(prompt: UpdatePrompt): UpdateNoticeContent | null {
  if (prompt.phase === 'none' || prompt.phase === 'restarting') return null
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
      const mb = prompt.totalMB
      return {
        label: `${head} · DOWNLOADING`,
        text: `Downloading Orbital ${v}. Sessions keep running.`,
        progress: {
          percent: prompt.percent,
          readout: mb > 0 ? `${Math.round((mb * prompt.percent) / 100)} of ${mb} MB` : '',
        },
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
    case 'waiting':
      return {
        label: `${head} · WAITING`,
        text: `Orbital restarts when ${
          prompt.workingCount <= 1 ? 'the last working session finishes' : `the ${prompt.workingCount} working sessions finish`
        }.`,
        secondary: { label: 'Cancel', action: 'cancel-wait' },
      }
    case 'closed':
      return {
        label: head,
        text: `Orbital ${v} installs when you quit Orbital.`,
        primary: { label: 'OK', action: 'ok' },
      }
  }
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
 * Settings › Updates' result line under Check now: what the last check
 * found, the one running now, or when the last one was.
 */
export function updateCheckLine({
  checking,
  answer,
  prompt,
  checkedAt,
  autoDownload,
  now,
}: {
  checking: boolean
  /** What this visit's Check now found, if it pressed it. */
  answer: UpdateCheckAnswer | null
  prompt: UpdatePrompt
  checkedAt: number | null
  autoDownload: boolean
  now: number
}): string {
  if (checking) return 'Checking…'
  if (answer?.kind === 'error') return 'Could not check · try again later'
  if (answer?.kind === 'unsupported') return 'This build does not update itself'
  const found = answer?.kind === 'found' ? answer.version : prompt.phase !== 'none' ? prompt.version : null
  if (found) {
    // Downloading by itself shows nothing on the map until it is ready.
    return autoDownload && prompt.phase === 'none'
      ? `Orbital ${found} found · downloading; the prompt appears on the map when it is ready`
      : `Orbital ${found} found · offered on the map`
  }
  if (checkedAt === null) return 'Not checked yet'
  const elapsed = Math.max(0, now - checkedAt)
  return elapsed < 60_000 ? 'Checked just now · up to date' : `Checked ${ago(elapsed)} ago · up to date`
}
