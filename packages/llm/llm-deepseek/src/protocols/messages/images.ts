/** Deterministic inline image projection and matching conservative token pricing. */

import type { AttachmentStore, ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { contentHasImage, LlmError, offloadedImagePrefixCount, offloadedImageText, offloadRequestImagesWithPolicy, requestImageHandleText, textOnlyImageText } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ImageAttachmentAccessResolver, LlmImageRequestPricing, Message } from '@deepseek-ai/dsh-llm'
import { deepSeekImageTokens } from '../../common/image-tokens.ts'
import type { DeepSeekConnectionOptions as Connection } from '../../common/types.ts'
import { resolveRequestImageTarget } from '../../common/request-pricing.ts'


function bounds(connection: Connection) {
  return {
    maxBytes: connection.maxInlineRequestImageBytes,
    maxImages: connection.maxImagesPerRequest,
    byteQuantum: connection.inlineImageOffloadByteQuantum,
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
  const offload = (input: readonly Message[], byteLength?: (ref: ImageAttachmentRef) => number) => offloadRequestImagesWithPolicy(input, {
    ...bounds(connection), representation: 'base64',
    placeholder: ref => offloadedImageText(ref, access(ref)),
    ...byteLength === undefined ? {} : { byteLength },
  })
  const retained = offload(messages)
  for (const message of retained) {
    for (const ref of imageRefs(message.content)) {
      if (!versions.has(ref.attachmentId)) {
        versions.set(ref.attachmentId, await attachments.readImageRequest(ref, resolveRequestImageTarget(model, ref), signal))
      }
    }
  }
  return { messages: offload(retained, ref => (versions.get(ref.attachmentId) as RequestImageAttachment).bytes), versions }
}

/** Price the durable image projection; actual encoded lengths may require further offload.
 * @param connection - validated byte/count budgets.
 * @param modelId - exact model route.
 * @param access - same path resolver used for model-visible image descriptions.
 * @returns per-image visual tokens and descriptor text; provider usage remains authoritative.
 */
export function imagePricing(connection: Connection, modelId: string, access: ImageAttachmentAccessResolver): LlmImageRequestPricing {
  const model = connection.models.find(entry => entry.id === modelId)
  if (model?.inputModalities?.includes('image') !== true) {
    return { priceImages: refs => refs.map(ref => ({ visualTokens: 0, text: textOnlyImageText(ref) })) }
  }
  return { priceImages: (refs) => {
    const omitted = offloadedImagePrefixCount(refs.map(ref => 4 * Math.ceil(ref.bytes / 3)), bounds(connection))
    return refs.map((ref, index) => {
      if (index < omitted) return { visualTokens: 0, text: offloadedImageText(ref, access(ref)) }
      const dimensions = resolveRequestImageTarget(model, ref)
      return {
        visualTokens: deepSeekImageTokens(dimensions.width, dimensions.height),
        text: requestImageHandleText(ref, dimensions, access(ref)),
      }
    })
  } }
}
