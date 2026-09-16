/**
 * `DeepSeekAdapter`: fetch + SSE against a DeepSeek (OpenAI-compatible)
 * chat-completions endpoint, emitting harness StreamChunks. The adapter is
 * transport-only: connection facts arrive through a thunk resolved once per
 * operation and the bearer token through a per-request resolver, so the
 * registering plugin owns validation, layering, and credential policy.
 *
 * @module dsh-llm-deepseek/adapter
 */

import { attributionHeaders, contentHasImage, CONTEXT_WINDOW_EXCEEDED_CODE, isContextWindowExceededError, isQuotaExceededError, LlmAdapter, LlmError, offloadedImageText, offloadRequestImagesWithPolicy, ProviderRequestId, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  ImageAttachmentAccess,
  LlmModelInfo,
  LlmProviderInfo,
  PreparedAdapterCall,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type {
  AttachmentId,
  AttachmentStore,
  ImageAttachmentRef,
  RequestImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { deadline, idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type {
  DeepSeekLlmApiJson,
  PreparedDeepSeekLlmApiExtensions,
} from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import { serializeRequest, serializeRequestWithImages } from './serialize.ts'
import type { ImageWireLocation } from './serialize.ts'
import { deepSeekImageRequestPricing, resolveRequestImageMaxBytes, resolveRequestImageTarget } from '../../common/request-pricing.ts'
import { catalogModelInfo, modelInfo } from '../../common/model-info.ts'
import type { DeepSeekAdapterOptions, DeepSeekCatalogModel, DeepSeekConnectionOptions } from '../../common/types.ts'
import type { DeepSeekFileStore } from './file-store.ts'
import type { DeepSeekFileId } from './file-id.ts'
import { parseSse } from './sse.ts'
import { translate } from './translate.ts'
import type { WireError, WireRequest } from './types.ts'

const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'
const FILES_API_TIMEOUT_CODE = 'DEEPSEEK_FILES_API_TIMEOUT'
/** Marks a failed file-id resolution that may be retried as an inline request. */
class FileResolutionFailure extends Error {
  constructor(cause: unknown) {
    super('DeepSeek Files API could not resolve a request image.', { cause })
    this.name = 'FileResolutionFailure'
  }
}

function collectImageRefs(
  content: readonly ContentBlock[],
  refs: Map<AttachmentId, ImageAttachmentRef>,
): void {
  for (const block of content) {
    if (block.type === 'image') refs.set(block.attachment.attachmentId, block.attachment)
    else if (block.type === 'tool-result') collectImageRefs(block.content, refs)
  }
}

async function prepareRequestImages(
  options: GenerateOptions,
  attachments: AttachmentStore,
  model: DeepSeekCatalogModel,
  signal: AbortSignal,
): Promise<Map<AttachmentId, RequestImageAttachment>> {
  const refs = new Map<AttachmentId, ImageAttachmentRef>()
  for (const message of options.messages) collectImageRefs(message.content, refs)
  const orderedRefs = [...refs.values()]
  const projected = await Promise.all(orderedRefs.map(
    ref => attachments.readImageRequest(ref, resolveRequestImageTarget(model, ref), signal),
  ))
  return new Map(orderedRefs.map((ref, index) => (
    [ref.attachmentId, projected[index] as RequestImageAttachment]
  )))
}

function providerRejectedNormalizedImage(detail: string): boolean {
  const reasonBeforeImage = /(?:unsupported|invalid|cannot read|failed to (?:decode|process)).{0,40}image/iu
  const imageBeforeReason = /image.{0,40}(?:unsupported|invalid|cannot be decoded)/iu
  return reasonBeforeImage.test(detail) || imageBeforeReason.test(detail)
}

interface UsedRequestFile {
  version: RequestImageAttachment
  fileId: DeepSeekFileId
  location: ImageWireLocation
}

function providerRejectedFileId(detail: string): boolean {
  const file = /\bfile(?:[_ -]?(?:id|api|not[_ -]?found|deleted|expired))?/iu.test(detail)
  const missing = /(?:expired|not[_ -]?found|deleted|do(?:es)? not exist|not created under (?:this|your) account)/iu.test(detail)
  const invalidId = /(?:invalid.{0,20}file[_ -]?(?:id|api)|file[_ -]?(?:id|api).{0,20}invalid)/iu.test(detail)
  return file && (missing || invalidId)
}

function detailNamesFileId(detail: string, fileId: DeepSeekFileId): boolean {
  let index = detail.indexOf(fileId)
  while (index >= 0) {
    const before = detail[index - 1]
    const after = detail[index + fileId.length]
    if ((before === undefined || !/[\p{L}\p{N}_-]/u.test(before))
      && (after === undefined || !/[\p{L}\p{N}_-]/u.test(after))) return true
    index = detail.indexOf(fileId, index + 1)
  }
  return false
}

function staleMappings(
  files: readonly UsedRequestFile[],
  detail: string,
): UsedRequestFile[] {
  const unique = [...new Map(files.map(file => [`${file.version.variantId}\0${file.fileId}`, file])).values()]
  const exact = unique.filter(file => detailNamesFileId(detail, file.fileId))
  return exact.length > 0 ? exact : unique
}

function normalizedImageFacts(
  file: { version: RequestImageAttachment; location: ImageWireLocation },
): string {
  const version = file.version
  const name = version.attachment.name ?? version.attachment.attachmentId
  const colour = version.hasAlpha ? 'sRGBA' : 'sRGB'
  return `"${name}" at message ${file.location.message}, image ${file.location.image} `
    + `(${version.mediaType}, 8-bit ${colour}, ${version.width}x${version.height})`
}

function normalizedImageDiagnostic(
  files: readonly UsedRequestFile[],
  providerMessage: string,
  providerDetail: string,
): string {
  const exact = files.find(file => detailNamesFileId(providerDetail, file.fileId))
  const target = exact ?? (files.length === 1 ? files[0] : undefined)
  if (target !== undefined) {
    return `DeepSeek rejected normalized image ${normalizedImageFacts(target)}: ${providerMessage}. `
      + 'The provider rejected bytes already normalized by the harness; PNG, JPEG, WebP, and GIF remain supported input formats.'
  }
  const candidates = [...new Map(files.map(file => [
    `${file.version.variantId}\0${file.location.message}\0${file.location.image}`,
    file,
  ])).values()]
  return `DeepSeek rejected a normalized request image: ${providerMessage}. Candidate images: `
    + `${candidates.map(normalizedImageFacts).join('; ')}. `
    + 'The provider rejected bytes already normalized by the harness; PNG, JPEG, WebP, and GIF remain supported input formats.'
}


function providerRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1_000
    return Number.isFinite(delay) && delay > 0 ? delay : undefined
  }
  const delay = Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

function requestId(headers: Headers): ReturnType<typeof ProviderRequestId> | undefined {
  const value = headers.get('x-request-id') ?? headers.get('x-deepseek-request-id')
  return value === null || value.length === 0 ? undefined : ProviderRequestId(value)
}

/**
 * Map an HTTP status to a stable LlmError code.
 * @param status - status of a non-2xx provider response.
 * @param error - parsed provider error body, when available.
 * @returns the normalized harness error code.
 */
export function httpErrorCode(status: number, error?: WireError['error']): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 413) return 'INVALID_REQUEST'
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(' ')
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * The first real `LlmAdapter`. One instance serves every model name it was
 * registered under (the harness model name IS the wire model name).
 *
 * One stable signal reaches both initial fetch and body reads. Caller aborts
 * map to `ABORTED`; the configured per-read idle watchdog maps to `TIMEOUT`.
 */
export class ChatCompletionsAdapter extends LlmAdapter {
  private readonly files: DeepSeekFileStore

  constructor(private readonly config: DeepSeekAdapterOptions & { resolveFiles: () => DeepSeekFileStore }) {
    super()
    this.files = config.resolveFiles()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'DeepSeek' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  override imageRequestPricing(_provider: string, model: string): ReturnType<LlmAdapter['imageRequestPricing']> {
    // The same access resolution the serializer uses, so priced handle and
    // placeholder text matches what the request actually sends.
    const attachments = this.config.resolveAttachments?.()
    const resolveAccess = attachments === undefined
      ? undefined
      : (ref: ImageAttachmentRef): ImageAttachmentAccess | undefined => (
        this.config.resolveImageAccess?.(attachments, ref)
      )
    return deepSeekImageRequestPricing(this.config.options(), model, resolveAccess)
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.config.options().models.map(model => catalogModelInfo(provider, model)))
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve(modelInfo(this.config.options(), provider, model))
  }

  override prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const connection = this.config.options()
    return Promise.resolve({
      model: modelInfo(connection, provider, model),
      stream: options => this.streamWithConnection(options, connection),
    })
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithConnection(options, this.config.options())
  }

  private async * streamWithConnection(
    options: GenerateOptions,
    connection: DeepSeekConnectionOptions,
  ): AsyncIterable<StreamChunk> {
    // One resolution per stream call: connection facts and the credential
    // freeze here and hold for this whole request, so an in-flight stream
    // never observes a configuration change and the next call re-resolves.
    // The key resolves *from this snapshot*, so an endpoint and the secret
    // sent to it can never come from different configuration generations.
    const hasImages = options.messages.some(message => contentHasImage(message.content))
    let attachments: AttachmentStore | undefined
    if (hasImages) {
      const model = connection.models.find(entry => entry.id === options.model)
      if (model?.inputModalities?.includes('image') !== true) {
        throw new LlmError(
          `DeepSeek model "${options.model}" does not accept image input.`,
          'UNSUPPORTED_CONTENT',
        )
      }
      attachments = this.config.resolveAttachments?.()
      if (attachments === undefined) {
        throw new LlmError(
          'DeepSeek image conversion requires the durable attachment service.',
          'UNSUPPORTED_CONTENT',
        )
      }
    }
    const apiKey = await this.config.resolveApiKey(connection)
    const userId = this.config.resolveUserId()
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
    const iterator = this.request(
      options,
      watchdog.signal,
      connection,
      apiKey,
      userId,
      attachments,
      () => { watchdog.pulse() },
    )[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `DeepSeek stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('DeepSeek request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(`DeepSeek API stream from ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
    } finally {
      consumer.abort('DeepSeek stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch (_abortedTransportTeardown) {
          // The consumer controller already owns termination; a return-time abort cannot add a second outcome.
        }
      }
    }
  }

  private async * request(
    options: GenerateOptions,
    signal: AbortSignal,
    connection: DeepSeekConnectionOptions,
    apiKey: string,
    userId: AnonymousUserId,
    attachments: AttachmentStore | undefined,
    onActivity: () => void,
  ): AsyncIterable<StreamChunk> {
    const headers = {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      ...attributionHeaders(),
      'x-deepseek-harness-user-id': String(userId),
      ...options.sessionId !== undefined
        ? { 'x-deepseek-harness-session-id': String(options.sessionId) }
        : {},
      ...options.purpose === 'compaction'
        ? { 'x-deepseek-harness-compact': '1' }
        : {},
    }

    const fileConnection = { baseURL: connection.baseURL, apiKey }
    const model = connection.models.find(entry => entry.id === options.model)
    const maxBytes = model === undefined ? undefined : resolveRequestImageMaxBytes(model)
    const resolveImageAccess = attachments === undefined
      ? undefined
      : (ref: ImageAttachmentRef): ImageAttachmentAccess | undefined => this.config.resolveImageAccess?.(attachments, ref)
    const imageAccessOptions = resolveImageAccess === undefined ? {} : { resolveImageAccess }
    const requestMessages = maxBytes === undefined ? options.messages : offloadRequestImagesWithPolicy(options.messages, {
      representation: 'raw',
      maxBytes: connection.maxRequestFilesBytes,
      maxImages: connection.maxImagesPerRequest,
      byteQuantum: connection.imageOffloadByteQuantum,
      countQuantum: connection.imageOffloadCountQuantum,
      byteLength: ref => Math.min(ref.bytes, maxBytes),
      placeholder: ref => offloadedImageText(ref, resolveImageAccess?.(ref)),
    })
    const requestOptions = requestMessages === options.messages ? options : { ...options, messages: [...requestMessages] }
    const requestImages = attachments === undefined || model === undefined
      ? new Map<AttachmentId, RequestImageAttachment>()
      : await prepareRequestImages(requestOptions, attachments, model, signal)
    let representation: 'file' | 'base64' = 'file'
    let fileAttempt = 0
    while (true) {
      const usedFiles: UsedRequestFile[] = []
      let body: WireRequest
      if (attachments === undefined) {
        body = serializeRequest(requestOptions, connection.defaults)
      } else if (representation === 'base64') {
        body = await serializeRequestWithImages(requestOptions, {
          representation: { kind: 'base64' },
          requestImages,
          ...imageAccessOptions,
          maxRequestImageBytes: connection.maxInlineRequestImageBytes,
          maxImagesPerRequest: connection.maxImagesPerRequest,
          byteQuantum: connection.inlineImageOffloadByteQuantum,
          countQuantum: connection.imageOffloadCountQuantum,
        }, connection.defaults)
      } else {
        try {
          body = await serializeRequestWithImages(requestOptions, {
            representation: {
              kind: 'file',
              resolveFileId: async (version, _block, location) => {
                using filesDeadline = deadline(signal, connection.filesApiTimeoutMs, FILES_API_TIMEOUT_CODE)
                let resolved: Awaited<ReturnType<DeepSeekFileStore['ensureUploaded']>>
                try {
                  resolved = await this.files.ensureUploaded(
                    version,
                    fileConnection,
                    connection.filePolicy,
                    filesDeadline.signal,
                  )
                } catch (error: unknown) {
                  if (signal.aborted) throw error
                  throw new FileResolutionFailure(error)
                }
                onActivity()
                usedFiles.push({ version, fileId: resolved.record.fileId, location })
                return resolved.record.fileId
              },
            },
            requestImages,
            ...imageAccessOptions,
            maxRequestImageBytes: connection.maxRequestFilesBytes,
            maxImagesPerRequest: connection.maxImagesPerRequest,
            byteQuantum: connection.imageOffloadByteQuantum,
            countQuantum: connection.imageOffloadCountQuantum,
          }, connection.defaults)
        } catch (error: unknown) {
          if (!(error instanceof FileResolutionFailure)) throw error
          representation = 'base64'
          continue
        }
      }
      let extensions: PreparedDeepSeekLlmApiExtensions
      try {
        extensions = await this.config.prepareExtensions({
          body: body as unknown as Readonly<Record<string, DeepSeekLlmApiJson>>,
          signal,
          ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
          ...options.purpose === undefined ? {} : { purpose: options.purpose },
        })
      } catch (error) {
        throw new LlmError('DeepSeek request extension preparation failed', 'REQUEST_EXTENSION', { cause: error })
      }
      for (const field of Object.keys(extensions.fields)) {
        if (Object.hasOwn(body, field)) {
          throw new LlmError(`DeepSeek request extension field ${JSON.stringify(field)} collides with the base request`, 'REQUEST_EXTENSION')
        }
      }
      // Prepared outside the try so the TRANSPORT label below covers exactly the
      // transport boundary, never a serialization failure.
      const payload = JSON.stringify({ ...body, ...extensions.fields })

      // TODO(http): adopt the Cordis HTTP service when shared transport configuration
      // outweighs its additional runtime dependencies.
      let response: Response
      try {
        response = await fetch(`${connection.baseURL}/chat/completions`, {
          method: 'POST',
          headers,
          body: payload,
          signal,
        })
      } catch (error: unknown) {
        if (signal.aborted) throw error
        throw new LlmError(
          `DeepSeek API request to ${connection.baseURL} failed`,
          'TRANSPORT',
          { cause: error },
        )
      }

      if (!response.ok) {
        let message = `DeepSeek API error (HTTP ${response.status})`
        let providerError: WireError['error']
        const rawResponse = await response.text()
        try {
          const parsed = JSON.parse(rawResponse) as WireError
          providerError = parsed.error
          if (providerError?.message) message = providerError.message
        } catch {
          // The HTTP status remains authoritative when a gateway returns malformed JSON.
        }
        const detail = [providerError?.code, providerError?.type, providerError?.message]
          .filter((field): field is string => typeof field === 'string')
          .join(' ')
        const staleFile = usedFiles.length > 0 && providerRejectedFileId(detail)
        if (staleFile) {
          await Promise.all(staleMappings(usedFiles, detail).map(file => (
            this.files.invalidate(file.version, file.fileId, fileConnection)
          )))
          if (fileAttempt === 0) {
            fileAttempt += 1
            continue
          }
        }
        if (response.status === 400 && usedFiles.length > 0 && providerRejectedNormalizedImage(detail)) {
          message = normalizedImageDiagnostic(usedFiles, message, detail)
        }
        const delay = providerRetryAfterMs(response.headers.get('retry-after'))
        const id = requestId(response.headers)
        throw new LlmError(message, httpErrorCode(response.status, providerError), {
          cause: new Error(rawResponse.length > 0 ? rawResponse : `DeepSeek HTTP ${response.status}`),
          status: response.status,
          ...delay === undefined ? {} : { providerRetryAfterMs: delay },
          ...id === undefined ? {} : { requestId: id },
        })
      }
      try {
        await extensions.accept()
      } catch (error) {
        throw new LlmError('DeepSeek request extension acceptance failed', 'REQUEST_EXTENSION', { cause: error })
      }
      if (!response.body) {
        throw new LlmError('DeepSeek API returned no response body', 'EMPTY_RESPONSE')
      }

      yield* translate(parseSse(response.body, onActivity))
      return
    }
  }
}
