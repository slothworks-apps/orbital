/**
 * The remote's failed-start reasons that callers tell apart by value: the
 * status carries them as `error`, and the `orbital` CLI reads them without
 * loading the service.
 */

/**
 * A failed start's reason while `remote_relay_url` is empty: there is no
 * default relay, every Mac names its own.
 */
export const NO_RELAY_URL_ERROR = 'no relay URL — set one under Advanced';

/**
 * Why the remote stopped after the relay closed with `CLOSE_BAD_SECRET`: the
 * client does not retry, since only the user can change the secret.
 */
export const BAD_SECRET_ERROR = 'The relay refused the relay secret. Check it under Advanced.';
