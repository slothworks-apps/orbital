import { isPendingTurn } from '../store/store'
import type { ChatMessage } from './types'

/**
 * Which transcript rows wait behind the live hook row (canvas `Feature - Stop
 * hook` 1a, 1g): the user turns the Mac names in the notice
 * (`notice.hook.waiting`), whichever window, phone or API sent them and
 * whatever id this tab holds them under, and the turns this tab holds that
 * the file has not echoed yet. Undefined while no row is up: every row is
 * then an ordinary one again.
 */
export function waitingBehind(notice: ChatMessage | undefined): ((message: ChatMessage) => boolean) | undefined {
  if (!notice) return undefined
  const named = new Set(notice.notice?.hook?.waiting ?? [])
  return (message) =>
    message.role === 'user' && (isPendingTurn(message) || (message.uuid !== undefined && named.has(message.uuid)))
}
