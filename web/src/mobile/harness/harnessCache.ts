/**
 * Each session's harness and its log as last read live, kept with `asOf`
 * so the gate card and the steps sheet stay readable while the Mac sleeps
 * (spec 2026-10-05-mobile-next § 1). Stub — T1.3 replaces it.
 */

/** Drops every cached harness; forgetting the Mac calls it. */
export async function clearHarnessCache(): Promise<void> {}
