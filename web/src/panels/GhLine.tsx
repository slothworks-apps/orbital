import { useState } from 'react'
import { reportError } from '../lib/errors'
import { ORBITAL_COMMANDS, runInOrbital, type OrbitalCommand, type StartedRun } from '../lib/runInOrbital'
import { hasBrew } from '../lib/ghTip'
import type { GhAvailability } from '../lib/types'
import { Button } from '../ui/Button'
import { Collapse } from '../ui/Collapse'

/**
 * The line under Settings' PR switch (canvas `Feature - Feedback` 61c, 61g —
 * it replaces `Feature - Branch status` 1g's bare reason): why the switch is
 * off, the command that fixes it, and a button that runs it in an Orbital
 * session, so nobody has to open a terminal for it.
 */

export type GhLineVariant =
  | { kind: 'run'; reason: string; run: OrbitalCommand }
  | { kind: 'link'; reason: string; href: string; label: string }

/** Where gh is installed from without Homebrew (61g). */
export const GH_SITE = 'https://cli.github.com'

/**
 * What the line says for an answer from `GET /api/gh-status`. Null: `gh` is
 * ready, or the server has not answered — the switch then works as any other.
 * `brew` absent (an older Mac) counts as present: the line it showed before.
 */
export function ghLineVariant(status: GhAvailability | null, brew: boolean | undefined): GhLineVariant | null {
  if (status === 'missing') {
    return !hasBrew({ status, brew })
      ? { kind: 'link', reason: 'gh is not installed · no Homebrew', href: GH_SITE, label: 'cli.github.com ↗' }
      : { kind: 'run', reason: 'gh is not installed', run: 'install-gh' }
  }
  if (status === 'logged_out') return { kind: 'run', reason: 'gh is not logged in', run: 'login-gh' }
  return null
}

export function GhLine({
  status,
  brew,
  onOpenSession,
}: {
  status: GhAvailability | null
  brew: boolean | undefined
  /** Open the session Run started: Settings closes and the map selects it. */
  onOpenSession: (id: string) => void
}) {
  const variant = ghLineVariant(status, brew)
  // What the line last said, kept while it folds away once gh works, so it
  // does not empty itself before it has closed.
  const [shown, setShown] = useState<GhLineVariant | null>(variant)
  if (variant !== null && (shown === null || !sameVariant(shown, variant))) setShown(variant)
  /** The run this Settings visit started, for the command it ran. A different reason shows its own command again. */
  const [started, setStarted] = useState<(StartedRun & { run: OrbitalCommand }) | null>(null)
  const [starting, setStarting] = useState(false)

  const line = variant ?? shown
  const ran = line?.kind === 'run' && started?.run === line.run ? started : null

  const run = async (which: OrbitalCommand) => {
    setStarting(true)
    try {
      const session = await runInOrbital(which)
      setStarted({ ...session, run: which })
    } catch (err) {
      reportError(err, 'Failed to start the session')
    } finally {
      setStarting(false)
    }
  }

  return (
    <Collapse open={variant !== null}>
      {line && (
        // 61c: 8 under the switch, the reason, then the command row or what
        // became of it, 8 apart. The gaps are paddings inside the folds, so a
        // closed fold leaves none behind; every change of state folds
        // (`ui/Collapse`), so nothing in the row jumps.
        <div className="flex w-full flex-col pt-2">
          <span className="font-mono fs-10.5 leading-[1.5] text-[rgba(200,220,245,.8)]">{line.reason}</span>
          {line.kind === 'link' ? (
            <a
              href={line.href}
              target="_blank"
              rel="noreferrer"
              className="mt-2 self-start font-mono fs-11 text-[rgba(200,220,245,.85)] no-underline transition-colors hover:text-text-bright"
            >
              {line.label}
            </a>
          ) : (
            <>
              <Collapse open={ran === null}>
                <div className="flex items-center gap-1.5 pt-2">
                  <code className="whitespace-nowrap rounded-[7px] border border-[rgba(150,205,255,.14)] bg-[rgba(4,8,16,.6)] px-2.5 py-1.5 font-mono fs-11.5 text-text-bright">
                    {ORBITAL_COMMANDS[line.run].command}
                  </code>
                  <Button
                    variant="lit"
                    size="command"
                    className="whitespace-nowrap"
                    title="Starts a new Orbital session that runs this command"
                    disabled={starting}
                    onClick={() => void run(line.run)}
                  >
                    Run in Orbital
                  </Button>
                </div>
              </Collapse>
              <Collapse open={ran !== null}>
                {/* The last run, kept while it folds away under a new reason. */}
                {started && (
                  <div className="flex flex-col gap-1 pt-2 fs-12 leading-[1.5] text-[rgba(200,214,235,.85)]">
                    <span>
                      Running in the session{' '}
                      <span className="font-mono fs-11.5 text-text-bright">&ldquo;{started.title}&rdquo;</span>. This
                      row checks again when Settings is back in focus.
                    </span>
                    <button
                      type="button"
                      onClick={() => onOpenSession(started.id)}
                      className="cursor-pointer self-start border-0 bg-transparent p-0 font-mono fs-11 text-[rgba(160,190,225,.8)] transition-colors hover:text-text-bright"
                    >
                      Open the session ›
                    </button>
                  </div>
                )}
              </Collapse>
            </>
          )}
        </div>
      )}
    </Collapse>
  )
}

function sameVariant(a: GhLineVariant, b: GhLineVariant): boolean {
  return a.kind === b.kind && a.reason === b.reason
}
