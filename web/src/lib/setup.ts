import { WORKTREES_DIR, type SessionSetup } from '@orbital/shared/worktree'
import { deviceOf } from './devices'
import { homePath } from './format'
import type { ApiSession, PermissionMode } from './types'

/**
 * A worktree made in the background (spec
 * 2026-11-09-worktree-setup-in-background-design; canvas `Feature - Worktree
 * in background` 66a–66d): what the desktop and the phone say about a
 * session whose `setup` has not reached `ready`. Pure — the setup block, the
 * Desk card, the phone row and the discard dialog only draw it.
 */

/** How many steps setup has: naming the branch, checking out, copying local files. */
export const SETUP_STEPS = 3

/** The first prompt, then each queued message, as they are listed (the order they go out in). */
export function setupTexts(setup: Pick<SessionSetup, 'prompt' | 'queued'>): string[] {
  return [setup.prompt, ...setup.queued.map((q) => q.text)].filter((text) => text.trim() !== '')
}

/** Copy prompt: the first prompt and the queued messages as one text, a blank line between each. */
export function setupPromptText(setup: Pick<SessionSetup, 'prompt' | 'queued'>): string {
  return setupTexts(setup).join('\n\n')
}

/** Every attachment the prompt and the queued messages carry, in their order, each once. */
export function setupAttachments(setup: Pick<SessionSetup, 'attachments' | 'queued'>): string[] {
  return [...new Set([...setup.attachments, ...setup.queued.flatMap((q) => q.attachments ?? [])])]
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** The discard dialog's sentence (66c, 66d): what stops, and what goes with the session. */
export function discardSentence(setup: Pick<SessionSetup, 'phase' | 'queued'>): string {
  const what =
    setup.phase === 'failed'
      ? 'Nothing was set up and nothing is on disk.'
      : 'Setup stops and nothing is left on disk.'
  const n = setup.queued.length
  return n === 0
    ? `${what} The first prompt goes with it.`
    : `${what} The first prompt and ${plural(n, 'queued message')} go with it.`
}

/** How long setup took, as the ready block says it: "14 s", "2 min 05 s". */
export function readyInLabel(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`
}

/** One line of the setup block: its glyph, its words, a mono tail, and how far along it is. */
export interface SetupLine {
  glyph: '✓' | '•' | '○' | '!' | ''
  text: string
  /** The branch after "Branch", in mono. */
  mono?: string
  /** `now` the step running (full ink), `done` behind it, `pending` ahead, `error` the failure. */
  tone: 'now' | 'done' | 'pending' | 'error'
}

export interface SetupBlockModel {
  failed: boolean
  title: string
  /** "step 2 of 3", "ready in 14 s"; null for a failure, whose right side is Detail. */
  right: string | null
  lines: SetupLine[]
  /** The worktree's path, `~`-relative; null on a failure, whose row holds its ways out. */
  path: string | null
}

/**
 * The setup block (canvas 66c): one box of a fixed height in every state, so
 * nothing below it moves when it changes. While setting up the current step
 * is in full ink, the ones done carry ✓, the ones ahead stay muted; once
 * ready the same box says how long it took; a failure says why in one
 * sentence and what is kept.
 */
export function setupBlock(setup: SessionSetup): SetupBlockModel {
  const branch = (tone: SetupLine['tone']): SetupLine => ({ glyph: '✓', text: 'Branch ', mono: setup.branch ?? '', tone })
  // Until the directory is reserved its leaf is not known (66c 1).
  const path = homePath(setup.path ?? `${setup.launch.cwd}/${WORKTREES_DIR}/…`)
  switch (setup.phase) {
    case 'naming':
      return {
        failed: false,
        title: 'Setting up a worktree',
        right: `step 1 of ${SETUP_STEPS}`,
        lines: [
          { glyph: '•', text: 'Naming the branch', tone: 'now' },
          { glyph: '○', text: 'Check out the repository', tone: 'pending' },
          { glyph: '○', text: 'Copy local files', tone: 'pending' },
        ],
        path,
      }
    case 'checkout':
      return {
        failed: false,
        title: 'Setting up a worktree',
        right: `step 2 of ${SETUP_STEPS}`,
        lines: [
          branch('done'),
          { glyph: '•', text: 'Checking out the repository', tone: 'now' },
          { glyph: '○', text: 'Copy local files', tone: 'pending' },
        ],
        path,
      }
    case 'copy':
      return {
        failed: false,
        title: 'Setting up a worktree',
        right: `step 3 of ${SETUP_STEPS}`,
        lines: [
          branch('done'),
          { glyph: '✓', text: 'Checked out', tone: 'done' },
          { glyph: '•', text: 'Copying local files', tone: 'now' },
        ],
        path,
      }
    case 'ready':
      return {
        failed: false,
        title: 'Worktree ready',
        right: setup.readyInMs != null ? `ready in ${readyInLabel(setup.readyInMs)}` : null,
        lines: [branch('done'), { glyph: '✓', text: 'Checked out', tone: 'done' }, { glyph: '✓', text: 'Copied local files', tone: 'done' }],
        path,
      }
    case 'failed': {
      const n = setup.queued.length
      const kept =
        n === 0
          ? 'Nothing was left on disk. Your prompt is kept.'
          : `Nothing was left on disk. Your prompt and ${plural(n, 'queued message')} are kept.`
      return {
        failed: true,
        title: 'Couldn’t create the worktree',
        right: null,
        lines: [
          { glyph: '!', text: setup.message ?? 'Git refused to create the worktree.', tone: 'error' },
          { glyph: '', text: kept, tone: 'pending' },
        ],
        path: null,
      }
    }
  }
}

/** The branch where a session's header, card and row name it: italic while it is not known (66a). */
export function setupBranch(setup: Pick<SessionSetup, 'phase' | 'branch'>): { text: string; italic: boolean } {
  if (setup.phase === 'failed') return { text: 'no worktree', italic: true }
  if (setup.branch === null) return { text: 'naming…', italic: true }
  return { text: setup.branch, italic: false }
}

/** The Desk card's tool line (66b): the step, or that it did not start. */
export function setupToolLine(setup: Pick<SessionSetup, 'phase' | 'step'>): { name: string; arg: string } {
  if (setup.phase === 'failed') return { name: 'Not started', arg: 'couldn’t create the worktree' }
  const doing = setup.phase === 'naming' ? 'naming the branch' : setup.phase === 'checkout' ? 'checking out' : 'copying local files'
  return { name: 'Setting up', arg: `step ${setup.step} of ${SETUP_STEPS} · ${doing}` }
}

/** The phone row's note (66d). */
export function setupRowNote(setup: Pick<SessionSetup, 'phase' | 'step'>): string {
  return setup.phase === 'failed' ? 'Couldn’t create the worktree.' : `Setting up a worktree · step ${setup.step} of ${SETUP_STEPS}`
}

/**
 * The queued-turn bubble's caption (66c): the first prompt and the queue say
 * when they go out. Once started, the queue waits for the first reply.
 */
export function queuedCaption(setup: Pick<SessionSetup, 'phase'>, first: boolean): string {
  if (setup.phase === 'failed') return first ? 'first prompt · kept, not sent' : 'queued · kept, not sent'
  if (setup.phase === 'ready') return 'queued · sent after the first reply'
  return first ? 'first prompt · goes out when the session starts' : 'queued · sent when the session starts'
}

/** The composer while the session has not started (66c `composer`). */
export function setupComposer(setup: Pick<SessionSetup, 'phase'>): { placeholder: string; hint: string } {
  return setup.phase === 'failed'
    ? { placeholder: 'Queue a message…', hint: '⏎ queue · sent if a retry starts the session' }
    : { placeholder: 'Queue a message for when it starts…', hint: '⏎ queue · sent when the session starts · ⇧⏎ newline' }
}

/** The strip's end button and ⌘⌫ before the session runs: ending it discards it (66c STRIP). */
export function discardLabel(setup: Pick<SessionSetup, 'phase'>): string {
  return setup.phase === 'failed' ? 'Discard' : 'Cancel setup and discard'
}

/**
 * Without a worktree (spec § Ways out of NOT STARTED): New Session opened
 * with this session's settings, Worktree off, the first prompt with the
 * queued messages below it and all their attachments. `replaces` is the
 * session discarded once that launch is accepted.
 */
export interface NewSessionPrefill {
  replaces: string
  /** Its title, for the Claude directory's "from" hint. */
  title: string
  /** The device the session was launched on (`deviceOf`). */
  device: string
  cwd: string
  permissionMode: PermissionMode
  model: string | null
  tagId: number | null
  claudeDirId: number | null
  prompt: string
  attachments: string[]
}

export function withoutWorktreePrefill(
  session: Pick<ApiSession, 'id' | 'title' | 'machine'>,
  setup: SessionSetup,
): NewSessionPrefill {
  const { launch } = setup
  return {
    replaces: session.id,
    title: session.title,
    device: deviceOf(session),
    cwd: launch.cwd,
    permissionMode: launch.permissionMode as PermissionMode,
    model: launch.model ?? null,
    tagId: launch.tagId ?? null,
    claudeDirId: launch.claudeDirId ?? null,
    prompt: setupPromptText(setup),
    attachments: setupAttachments(setup),
  }
}
