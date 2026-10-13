/** Provider-independent inputs to the experimental translation service. */

/** Anonymous browser endpoint selected for one translation. */
export type TranslationProvider = 'google' | 'bing'

/** Text and provider-supported language tags supplied by a consumer. */
export interface TranslationRequest {
  /** Complete text submitted to the selected provider. */
  readonly text: string
  /** Destination language; common Chinese locale tags are normalized per provider. */
  readonly targetLanguage: string
  /** Source language; omission uses automatic detection. */
  readonly sourceLanguage?: string
  /** Endpoint selection; omission uses the service's configured provider. */
  readonly provider?: TranslationProvider
}

/** Fully resolved routing and language choices for one provider request. */
export interface TranslationSpec {
  /** Complete text submitted to the selected provider. */
  readonly text: string
  /** Destination language tag. */
  readonly targetLanguage: string
  /** Source language tag, or `auto` for automatic detection. */
  readonly sourceLanguage: string
  /** Selected anonymous browser endpoint. */
  readonly provider: TranslationProvider
}

/** Failures distinct from caller cancellation and service disposal. */
export type TranslationErrorCode = 'TRANSLATION_TEXT_LIMIT' | 'TRANSLATION_HTTP_ERROR'
  | 'TRANSLATION_INVALID_RESPONSE' | 'TRANSLATION_RESPONSE_LIMIT' | 'TRANSLATION_REQUEST_FAILED' | 'TRANSLATION_TIMEOUT'
