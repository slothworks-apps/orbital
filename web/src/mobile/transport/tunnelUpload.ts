import type { UploadLike } from '../../lib/api'
import { ATTACHMENT_MAX_BYTES } from '../../lib/attachments'
import type { TunnelClient } from './clientRef'

/**
 * `api.uploadAttachment` on the phone (`configureApi({ upload })`, spec
 * § 6.2): the file's bytes go to the Mac as one blob, and its answers map
 * onto the desktop's upload contract, so the chips, refusals and retry are
 * the desktop's. A `TunnelError` rejects as it is — the chip then reads
 * "didn't upload" with retry. The session is irrelevant (the Mac's image
 * store is global) and `signal` is ignored: a blob on its way cannot be
 * recalled.
 *
 * The phone sends images only. What the Mac would refuse anyway — a file
 * past `ATTACHMENT_MAX_BYTES`, or one whose type is not an image (a pasted
 * file) — is refused here, before its bytes are read or cross the tunnel.
 */
export function makeTunnelUpload(client: Pick<TunnelClient, 'putBlob'>): UploadLike {
  return async (_sessionId, file) => {
    if (file.size === 0) return { kind: 'empty' }
    // The phone knows the whole file, so the size is exact.
    if (file.size > ATTACHMENT_MAX_BYTES) return { kind: 'too_large', size: file.size, truncated: false }
    if (!file.type.startsWith('image/')) return { kind: 'not_image', mediaType: file.type }
    const bytes = new Uint8Array(await file.arrayBuffer())
    const result = await client.putBlob(bytes, file.type)
    switch (result.kind) {
      case 'ok':
        return { kind: 'ok', entry: result.entry }
      case 'too_large':
        return { kind: 'too_large', size: file.size, truncated: false }
      case 'not_image':
        return { kind: 'not_image', mediaType: file.type }
      default: {
        const unknown: never = result
        throw new Error(`unexpected putBlob answer: ${JSON.stringify(unknown)}`)
      }
    }
  }
}
