/** Direct Messages transport with one cancellable lifecycle per model request. */

import { attributionHeaders, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ImageAttachmentAccessResolver, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { modelInfo } from '../../common/model-info.ts'
import type { DeepSeekConnectionOptions as Connection } from '../../common/types.ts'
import { imagePricing, prepareImages } from './images.ts'
import { serialize } from './serialize.ts'
import { parseSse } from './sse.ts'
import { translate } from './translate.ts'
import { providerError } from './transport.ts'

/** Request-local dependencies supplied by the owning Cordis plugin. */
export interface AdapterDependencies {
  /** Resolve a single validated configuration generation. */
  connection(): Connection
  /** Resolve the key named by that same generation. */
  apiKey(connection: Connection): Promise<string>
  /** Stable anonymous Harness identity. */
  userId(): string
  /** Current attachment service; absence is valid for text requests. */
  attachments(): AttachmentStore | undefined
  /** Current execution-world attachment path. */
  imageAccess: ImageAttachmentAccessResolver
  /** Report discarded replay metadata without exposing durable content or signatures. */
  onReplayDegrade?: (detail: { provider: string; model: string; reason: string }) => void
}

/** DeepSeek provider using Messages content and native thinking replay. */
export class DeepSeekMessagesAdapter extends LlmAdapter {
  constructor(private readonly dependencies: AdapterDependencies) { super() }

  override providerInfo(provider: string) { return { id: provider, name: 'DeepSeek' } }
  override providerRetryPolicy(_provider: string) { return this.dependencies.connection().retryPolicy }
  override listModels(provider: string) {
    const connection = this.dependencies.connection()
    return Promise.resolve(connection.models.map(model => modelInfo(connection, provider, model.id)))
  }
  override resolveModel(provider: string, model: string) {
    return Promise.resolve(modelInfo(this.dependencies.connection(), provider, model))
  }
  override imageRequestPricing(_provider: string, model: string) {
    return imagePricing(this.dependencies.connection(), model, this.dependencies.imageAccess)
  }
  override prepareCall(provider: string, model: string): Promise<PreparedAdapterCall> {
    const connection = this.dependencies.connection()
    return Promise.resolve({ model: modelInfo(connection, provider, model), stream: options => this.generate(options, connection) })
  }
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.generate(options, this.dependencies.connection())
  }

  private async * generate(options: GenerateOptions, connection: Connection): AsyncGenerator<StreamChunk> {
    const consumer = new AbortController()
    const signal = options.signal === undefined ? consumer.signal : AbortSignal.any([consumer.signal, options.signal])
    using watchdog = idleWatchdog(signal, connection.streamIdleTimeoutMs, 'MESSAGES_IDLE')
    const iterator = this.request(options, connection, watchdog.signal, () => { watchdog.pulse() })
    try {
      while (true) {
        const next = await watchdog.next(iterator)
        if (next.done) return
        yield next.value
      }
    } catch (error) {
      if (timeoutOf(watchdog.signal, 'MESSAGES_IDLE') !== undefined) throw new LlmError('DeepSeek Messages stream idle timeout', 'TIMEOUT', { cause: error })
      if (options.signal?.aborted) throw new LlmError('DeepSeek Messages request aborted', 'ABORTED', { cause: error })
      if (error instanceof LlmError) throw error
      throw new LlmError('DeepSeek Messages transport failed', 'TRANSPORT', { cause: error })
    } finally {
      consumer.abort()
      try { await iterator.return(undefined) } catch (_abortedRequestCleanup) {
        // The request already settled; aborting its reader cannot replace that outcome.
      }
    }
  }

  private async * request(
    options: GenerateOptions, connection: Connection, signal: AbortSignal, activity: () => void,
  ): AsyncGenerator<StreamChunk> {
    signal.throwIfAborted()
    const { messages, versions } = await prepareImages(
      options.messages, connection, options.model, this.dependencies.attachments(), this.dependencies.imageAccess, signal,
    )
    const body = serialize(options, connection, messages, versions, this.dependencies.imageAccess, (reason) => {
      this.dependencies.onReplayDegrade?.({ provider: options.provider, model: options.model, reason })
    })
    const key = await this.dependencies.apiKey(connection)
    signal.throwIfAborted()
    const response = await fetch(`${connection.baseURL.replace(/\/+$/u, '')}/v1/messages`, {
      method: 'POST', signal, body: JSON.stringify(body),
      headers: {
        ...attributionHeaders(),
        'content-type': 'application/json', 'accept': 'text/event-stream',
        'x-api-key': key, 'anthropic-version': '2023-06-01',
        'x-deepseek-harness-user-id': this.dependencies.userId(),
        ...options.sessionId === undefined ? {} : { 'x-deepseek-harness-session-id': String(options.sessionId) },
        ...options.purpose === 'compaction' ? { 'x-deepseek-harness-compact': '1' } : {},
      },
    })
    if (!response.ok) {
      const text = await response.text()
      let raw: unknown
      try { raw = JSON.parse(text) } catch (_nonJsonGatewayError) {
        // HTTP status is authoritative when a gateway does not return JSON.
      }
      throw providerError(raw, response.status, response.headers)
    }
    if (response.body === null) throw new LlmError('DeepSeek Messages returned no response body', 'EMPTY_RESPONSE')
    yield* translate(parseSse(response.body, activity), options.model)
  }
}
