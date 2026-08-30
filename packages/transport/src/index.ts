import type { AgentChatRunResult, AgentRuntimeTextDelta } from '@karaka/agent-runtime'

/** Stable media types understood by first-party application transports. */
export const JSON_MEDIA_TYPE = 'application/json'
export const EVENT_STREAM_MEDIA_TYPE = 'text/event-stream'

/** Final event written after a streamed durable chat turn commits. */
export interface TransportCompletedEvent {
  readonly type: 'completed'
  readonly result: AgentChatRunResult
}

/** Error envelope shared by JSON and streaming transports. */
export interface TransportErrorEvent {
  readonly type: 'error'
  readonly error: {
    readonly code: string
    readonly message: string
  }
}

export type TransportStreamEvent = AgentRuntimeTextDelta | TransportCompletedEvent | TransportErrorEvent
