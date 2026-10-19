/**
 * The appendix every session Orbital starts carries after the `claude_code`
 * preset (spec 2026-09-30-session-instructions-design). Two layers the user
 * switches from Settings › Sessions › INSTRUCTIONS — Orbital's tips and the
 * user's own text — plus the Narrate commentary switch from Experimental.
 * Pure: the runner gets a closure over the settings store that calls
 * `composeAppendix`, and nothing here reads a database.
 */

import { SHELL_INTENT_INSTRUCTION } from './shellIntentHook.js';

export interface SessionTip {
  /** Stable once shipped: a later per-tip switch stores it (spec § 6). */
  id: string;
  /** Heads the tip in the Settings preview. */
  title: string;
  /** What the model reads. */
  text: string;
}

/**
 * Orbital's tips, shipped with the app rather than stored: they change
 * with the version and the user never edits them (spec § 2). The array's
 * order is the order they reach the session: the background tips first, so
 * they follow the rule about background shells. Each says "do X, because
 * Orbital does Y" and nothing more.
 */
export const SESSION_TIPS: readonly SessionTip[] = [
  {
    id: 'long-commands-in-background',
    title: 'Long commands in the background',
    text:
      'Run test suites, builds, dev servers and watchers in the background. Orbital lists ' +
      'background tasks with their live output and lets the user stop each one; a foreground ' +
      'command shows nothing until it ends.',
  },
  {
    id: 'stop-background-tasks-when-done',
    title: 'Stop background tasks when done',
    text:
      'When the work is finished, stop the background tasks you started. Orbital lists every ' +
      'running task under its session, so a forgotten server stays there long after the work is ' +
      'done. Leave one running only if the user asked for it.',
  },
  {
    id: 'ask-user-question',
    title: 'Choices through AskUserQuestion',
    text:
      'Offer a choice between options through the AskUserQuestion tool, not as a numbered list: ' +
      'Orbital shows the tool call as a card with buttons. Put whatever the user must read before ' +
      'answering in a text block of the same message; your thinking is not shown to them.',
  },
  {
    id: 'paths-in-code-spans',
    title: 'Clickable file paths',
    text:
      'Refer to a file as its path, optionally with `:line`, alone inside an inline code span. ' +
      'Orbital turns such a span into a link that opens the file; a path inside a sentence or a ' +
      'command is plain text.',
  },
];

/**
 * Opens every appendix: the preset tells the model its output is shown in
 * a terminal, and the tips and rules that follow name Orbital without
 * saying what it is.
 */
export const SESSION_CONTEXT =
  'This session runs in Orbital, an app that shows Claude Code sessions in a window instead of a ' +
  'terminal; the user reads your replies and answers your questions there.';

/**
 * What every session is told whatever the switches say: rules Orbital
 * enforces anyway, stated up front so that breaking one is the exception.
 * Not tips — the user cannot turn them off, and the Settings preview does
 * not list them.
 */
export const SESSION_RULES: readonly string[] = [SHELL_INTENT_INSTRUCTION];

/**
 * Appended while Settings › Experimental › "Comment for Narrate" is on
 * (spec 2026-09-30-narrate-out-of-band-design § Settings › Experimental).
 * It asks for visible prose and nothing else, so the why of a change is in
 * the record the narrate query reads.
 */
export const NARRATE_COMMENTARY_PROMPT =
  'Before you change a file, say in a sentence or two what you are changing and why. ' +
  'If you considered another way and rejected it, name it and say why in the same place.';

export interface AppendixInput {
  /** `session_instructions_tips` */
  tipsOn: boolean;
  /**
   * Ids of tips to leave out. Reserved for the per-tip switch (spec § 6):
   * nothing passes it yet, and an id no tip carries is ignored.
   */
  tipsOff?: readonly string[];
  /** `narrate_commentary` */
  commentary: boolean;
  /** `session_instructions_custom` */
  customOn: boolean;
  /** `session_instructions_custom_text`, as stored — trimmed here, not on write. */
  customText: string;
}

/**
 * The context line, Orbital's rules, then the tips, then the commentary, then the user's text,
 * a blank line between blocks; the user's text goes last so that where it
 * contradicts a tip it wins. The rules are on whatever the switches say:
 * Orbital enforces them either way, so they only spare the agent a refusal.
 * The return type keeps `null` for a bare preset, though the context line
 * means a block always survives.
 */
export function composeAppendix(input: AppendixInput): string | null {
  const blocks: string[] = [SESSION_CONTEXT, ...SESSION_RULES];
  if (input.tipsOn) {
    const off = new Set(input.tipsOff ?? []);
    for (const tip of SESSION_TIPS) if (!off.has(tip.id)) blocks.push(tip.text);
  }
  if (input.commentary) blocks.push(NARRATE_COMMENTARY_PROMPT);
  if (input.customOn) {
    const text = input.customText.trim();
    if (text) blocks.push(text);
  }
  return blocks.length ? blocks.join('\n\n') : null;
}
