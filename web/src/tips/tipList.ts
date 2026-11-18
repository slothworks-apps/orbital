import type { Tip } from '../lib/tips'

/**
 * The prompt the `orchestrate` tip writes into New session. It is only
 * written in: the person reads it, adds the task and launches it themselves.
 */
const ORCHESTRATE_PROMPT =
  'Split the task below across several Orbital sessions: start a session for each part, in a worktree of its ' +
  'own where parts touch the same repository, send each one what it needs, follow their progress and bring ' +
  'their results together here when they finish.\n\nThe task: '

/**
 * Every tip, in the order the card offers them (spec 2026-11-16-tips-design
 * § The first tips). A tip names only what works on a default install; a
 * feature behind Experimental gets none. Add a tip at the place it should be
 * offered; its id must never change, since `TIPS_SEEN_KEY` remembers it.
 */
export const TIPS: readonly Tip[] = [
  {
    id: 'spawn-session',
    group: 'Sessions',
    text: 'A session can start another Orbital session by itself. Ask it to hand a side task to a new session, in a worktree of its own when it touches the same repo.',
  },
  {
    id: 'orchestrate',
    group: 'Sessions',
    text: 'One session can run several: it splits the work, starts a session for each part, sends them messages and reads their results.',
    action: { kind: 'new-session-prompt', prompt: ORCHESTRATE_PROMPT, label: 'Open New session with this prompt' },
  },
  {
    id: 'worktree',
    group: 'Starting a session',
    text: 'New session can create a git worktree and name its branch, so sessions working in one repo do not step on each other.',
    action: { kind: 'new-session', label: 'Open New session' },
  },
  {
    id: 'harness',
    group: 'Starting a session',
    text: 'A harness gives a session a checklist to follow: it ticks each step and can stop for your review. A session can write the template for you.',
    action: { kind: 'settings', section: 'harness', label: 'Open Settings → Harness' },
  },
  {
    id: 'drive-orbital',
    group: 'Sessions',
    text: 'A session can change Orbital for you: settings, tags and tag rules. Ask it instead of clicking through Settings.',
  },
  {
    id: 'take-over',
    group: 'Sessions',
    text: 'A session running in a terminal can be taken over: Orbital quits the CLI there and the conversation goes on here.',
  },
  {
    id: 'phone',
    group: 'Elsewhere',
    text: 'Pair your phone to answer a waiting session when you are away from the Mac.',
    action: { kind: 'settings', section: 'devices', label: 'Open Settings → Devices' },
  },
  {
    id: 'ide-selection',
    group: 'Keyboard and input',
    text: 'Text you select in your IDE arrives in the composer as a quoted block.',
  },
  {
    id: 'profiles',
    group: 'Starting a session',
    text: 'Several Claude accounts side by side: each profile has its own sign-in, and New session picks which one a session runs on.',
    action: { kind: 'settings', section: 'profiles', label: 'Open Settings → Profiles' },
  },
  {
    id: 'stats',
    group: 'Elsewhere',
    text: 'Stats show what your sessions cost, by period, project and model.',
    action: { kind: 'stats', label: 'Open Stats' },
  },
  {
    id: 'shortcuts',
    group: 'Keyboard and input',
    text: 'Every keyboard shortcut is listed in one place.',
    action: { kind: 'settings', section: 'shortcuts', label: 'Open Settings → Shortcuts' },
  },
]
