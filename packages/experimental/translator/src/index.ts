/** Transient text translation through configurable anonymous Google and Bing endpoints. */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { TranslationProvider, TranslationRequest, TranslationSpec } from './types.ts'
import { TranslationError } from './error.ts'
import { translateText } from './provider.ts'

export type * from './types.ts'
export { TranslationError } from './error.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Experimental transient text translator. */
    translator: Translator
  }
}

/** Routing and bounds for one anonymous provider request. */
export interface Config {
  /** Provider selected when a consumer omits it. */
  provider: TranslationProvider
  /** Google-compatible anonymous translation endpoint. */
  googleEndpoint: string
  /** Bing-compatible Microsoft Edge browser translation endpoint. */
  bingEndpoint: string
  /** Deadline covering the request and complete response body, in milliseconds. */
  timeoutMs: number
  /** Maximum UTF-16 code units per request; at least two to admit one supplementary-plane character. */
  maxTextChars: number
  /** Maximum response body bytes before JSON parsing. */
  maxResponseBytes: number
}

function endpoint(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new Error('Translation endpoint must be an HTTP(S) URL without credentials or a fragment')
  }
  return url.href
}

/** One Host service with explicit routing, cancellation and quiescent unload. */
export default class Translator extends Service {
  static Config = z.object({
    provider: z.union(['google', 'bing'] as const).default('bing'),
    googleEndpoint: z.transform(z.string(), endpoint).default('https://translate.googleapis.com/translate_a/single'),
    bingEndpoint: z.transform(z.string(), endpoint).default('https://edge.microsoft.com/translate/translatetext'),
    timeoutMs: z.natural().min(1).max(2_147_483_647).default(10_000),
    maxTextChars: z.natural().min(2).default(4_000),
    maxResponseBytes: z.natural().min(1).default(1024 * 1024),
  })

  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<string>>()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'translator')
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('Translator service disposed'))
      await Promise.allSettled(this.pending)
    })
  }

  /** Maximum UTF-16 code units accepted by one provider request. */
  get maxTextChars(): number { return this.config.maxTextChars }

  /**
   * Resolve provider and source-language defaults without sending text.
   * @param request - consumer text, destination and optional routing choices.
   * @returns a complete specification; exceeding `maxTextChars` throws `TRANSLATION_TEXT_LIMIT`.
   */
  resolve(request: TranslationRequest): TranslationSpec {
    this.lifetime.signal.throwIfAborted()
    this.assertTextLimit(request.text)
    return { text: request.text, targetLanguage: request.targetLanguage,
      sourceLanguage: request.sourceLanguage ?? 'auto', provider: request.provider ?? this.config.provider }
  }

  /**
   * Translate one resolved specification; the selected provider receives its text.
   * @param spec - complete routing and language choices from `resolve()`.
   * @param signal - optional caller cancellation, combined with service disposal.
   * @returns translated plain text; rejects provider/limit failures and preserves cancellation reasons.
   */
  async translate(spec: TranslationSpec, signal?: AbortSignal): Promise<string> {
    this.lifetime.signal.throwIfAborted()
    this.assertTextLimit(spec.text)
    const combined = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
    combined.throwIfAborted()
    const task = translateText(spec, this.config, combined)
    this.pending.add(task)
    return task.finally(() => { this.pending.delete(task) })
  }

  private assertTextLimit(text: string): void {
    if (text.length > this.config.maxTextChars) {
      throw new TranslationError('TRANSLATION_TEXT_LIMIT', `Translation text exceeds ${this.config.maxTextChars} UTF-16 code units`)
    }
  }
}
