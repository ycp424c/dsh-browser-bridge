/**
 * Shared fixture: an in-memory `attachments` cordis service.
 *
 * The bridge plugin declares `attachments` in its OWN inject list, so tests
 * that mount the plugin (apply) or assemble its pre-step dependencies
 * (pre-step, composition) register this fake on the plugin/root context. The
 * store is passed to `registerTurnTools` explicitly; the agent-scoped tool
 * registry never resolves it.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import {
  AttachmentId,
  type ImageAttachmentLimits,
  type ImageAttachmentRef,
  type SaveImageAttachment,
  type StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'

const IMAGE_LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 10 * 1024 * 1024,
  maxImagesPerMessage: 8,
  maxMessageImageBytes: 40 * 1024 * 1024,
  maxImagePixels: 40_000_000,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

/** In-memory `attachments` service: accepts and stores anything, no decoding. */
export class FakeAttachments extends Service {
  readonly imageLimits = IMAGE_LIMITS
  private readonly store = new Map<string, StoredImageAttachment>()

  constructor(ctx: Context) {
    super(ctx, 'attachments')
  }

  async validateImage(_input: SaveImageAttachment): Promise<void> {
    // The fake accepts any declared media type without decoding bytes.
  }

  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    const ref: ImageAttachmentRef = {
      attachmentId: AttachmentId(`fake-${this.store.size + 1}`),
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 0,
      height: 0,
      name: input.name,
    }
    this.store.set(ref.attachmentId, { ref, data: input.data })
    return ref
  }

  async readImage(ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    const stored = this.store.get(ref.attachmentId)
    if (!stored) throw new Error(`FakeAttachments: unknown attachment ${ref.attachmentId}`)
    return stored
  }
}
