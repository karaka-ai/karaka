/**
 * Public wire contracts are owned by the application SDK. Transport plugins
 * re-export them so server plugin authors use the same versioned vocabulary.
 */
export {
  EVENT_STREAM_MEDIA_TYPE,
  JSON_MEDIA_TYPE,
  type ChatCompletedEvent as TransportCompletedEvent,
  type ChatErrorEvent as TransportErrorEvent,
  type TransportStreamEvent,
} from '@karaka/sdk'
