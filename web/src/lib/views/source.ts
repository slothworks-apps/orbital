import type { ViewPayload } from '@orbital/shared/views'

/**
 * Where a generated view's page and data come from (spec
 * 2026-11-18-generated-views-design § Phone): the desktop reads its own
 * server's routes, the phone asks the Mac through the relay. The same seam
 * as `configureFileOpen` in `../fileOpen.ts`: unconfigured — the desktop —
 * `viewSource()` is null and the view reads the desktop's routes; the phone
 * configures its own at start-up.
 *
 * Set once at start-up, never toggled while the transcript is on screen, so
 * the components read it at render time instead of subscribing.
 */
export interface ViewDataSource {
  /** What the view at this call needs to be drawn. */
  payload(sessionId: string, toolUseId: string): Promise<ViewPayload>
  /** The data copy of a view whose payload does not carry it inline (`ViewPayload.data.inline` false), as text. */
  data(sessionId: string, toolUseId: string): Promise<string>
}

let source: ViewDataSource | null = null

/** Routes a view's reads away from the desktop's server; `null` restores it. */
export function configureViewSource(next: ViewDataSource | null): void {
  source = next
}

export function viewSource(): ViewDataSource | null {
  return source
}
