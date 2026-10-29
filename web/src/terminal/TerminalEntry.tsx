import { useShallow } from 'zustand/react/shallow'
import { shortcutLabel } from '../lib/keymap'
import { workingDirOf } from '../lib/types'
import type { ApiSession } from '../lib/types'
import { Tooltip } from '../ui/Tooltip'
import { UtilityButton } from '../ui/UtilityButton'
import { toggleTerminalShown } from './actions'
import { useTerminals } from './store'
import { terminalChipTitle } from './tabs'
import { useTerminalPlacement } from './useTerminalHost'

/** 48e: the glyph both entries wear — set tight, a notch heavier than the ink around it. */
function PromptGlyph() {
  return <span className="font-mono font-semibold tracking-[-0.06em]">›_</span>
}

/** `~/…/orbital`: the folder a new shell starts in, as the strip's hover names it (48e). */
function folderOf(session: ApiSession): string {
  const segments = workingDirOf(session).split('/').filter(Boolean)
  return segments.length > 1 ? `~/…/${segments[segments.length - 1]}` : `~/${segments.join('/')}`
}

/**
 * The way in before the session's first terminal (48e): `›_` in the utility
 * strip. Pressing it starts a shell in the session's folder at once. From the
 * first tab on it is the state row's chip instead — never in both places.
 */
export function TerminalStripButton({ session, delayMs }: { session: ApiSession; delayMs: number }) {
  const { enabled } = useTerminalPlacement(session.id)
  const hasTabs = useTerminals((s) => (s.tabs[session.id] ?? []).length > 0)
  const loaded = useTerminals((s) => Boolean(s.loaded[session.id]))
  if (!enabled || !loaded || hasTabs) return null
  return (
    <span className="ml-2.5 flex flex-none">
      <Tooltip
        variant="name"
        title={`Open a terminal in ${folderOf(session)}`}
        shortcut="terminal.toggle"
        align="right"
        delayMs={delayMs}
      >
        <UtilityButton aria-label="Terminal" onClick={() => toggleTerminalShown(session.id)}>
          <span className="pb-px fs-11">
            <PromptGlyph />
          </span>
        </UtilityButton>
      </Tooltip>
    </span>
  )
}

/**
 * The `›_ N` chip after ▣ in the state row (48e), from the first tab on. N
 * counts tabs, exited ones included, and changes only when one is added or
 * closed — never with output, so it cannot become an unread mark. Neutral
 * ink, no cyan and no dot, so it never reads as ◐ or ▣. A click shows or
 * hides the terminal, as ⌘T does.
 */
export function TerminalChip({ sessionId }: { sessionId: string }) {
  const { enabled, onScreen } = useTerminalPlacement(sessionId)
  const tabs = useTerminals(useShallow((s) => s.tabs[sessionId] ?? []))
  if (!enabled || tabs.length === 0) return null
  return (
    <button
      type="button"
      data-shells-chip
      aria-pressed={onScreen}
      title={terminalChipTitle(tabs, shortcutLabel('terminal.toggle'))}
      onClick={() => toggleTerminalShown(sessionId)}
      className={[
        'flex h-fit min-h-[22px] flex-none cursor-pointer items-center gap-1.5 rounded-md border px-2 font-mono fs-10.5 whitespace-nowrap',
        'hover:border-line/30 hover:text-ink-100',
        onScreen
          ? 'border-line/30 bg-line/14 text-ink-100'
          : 'border-line/14 bg-transparent text-ink-900/75',
      ].join(' ')}
    >
      <PromptGlyph />
      {tabs.length}
    </button>
  )
}
