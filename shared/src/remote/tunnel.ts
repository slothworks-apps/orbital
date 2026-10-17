/**
 * What the phone's app talks to, whatever carries it: the asking half of a
 * channel to a device (`TunnelResponse`, `TunnelError`, …) and the events a
 * client over the relay emits (`TunnelEvent`). The app's clients — the group
 * federation today — type themselves against this module, not against a
 * class that implements it.
 */
import type { ByeReason } from './channel.js';
import type { LinkStatus } from './relayLink.js';
import type { RelayTooOld } from './version.js';

export { TunnelError, HANDSHAKE_TIMEOUT_MS, REQUEST_TIMEOUT_MS, TUNNEL_SILENCE_TIMEOUT_MS } from './channel.js';
export type {
  HttpMethod, ByeReason, TunnelResponse, BlobResult, FileResult, GetFileOptions, PutBlobResult, TunnelFailure,
} from './channel.js';
export { CONNECT_TIMEOUT_MS } from './relayLink.js';
export type { LinkStatus } from './relayLink.js';

export type TunnelEvent =
  | { type: 'status'; status: LinkStatus }
  | { type: 'presence'; macOnline: boolean }
  /** `kind` and `capabilities` only from a Mac that names them; a shipped one names neither. */
  | { type: 'hello'; server: string; macName: string; kind?: string; capabilities?: string[] }
  /** True once a cipher exists and the Mac said hello; false when that tunnel is gone. */
  | { type: 'ready'; ready: boolean }
  /** `needed`: the Mac's `MIN_PHONE_VERSION`, with `app_too_old`. */
  | { type: 'bye'; reason: ByeReason; needed?: string }
  /** The Mac confirmed; its name is the QR's, the relay knows none. */
  | { type: 'paired' }
  | { type: 'rejected' }
  /**
   * The pair is gone. `unreachable`: no device was heard removing this
   * phone — none of its group could reach it any more (`ALONE_GRACE_MS`).
   */
  | { type: 'unpaired'; unreachable?: boolean }
  | { type: 'relay_error'; code: string }
  /**
   * The relay is below `MIN_RELAY_VERSION` (at connect, or in a redeem's
   * answer): the client has stopped, and only `recheck` or `start` tries
   * that relay again.
   */
  | ({ type: 'relay_too_old' } & RelayTooOld)
  /** A hub frame, verbatim — `dropped` ones included (parent § 7). */
  | { type: 'hub'; frame: unknown }
  /** A frame with an empty body: its header flags, and nothing else (parent § 7). */
  | { type: 'wake'; flags: number };
