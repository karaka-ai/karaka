/** Deterministic Messages image preparation for Files references and bounded inline fallback. */

import type { AttachmentStore, ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { contentHasImage, LlmError, offloadedImageText, offloadRequestImagesWithPolicy } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ImageAttachmentAccessResolver, Message } from '@deepseek-ai/dsh-llm'
import type { DeepSeekConnectionOptions as Connection } from '../../common/types.ts'
import { resolveRequestImageMaxBytes, resolveRequestImageTarget } from '../../common/request-pricing.ts'
import type { DeepSeekFileId } from '../../common/file-id.ts'
import type { RequestFiles } from '../../common/request-files.ts'

export { deepSeekImageRequestPricing as imagePricing } from '../../common/request-pricing.ts'

function bounds(connection: Connection, representation: 'raw' | 'base64') {
  return {
    representation,
    maxBytes: representation === 'raw' ? connection.maxRequestFilesBytes : connection.maxInlineRequestImageBytes,
    maxImages: connection.maxImagesPerRequest,
    byteQuantum: representation === 'raw' ? connection.imageOffloadByteQuantum : connection.inlineImageOffloadByteQuantum,
    countQuantum: connection.imageOffloadCountQuantum,
  }
}

function* imageRefs(blocks: readonly ContentBlock[]): Generator<ImageAttachmentRef> {
  for (const block of blocks) {
    if (block.type === 'image') yield block.attachment
    else if (block.type === 'tool-result') yield* imageRefs(block.content)
  }
}

/** Normalize retained image references before converting Messages content.
 * @param messages - durable history; never mutated.
 * @param connection - request-local image budgets.
 * @param modelId - target model id.
 * @param attachments - mounted attachment store, required only for image requests.
 * @param access - current execution-world path resolver.
 * @param signal - request cancellation.
 * @returns projected history and prepared image bytes keyed by attachment id.
 */
export async function prepareImages(
  messages: readonly Message[], connection: Connection, modelId: string,
  attachments: AttachmentStore | undefined, access: ImageAttachmentAccessResolver, signal: AbortSignal,
): Promise<{ messages: readonly Message[]; versions: Map<ImageAttachmentRef['attachmentId'], RequestImageAttachment> }> {
  const versions = new Map<ImageAttachmentRef['attachmentId'], RequestImageAttachment>()
  if (!messages.some(message => contentHasImage(message.content))) return { messages, versions }
  const model = connection.models.find(entry => entry.id === modelId)
  if (model?.inputModalities?.includes('image') !== true || attachments === undefined) {
    throw new LlmError('DeepSeek Messages image input requires a vision model and attachment service', 'UNSUPPORTED_CONTENT')
  }
  if (messages.some(message => message.role !== 'user' && contentHasImage(message.content))) {
    throw new LlmError('DeepSeek Messages supports images only in user messages and tool results', 'UNSUPPORTED_CONTENT')
  }
  const offload = (input: readonly Message[], byteLength: (ref: ImageAttachmentRef) => number) => offloadRequestImagesWithPolicy(input, {
    ...bounds(connection, 'raw'),
    placeholder: ref => offloadedImageText(ref, access(ref)),
    byteLength,
  })
  const maxBytes = resolveRequestImageMaxBytes(model)
  const retained = offload(messages, ref => Math.min(ref.bytes, maxBytes))
  for (const message of retained) {
    for (const ref of imageRefs(message.content)) {
      if (!versions.has(ref.attachmentId)) {
        versions.set(ref.attachmentId, await attachments.readImageRequest(ref, resolveRequestImageTarget(model, ref), signal))
      }
    }
  }
  return { messages: offload(retained, ref => (versions.get(ref.attachmentId) as RequestImageAttachment).bytes), versions }
}

/** Apply the inline budget to normalized images after Files resolution fails.
 * @param messages - history already reduced to the Files budget.
 * @param versions - normalized versions prepared for retained references.
 * @param connection - resolved inline bounds.
 * @param access - current execution-world path resolver.
 * @returns transient history within both byte and image-count limits.
 */
export function inlineImages(
  messages: readonly Message[], versions: ReadonlyMap<ImageAttachmentRef['attachmentId'], RequestImageAttachment>,
  connection: Connection, access: ImageAttachmentAccessResolver,
): readonly Message[] {
  return offloadRequestImagesWithPolicy(messages, {
    ...bounds(connection, 'base64'),
    byteLength: ref => (versions.get(ref.attachmentId) as RequestImageAttachment).bytes,
    placeholder: ref => offloadedImageText(ref, access(ref)),
  })
}

/** Resolve retained images to Files ids, recording every occurrence for failure diagnostics.
 * @param messages - history within the Files byte/count budget.
 * @param versions - normalized versions for every retained reference.
 * @param files - request-owned Files resolution and recovery.
 * @returns ids keyed by durable attachment identity.
 */
export async function prepareFileIds(
  messages: readonly Message[], versions: ReadonlyMap<ImageAttachmentRef['attachmentId'], RequestImageAttachment>, files: RequestFiles,
): Promise<Map<ImageAttachmentRef['attachmentId'], DeepSeekFileId>> {
  const ids = new Map<ImageAttachmentRef['attachmentId'], DeepSeekFileId>()
  for (const [index, message] of messages.entries()) {
    let image = 0
    for (const ref of imageRefs(message.content)) {
      const version = versions.get(ref.attachmentId) as RequestImageAttachment
      ids.set(ref.attachmentId, await files.resolve(version, { message: index + 1, image: ++image }))
    }
  }
  return ids
}
