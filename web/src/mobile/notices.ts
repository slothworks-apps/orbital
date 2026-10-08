import { createNoticeQueue } from '../lib/noticeQueue'

/**
 * The phone's notice queue (`lib/noticeQueue`), its own: nothing shown here is
 * marked as seen on the Mac, nor the other way round (canvas `Feature - Notice
 * toast` acceptance). Shown pinned above the session list by `PinnedNoticeHost`.
 */
export const usePhoneNotices = createNoticeQueue()
