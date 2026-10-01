/**
 * One question, one answer: the harness's model calls (the watcher, the
 * template drafter) go through the titler's one-shot path, without tools or
 * the repository's settings, and without a transcript on disk.
 */

import type { TitleQueryFn } from '../titler/titler.js';

export async function askOnce(
  queryFn: TitleQueryFn,
  prompt: string,
  opts: { systemPrompt: string; model: string; claudeExecutablePath?: string | null },
): Promise<string> {
  const parts: string[] = [];
  const options: Record<string, unknown> = {
    model: opts.model,
    maxTurns: 1,
    allowedTools: [],
    settingSources: [],
    systemPrompt: opts.systemPrompt,
    // A persisted call would show up as a planet (adr ephemeral-title-queries).
    persistSession: false,
  };
  if (opts.claudeExecutablePath) options.pathToClaudeCodeExecutable = opts.claudeExecutablePath;
  for await (const message of queryFn({ prompt, options })) {
    if (message?.type === 'assistant') {
      const content = message.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
        }
      }
    }
    if (message?.type === 'result') break;
  }
  return parts.join('').trim();
}
