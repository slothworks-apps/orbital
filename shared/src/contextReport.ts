/**
 * The CLI's `/context` report as data (`SDKContextUsage`, camelCased): the
 * Mac reads it off the SDK frame's `context_usage` or the transcript entry's
 * `contextUsage` (`server/src/transcript/notices.ts`) into
 * `notice.contextReport`; the desktop and the phone draw it as the row, the
 * dialog and the sheet. Spec 2026-11-19-context-report-dialog-design.
 *
 * The window is `rawMaxTokens`, which can be a compaction window smaller than
 * the model's. Rows are kept in the CLI's order; a category's `kind` is the
 * CLI's (`used` / `free` / `buffer` / `deferred`) or one it has since added.
 */
export interface ContextReport {
  model: string | null;
  totalTokens: number;
  rawMaxTokens: number;
  percentage: number;
  overLimit?: { tokensOver: number; kind: string };
  categories: { name: string; tokens: number; kind: string }[];
  mcpTools: { name: string; serverName: string; tokens: number }[];
  memoryFiles: { path: string; type: string; tokens: number }[];
  agents: { agentType: string; source: string; tokens: number }[];
  skills: { name: string; source: string; pluginName?: string; tokens: number }[];
}
