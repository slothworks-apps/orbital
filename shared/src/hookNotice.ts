/**
 * The live row while a hook holds a session (canvas `Feature - Stop hook`
 * 1a–1g, spec 2026-10-31-message-beats-stop-hook-design). The Mac builds it
 * from the SDK's hook events; the desktop and the phone draw it. The words
 * live here so the row's `text`, which a client that predates `hook` reads,
 * and the row a newer client draws from `hook` say the same thing.
 */

/**
 * The hook event the CLI runs once the main loop has finished its answer,
 * before the turn's `result`. A subagent's end runs `SubagentStop`, which is
 * not this.
 */
export const STOP_HOOK_EVENT = 'Stop';

/** The hooks of one event running now, as the row names them. */
export interface LiveHookNotice {
  /** The event, verbatim as in `settings.json`: `Stop`, `PreToolUse`, `SessionStart`. */
  event: string;
  /** The tool the hooks run for, for the events that run per tool call (`Bash`). */
  tool?: string;
  /** The command, only where the settings configure exactly one for this event and tool. */
  command?: string;
  /** How many of them run. */
  count: number;
  /** Only the main loop's `Stop` hooks: the row offers Cancel, which interrupts the session. */
  cancellable: boolean;
  /** How many messages the user sent that wait for these hooks; 0 for none. */
  messagesWaiting: number;
  /**
   * The uuids of those messages, oldest first: a transcript row carrying one
   * is drawn waiting, under the row, whichever window or device sent it. A
   * Mac that predates it sends only the count.
   */
  waiting?: string[];
}

/** "Stop hook running — your message waits for it", without the tool and the command. */
export function hookNoticeLead(hook: LiveHookNotice): string {
  const running = `${hook.event} ${hook.count > 1 ? 'hooks' : 'hook'} running`;
  if (hook.messagesWaiting <= 0) return running;
  const waits = hook.messagesWaiting > 1 ? 'your messages wait' : 'your message waits';
  return `${running} — ${waits} for ${hook.count > 1 ? 'them' : 'it'}`;
}

/** What follows the lead in muted ink: the tool, then the command, each where there is one. */
export function hookNoticeDetail(hook: LiveHookNotice): string[] {
  return [hook.tool, hook.command].filter((part): part is string => typeof part === 'string' && part !== '');
}

/** The whole row as one line: the notice's `text`, and the desktop row's tooltip. */
export function hookNoticeText(hook: LiveHookNotice): string {
  return [hookNoticeLead(hook), ...hookNoticeDetail(hook)].join(' · ');
}

/**
 * The caption under the messages that wait for the hooks (canvas 1a, 1g):
 * "waits for the Stop hook" under one, "3 messages wait for the Stop hooks"
 * under several, once for the group.
 */
export function hookWaitCaption(hook: Pick<LiveHookNotice, 'event' | 'count'>, messages: number): string {
  const hooks = `the ${hook.event} ${hook.count > 1 ? 'hooks' : 'hook'}`;
  return messages > 1 ? `${messages} messages wait for ${hooks}` : `waits for ${hooks}`;
}
