/**
 * Which releases this group's devices take (spec
 * 2026-11-02-experimental-release-channel-design § The switch; ADR
 * a-release-reaches-experimental-before-stable). A group-shared setting:
 * the Mac reads it into electron-updater's `allowPrerelease`, a Linux
 * server into its apt suite, the phone into its Beam channel.
 */

/** The setting: `experimental`, or absent for stable. */
export const UPDATE_CHANNEL_KEY = 'update_channel';

export type UpdateChannel = 'experimental' | 'stable';

/** Only the exact word `experimental` is experimental; anything else, absent included, is stable. */
export function parseUpdateChannel(value: unknown): UpdateChannel {
  return value === 'experimental' ? 'experimental' : 'stable';
}

/**
 * What the switch says, in Settings → Updates and in `orbital experimental`
 * (canvas `Feature - Experimental updates` 1h): the row's two lines and the
 * question turning it on asks. `inGroup`: another Mac, server or phone is in
 * this device's group; alone, the words name this device: `Mac`, or
 * `server` in the headless CLI.
 */
export function experimentalUpdatesWords(inGroup: boolean, device: 'Mac' | 'server' = 'Mac'): {
  lines: [string, string];
  question: string;
  body: string;
} {
  return {
    lines: inGroup
      ? [
          'Every Mac, server and the phone in this group get each new release before everyone else.',
          'Turning it off doesn’t go back: they keep their version until the regular release catches up.',
        ]
      : [
          `This ${device} gets each new release before everyone else.`,
          'Turning it off doesn’t go back: it keeps its version until the regular release catches up.',
        ],
    question: inGroup
      ? 'Turn on experimental updates for every device in this group?'
      : `Turn on experimental updates for this ${device}?`,
    body: 'Experimental releases are for testing new builds and may not work as expected. The regular release usually follows a few days later.',
  };
}
