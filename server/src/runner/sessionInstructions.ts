/**
 * The appendix every session Orbital starts carries after the `claude_code`
 * preset (spec 2026-09-30-session-instructions-design). Two layers the user
 * switches from Settings › Sessions › INSTRUCTIONS — Orbital's tips and the
 * user's own text — plus the Narrate commentary switch from Experimental.
 * Pure: the runner gets a closure over the settings store that calls
 * `composeAppendix`, and nothing here reads a database.
 */

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
 * order is the order they reach the session. Each says "do X, because
 * Orbital does Y" and nothing more.
 */
export const SESSION_TIPS: readonly SessionTip[] = [
  {
    id: 'ask-user-question',
    title: 'Choices through AskUserQuestion',
    text:
      'When you offer the user a choice between options, call the AskUserQuestion tool. ' +
      'Do not write a numbered list and ask for a number: Orbital shows the tool call as a card ' +
      'with buttons, and a list in prose is not clickable. Whatever the user has to read before ' +
      'answering goes in a text block of the same message: your thinking is not shown as part of ' +
      'the reply, and a question about a proposal that exists only there cannot be answered.',
  },
  {
    id: 'paths-in-code-spans',
    title: 'Clickable file paths',
    text:
      'Refer to a file as its path, optionally with `:line`, alone inside an inline code span. ' +
      'Orbital turns such a span into a link that opens the file; a path inside a sentence or a ' +
      'command is plain text.',
  },
  {
    id: 'long-commands-in-background',
    title: 'Long commands in the background',
    text:
      'Run commands that take more than a moment — test suites, builds, dev servers, watchers — ' +
      'in the background. Orbital lists background tasks with their live output and lets the user ' +
      'stop each one; a foreground command shows nothing until it ends.',
  },
  {
    id: 'stop-background-tasks-when-done',
    title: 'Stop background tasks when done',
    text:
      'When the work is finished — typically after the final commit or after merging the branch — ' +
      'stop the background tasks you started: dev servers, watchers, anything still running. ' +
      'Orbital shows a session with a live background task as still working, so a forgotten ' +
      'server keeps a finished session looking busy. Leave one running only if the user asked for it.',
  },
];

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
 * Tips, then the commentary, then the user's text, a blank line between
 * blocks; the user's text goes last so that where it contradicts a tip it
 * wins. `null` when no block survives, so the runner sends the bare preset.
 */
export function composeAppendix(input: AppendixInput): string | null {
  const blocks: string[] = [];
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
