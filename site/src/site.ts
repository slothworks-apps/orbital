/**
 * The site's build-time constants: where the download and store buttons go,
 * and whether the phone apps are still invite-only.
 */

export type PhoneRelease = 'testers' | 'public'

/**
 * Switch every text and button the canvas switches with its `release`
 * tweak, one store at a time: the iPhone app went public before the Android
 * one. Going public on a store is its line here plus its URL below.
 */
export const IPHONE_RELEASE = 'public' as PhoneRelease
export const ANDROID_RELEASE = 'testers' as PhoneRelease

export const SITE_URL = 'https://orbital.slothworks.io'

export const REPO_URL = 'https://github.com/slothworks-apps/orbital'

/**
 * The Latest release, not a numbered release or an asset: asset names carry
 * the version, and Latest is always the current stable one. The releases
 * list would put the newest prerelease first, which only the experimental
 * channel gets (spec 2026-11-02-experimental-release-channel-design).
 */
export const RELEASES_URL = `${REPO_URL}/releases/latest`

/** Each is empty until its store's release is 'public'. */
export const APP_STORE_URL = 'https://apps.apple.com/app/id6819307405'
export const PLAY_URL = ''

export const CONTACT_EMAIL = 'orbital@slothworks.io'

/**
 * Both stores invite testers by e-mail, which must not be public, so the
 * request is an e-mail rather than a GitHub issue. The body lists what an
 * invite needs, so the first message is enough.
 */
const INVITE_BODY = [
  'Hello,',
  '',
  "I'd like to try the Orbital phone app.",
  '',
  'Platform (iPhone or Android): ',
  'E-mail of the Apple ID or Google account to invite: ',
  "Relay (I run my own / I'd like to use yours): ",
  '',
].join('\r\n') // RFC 6068: line breaks in a mailto body are CRLF.

export const INVITE_MAILTO =
  `mailto:${CONTACT_EMAIL}` +
  `?subject=${encodeURIComponent('Orbital invite')}` +
  `&body=${encodeURIComponent(INVITE_BODY)}`
