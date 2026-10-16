/**
 * A paired device's channel on this server: the shared `Channel` with this
 * server's serving half and its check of a phone's version (spec
 * 2026-10-16-device-group-design § 5, § 9).
 */
import { Channel, type HelloVerdict, type OwnHello } from '@orbital/shared/remote/channel';
import type { Role } from '@orbital/shared/remote/handshake';
import type { Identity } from '@orbital/shared/remote/keys';
import type { HelloMessage } from '@orbital/shared/remote/messages';
import {
  MIN_PHONE_VERSION, PHONE_KNOWS_APP_TOO_OLD, compareVersions, phoneAppVersion,
} from '@orbital/shared/remote/version';
import { ServingHalf, type ServingHalfOptions } from './servingHalf.js';

/** A phone app below this server's minimum: the version its `hello` named, and the minimum. */
export type PhoneTooOld = { version: string; needed: string };

export type DeviceChannelOptions = ServingHalfOptions & {
  identity: Identity;
  peerKey: Uint8Array;
  role: Role;
  hello: OwnHello;
  send(body: Uint8Array): void;
  /** Every phone hello's verdict on its version: the refusal, or null for an app new enough. */
  onAppVersion?: (refusal: PhoneTooOld | null) => void;
  /** `MIN_PHONE_VERSION` unless a test moves it. */
  minPhoneVersion?: string;
};

/**
 * Only a phone is held to `MIN_PHONE_VERSION`; a hello naming another kind
 * is a member whose own version is checked by the group (spec § 8). A phone
 * from before `app_too_old` would drop that bye as unreadable, so it gets
 * `protocol`. A hello whose `app` names no version is not judged.
 */
export function judgeHello(
  hello: HelloMessage, minPhoneVersion: string = MIN_PHONE_VERSION,
): { verdict: HelloVerdict; refusal: PhoneTooOld | null } {
  if (hello.kind !== undefined && hello.kind !== 'phone') return { verdict: null, refusal: null };
  // A shipped phone always names `app`; `HelloMessage` only makes it
  // optional for a device kind that is never judged against it.
  const version = phoneAppVersion(hello.app ?? '');
  if (version === null || compareVersions(version, minPhoneVersion) >= 0) return { verdict: null, refusal: null };
  const refusal = { version, needed: minPhoneVersion };
  const verdict: HelloVerdict = compareVersions(version, PHONE_KNOWS_APP_TOO_OLD) < 0
    ? { reason: 'protocol' }
    : { reason: 'app_too_old', needed: minPhoneVersion };
  return { verdict, refusal };
}

export function openDeviceChannel(opts: DeviceChannelOptions): Channel {
  return new Channel({
    identity: opts.identity, peerKey: opts.peerKey, role: opts.role, hello: opts.hello, send: opts.send,
    serve: new ServingHalf(opts),
    judge: (hello) => {
      const { verdict, refusal } = judgeHello(hello, opts.minPhoneVersion);
      opts.onAppVersion?.(refusal);
      return verdict;
    },
  });
}
