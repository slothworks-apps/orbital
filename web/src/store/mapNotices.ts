import { createNoticeQueue } from '../lib/noticeQueue'

/**
 * The Mac's notice queue (`lib/noticeQueue`), shown at the top centre of the
 * map by `ui/MapNoticeHost`. The notifications tip is its first message.
 */
export const useMapNotices = createNoticeQueue()
