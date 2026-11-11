import { WORKTREES_DIR, type LaunchHarnessPlan, type SessionSetup } from '@orbital/shared/worktree'
import { deviceOf } from './devices'
import { homePath } from './format'
import type { ApiSession, GitLocation, PermissionMode } from './types'

/**
 * A worktree made in the background (spec
 * 2026-11-09-worktree-setup-in-background-design; canvas `Feature - Worktree
 * in background` 66a–66d): what the desktop and the phone say about a
 * session whose `setup` has not reached `ready`. Pure — the setup block, the
 * Desk card, the phone row and the discard dialog only draw it.
 */

/** How many steps setup has: naming the branch, checking out, copying local files. */
const SETUP_STEPS = 3

/**
 * The step a setup still running is on. A phase this bundle does not know
 * (a newer Mac's, sent to an older phone) reads as setting up, at the step
 * the wire says.
 */
function runningStep(setup: Pick<SessionSetup, 'phase' | 'step'>): 1 | 2 | 3 {
  const phase: string = setup.phase
  if (phase === 'naming') return 1
  if (phase === 'checkout') return 2
  if (phase === 'copy') return 3
  return setup.step === 2 || setup.step === 3 ? setup.step : 1
}

/** The first prompt, then each queued message, as they are listed (the order they go out in). */
function setupTexts(setup: Pick<SessionSetup, 'prompt' | 'queued'>): string[] {
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
function readyInLabel(ms: number): string {
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
  if (setup.phase === 'ready')
    return {
      failed: false,
      title: 'Worktree ready',
      right: setup.readyInMs != null ? `ready in ${readyInLabel(setup.readyInMs)}` : null,
      lines: [branch('done'), { glyph: '✓', text: 'Checked out', tone: 'done' }, { glyph: '✓', text: 'Copied local files', tone: 'done' }],
      path,
    }
  if (setup.phase === 'failed') {
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
  // Setting up — and any phase this bundle does not know yet, which an older
  // phone reads as still running rather than failing to draw the block.
  const step = runningStep(setup)
  const lines: SetupLine[] =
    step === 1
      ? [
          { glyph: '•', text: 'Naming the branch', tone: 'now' },
          { glyph: '○', text: 'Check out the repository', tone: 'pending' },
          { glyph: '○', text: 'Copy local files', tone: 'pending' },
        ]
      : step === 2
        ? [
            branch('done'),
            { glyph: '•', text: 'Checking out the repository', tone: 'now' },
            { glyph: '○', text: 'Copy local files', tone: 'pending' },
          ]
        : [
            branch('done'),
            { glyph: '✓', text: 'Checked out', tone: 'done' },
            { glyph: '•', text: 'Copying local files', tone: 'now' },
          ]
  return { failed: false, title: 'Setting up a worktree', right: `step ${step} of ${SETUP_STEPS}`, lines, path }
}

/**
 * What a session's transcript holds of its setup (66a, 66c, 66d): the setup,
 * whether the session has not started (its prompt, the block and its queue
 * stand in for the transcript), the setup once started while messages still
 * wait for the first turn to end, and the part of the footer's key it owns.
 */
export function setupTranscript(session: Pick<ApiSession, 'setup'> | null | undefined): {
  setup: SessionSetup | null
  pending: boolean
  setupQueued: SessionSetup | null
  footerKey: string | undefined
} {
  const setup = session?.setup ?? null
  const pending = setup !== null && setup.phase !== 'ready'
  const setupQueued = setup && !pending && setup.queued.length > 0 ? setup : null
  const footerKey =
    setup && pending
      ? `setup:${setup.phase}:${setup.queued.length}`
      : setupQueued
        ? `setup-queued:${setupQueued.queued.length}`
        : undefined
  return { setup, pending, setupQueued, footerKey }
}

/** The branch where a session's header, card and row name it: italic while it is not known (66a). */
export function setupBranch(setup: Pick<SessionSetup, 'phase' | 'branch'>): { text: string; italic: boolean } {
  if (setup.phase === 'failed') return { text: 'no worktree', italic: true }
  if (setup.branch === null) return { text: 'naming…', italic: true }
  return { text: setup.branch, italic: false }
}

/**
 * Where a session not started yet will work, as the headers read it: the
 * branch it is getting as a plain branch — its checkout does not exist yet —
 * or what stands in for one, which is drawn italic and muted (66c `panel()`
 * `brStyle`, `brInk`; 66d).
 */
export function setupGit(setup: Pick<SessionSetup, 'phase' | 'branch'>): { git: GitLocation; standIn: boolean } {
  const { text, italic } = setupBranch(setup)
  return { git: { ref: text, detached: false, worktree: false, defaultBranch: false }, standIn: italic }
}

/** The Desk card's tool line (66b): the step, or that it did not start. */
export function setupToolLine(setup: Pick<SessionSetup, 'phase' | 'step'>): { name: string; arg: string } {
  if (setup.phase === 'failed') return { name: 'Not started', arg: 'couldn’t create the worktree' }
  const step = runningStep(setup)
  const doing = step === 1 ? 'naming the branch' : step === 2 ? 'checking out' : 'copying local files'
  return { name: 'Setting up', arg: `step ${step} of ${SETUP_STEPS} · ${doing}` }
}

/** The phone row's note (66d). */
export function setupRowNote(setup: Pick<SessionSetup, 'phase' | 'step'>): string {
  return setup.phase === 'failed' ? 'Couldn’t create the worktree.' : `Setting up a worktree · step ${runningStep(setup)} of ${SETUP_STEPS}`
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
 * queued messages below it and all their attachments, and the harness or the
 * progress list it was launched with. `replaces` is the session discarded
 * once that launch is accepted.
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
  /** The harness it was launched on: New session opens on it, its inputs filled. */
  harness: Pick<LaunchHarnessPlan, 'templateId' | 'inputs' | 'lucky'> | null
  /** The progress list switch as it was launched; null when the dialog did not offer one. */
  progressList: boolean | null
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
    harness: launch.harness
      ? { templateId: launch.harness.templateId, inputs: launch.harness.inputs, lucky: launch.harness.lucky }
      : null,
    progressList: launch.progressListChoice ?? null,
  }
}
