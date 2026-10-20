import { api } from './api'
import { recordError } from './errors'
import type { PermissionMode } from './types'
import { useOrbital } from '../store/store'

/**
 * Run in Orbital (spec 2026-10-20-report-to-github-design § Telling people
 * about `gh`, canvas `Feature - Feedback` 61c, 61e, 61g): a shell command the
 * user would otherwise have to type into a terminal, run in an ordinary
 * Orbital session instead. The session shows up on the map like any other,
 * the user approves the command in it like any other, and ends it themself.
 *
 * Claude Code's `!` shell mode does not exist in the SDK: a `!cmd` prompt is
 * only read by the model, which then runs it with Bash anyway. So the session
 * starts with a short prompt that asks for exactly that, and nothing more.
 */

export type OrbitalCommand = 'install-gh' | 'login-gh'

interface CommandSpec {
  /** What the row shows and what the session runs, verbatim. */
  command: string
  /** The session's name on the map; the canvas names both (61c `cSession`). */
  title: string
  prompt: string
}

/** The home directory, expanded by the server like a typed path (`POST /api/sessions`). */
export const RUN_CWD = '~'

/**
 * The launch default the server itself falls back to: every Bash command still
 * waits for the user's approval in the session, so nothing runs unseen.
 */
export const RUN_PERMISSION_MODE: PermissionMode = 'acceptEdits'

const INSTALL_GH = 'brew install gh'
const LOGIN_GH = 'gh auth login --web'

export const ORBITAL_COMMANDS: Record<OrbitalCommand, CommandSpec> = {
  'install-gh': {
    command: INSTALL_GH,
    title: 'Install gh',
    prompt: [
      `Run exactly this shell command with the Bash tool: \`${INSTALL_GH}\``,
      '',
      'Run nothing else before or after it. When it finishes, tell me in one or two sentences whether gh is installed now; if it failed, quote the error as it was printed.',
    ].join('\n'),
  },
  'login-gh': {
    command: LOGIN_GH,
    title: 'Log in to gh',
    // `--web` waits for the browser, so a foreground run would hold the turn
    // with the one-time code unseen. In the background the code can be shown
    // the moment gh prints it.
    prompt: [
      `Run exactly this shell command with the Bash tool, in the background: \`${LOGIN_GH}\``,
      '',
      'It prints a one-time code and a URL, then waits until I confirm the code in the browser. As soon as gh has printed them, show me the one-time code and the URL first thing, on their own lines. Do not answer any of its questions for me and run no other command.',
      '',
      'Then wait for the command to finish and tell me in one sentence whether I am logged in to GitHub now; if it failed, quote the error as it was printed.',
    ].join('\n'),
  },
}

export interface StartedRun {
  id: string
  title: string
}

/**
 * Starts the session and names it. Through the store's `launchSession`, as the
 * New Session dialog does, so this tab is subscribed before the first turn is
 * published. A failed rename leaves the session as it is: it runs regardless,
 * and the titler names it from its prompt.
 */
export async function runInOrbital(which: OrbitalCommand): Promise<StartedRun> {
  const spec = ORBITAL_COMMANDS[which]
  const id = await useOrbital.getState().launchSession({
    cwd: RUN_CWD,
    prompt: spec.prompt,
    permissionMode: RUN_PERMISSION_MODE,
  })
  // The session runs either way; a failed rename only leaves the titler's
  // name on it, so it is recorded, not announced.
  await api.renameSession(id, spec.title).catch((err) => recordError(err, `Could not name the session ${spec.title}`))
  return { id, title: spec.title }
}
