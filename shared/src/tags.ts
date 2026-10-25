/**
 * Tags as the Mac announces them (spec 2026-10-25-tag-toggles-and-order-design
 * § Sync): one frame on every change of the tag list — a tag made, renamed,
 * recoloured, moved on the map, deleted, or the order set — and the desktop
 * web and the phone read `GET /api/tags` again. The frame carries no list, so
 * the phone's merge across Macs stays in one place, its own `listTags`.
 */

/** The hub topic a change of the tag list is published on. */
export const TAGS_TOPIC = 'tags';

/** The one frame on `TAGS_TOPIC`. */
export interface TagsChangedFrame {
  event: 'changed';
}
