import type { ChatMessage } from './types'

/**
 * Which transcript rows wait behind the live hook row (canvas `Feature - Stop
 * hook` 1a, 1g): the user turns the Mac names in the notice
 * (`notice.hook.waiting`), whichever window, phone or API sent them and
 * whatever id this tab holds them under. Nothing else: a turn this tab sent
 * waits once its send has answered with the uuid the Mac names, and a Mac
 * that names none leaves every row ordinary. Undefined while no row is up.
 */
export function waitingBehind(notice: ChatMessage | undefined): ((message: ChatMessage) => boolean) | undefined {
  if (!notice) return undefined
  const named = new Set(notice.notice?.hook?.waiting ?? [])
  return (message) => message.role === 'user' && message.uuid !== undefined && named.has(message.uuid)
}
