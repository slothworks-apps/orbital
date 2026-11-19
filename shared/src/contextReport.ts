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

/**
 * How long the Mac waits for a session to count a report taken from the
 * context read-out (`GET /api/sessions/:id/context-report`) before it gives
 * up with `timeout`; the dialog's failure says it in seconds. `detail: 'full'`
 * counts each category with the token-count API, so it takes longer than a
 * turn's end summary; it stays well under the phone's `REQUEST_TIMEOUT_MS`,
 * so a slow CLI answers the phone with a timeout rather than with silence.
 */
export const CONTEXT_REPORT_TIMEOUT_MS = 10_000;

/**
 * `GET /api/sessions/:id/context-report`'s answer (`server/src/api/routes.ts`),
 * as the web reads it: the report with when it was taken (ISO) and whether it
 * was taken now (`fresh`), or a named refusal — a failed taking carries the
 * kept report as `earlier` when there is one.
 */
export type ContextReportAnswer =
  | { report: ContextReport; takenAt: string; fresh: boolean }
  | { error: 'not_found' | 'no_report' | 'unsupported' | 'failed' | 'timeout'; earlier?: { report: ContextReport; takenAt: string } };
