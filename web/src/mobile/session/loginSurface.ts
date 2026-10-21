import type { LoginNoticeSurface } from '../../panels/LoginNotice'
import { sessionServes } from '../version'

/**
 * The lost-login notice as the phone draws it (canvas 62e, 62h), wherever a
 * transcript shows one: the code flow never folded, and nothing asked of a
 * Mac older than the routes (`MAC_FEATURES.profileLogin`) or one whose
 * version is not known yet. `onCodeFocus` is for a screen with a composer to
 * move out of the keyboard's way.
 */
export function phoneLoginSurface(onCodeFocus?: (focused: boolean) => void): LoginNoticeSurface {
  return { phone: true, serves: (sessionId) => sessionServes('profileLogin', sessionId), onCodeFocus }
}
