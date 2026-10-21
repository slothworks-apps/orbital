import type { ChatMessage } from '../types.js';

/** What a delivery into a session did — `deliverToSession`'s outcome in `routes.ts`. */
export type DeliveryOutcome = 'sent' | 'revived' | 'not_found' | 'terminal';

/** A delivery's answer: its outcome, and the uuid the turn's entry is written under when it started one. */
export interface DeliveryResult {
  outcome: DeliveryOutcome;
  uuid: string | null;
}

/** Whether the delivery started a turn: sent to a live session, or revived it. */
export function startedTurn(outcome: DeliveryOutcome): boolean {
  return outcome === 'sent' || outcome === 'revived';
}

/**
 * Orbital's own text into a session through the one delivery path, and the
 * turn it started published on the session's topic: the SDK does not replay
 * Orbital's own sends, and nobody typed this one. The limits' firing and a
 * login's continuation both send this way. Throws what the delivery throws.
 */
export async function deliverOwnTurn(
  deliver: (sessionId: string, text: string) => Promise<DeliveryResult>,
  publish: (sessionId: string, payload: Record<string, unknown>) => void,
  turn: { sessionId: string; text: string; id: string },
  now: () => number,
): Promise<DeliveryResult> {
  const delivery = await deliver(turn.sessionId, turn.text);
  if (startedTurn(delivery.outcome)) {
    const message: ChatMessage = {
      id: turn.id,
      role: 'user',
      text: turn.text,
      timestamp: new Date(now()).toISOString(),
      ...(delivery.uuid ? { uuid: delivery.uuid } : {}),
    };
    publish(turn.sessionId, { event: 'message', message });
  }
  return delivery;
}
