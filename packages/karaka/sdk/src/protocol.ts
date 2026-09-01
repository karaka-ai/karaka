/** HTTP wire contract shared by the Karaka backend client and server transport. */

import { z } from 'zod'

/** Default route prefix shared by the application client and server transport. */
export const KARAKA_APPLICATION_API_PATH = '/v1'

/** Trusted tenant and user identity supplied by an authenticated application server. */
export const ApplicationIdentitySchema = z.strictObject({
  tenantId: z.string().min(1),
  userId: z.string().min(1),
})
/** Runtime-validated application identity. */
export type ApplicationIdentity = z.infer<typeof ApplicationIdentitySchema>

/** Provider, model, and optional adapter-specific reasoning selection. */
export const ApplicationModelSelectionSchema = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1).optional(),
})
/** Runtime-validated model selection. */
export type ApplicationModelSelection = z.infer<typeof ApplicationModelSelectionSchema>

/** Text or inline encoded image accepted at the application boundary. */
export const ApplicationChatContentSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), text: z.string().min(1) }),
  z.strictObject({
    type: z.literal('image'),
    mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
    data: z.string().min(1),
    name: z.string().min(1).optional(),
  }),
])
/** Runtime-validated application chat content. */
export type ApplicationChatContent = z.infer<typeof ApplicationChatContentSchema>

/** Discoverable Agent Preset metadata exposed to applications. */
export const ApplicationAgentSummarySchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
})
/** Runtime-validated Agent summary. */
export type ApplicationAgentSummary = z.infer<typeof ApplicationAgentSummarySchema>

/** Stable SSE and history event vocabulary exposed to applications. */
export const ApplicationChatEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('snapshot'), cursor: z.number().int().min(-1) }),
  z.strictObject({ type: z.literal('text-delta'), cursor: z.number().int().min(-1), text: z.string() }),
  z.strictObject({ type: z.literal('user-message'), cursor: z.number().int().min(-1), content: z.unknown() }),
  z.strictObject({ type: z.literal('assistant-message'), cursor: z.number().int().min(-1), content: z.unknown() }),
  z.strictObject({
    type: z.literal('tool-call'),
    cursor: z.number().int().min(-1),
    callId: z.string().min(1),
    name: z.string(),
    arguments: z.string(),
  }),
  z.strictObject({
    type: z.literal('tool-result'),
    cursor: z.number().int().min(-1),
    callId: z.string().min(1),
    content: z.unknown(),
  }),
  z.strictObject({
    type: z.literal('interaction-required'),
    cursor: z.number().int().min(-1),
    interactionId: z.string().min(1),
    questions: z.unknown(),
  }),
  z.strictObject({ type: z.literal('turn-end'), cursor: z.number().int().min(-1), reason: z.unknown() }),
  z.strictObject({ type: z.literal('error'), code: z.string(), message: z.string() }),
])
/** Runtime-validated application chat event. */
export type ApplicationChatEvent = z.infer<typeof ApplicationChatEventSchema>

/** Create-chat request after application-server authentication. */
export const ApplicationCreateChatRequestSchema = ApplicationIdentitySchema.extend({
  agentId: z.string().min(1),
  chatId: z.string().min(1),
}).strict()

/** Idempotent message-admission request. */
export const ApplicationPromptRequestSchema = ApplicationIdentitySchema.extend({
  requestId: z.string().min(1),
  content: z.array(ApplicationChatContentSchema).min(1),
}).strict()

/** Identity-bound request addressing one chat. */
export const ApplicationAddressRequestSchema = ApplicationIdentitySchema.extend({
  cursor: z.number().int().min(-1).optional(),
}).strict()

/** Identity-bound model-selection request. */
export const ApplicationModelRequestSchema = ApplicationIdentitySchema
  .extend(ApplicationModelSelectionSchema.shape)
  .strict()

/** Identity-bound answer to a pending structured interaction. */
export const ApplicationRespondRequestSchema = ApplicationIdentitySchema.extend({
  interactionId: z.string().min(1),
  answers: z.strictObject({
    answers: z.array(z.strictObject({
      id: z.string().min(1),
      selected: z.array(z.string()),
      custom: z.string().optional(),
    })),
  }),
}).strict()

/** Accepted chat identity and selected Agent response. */
export const ApplicationCreateChatResponseSchema = z.strictObject({
  chatId: z.string().min(1),
  agentId: z.string().min(1),
})

/** Idempotent message-admission receipt. */
export const ApplicationChatReceiptSchema = z.strictObject({
  chatId: z.string().min(1),
  requestId: z.string().min(1),
  accepted: z.literal(true),
  duplicate: z.boolean(),
})
/** Runtime-validated message-admission receipt. */
export type ApplicationChatReceipt = z.infer<typeof ApplicationChatReceiptSchema>

/** Complete projected application chat history. */
export const ApplicationChatHistorySchema = z.strictObject({
  chatId: z.string().min(1),
  events: z.array(ApplicationChatEventSchema),
})
/** Runtime-validated application chat history. */
export type ApplicationChatHistory = z.infer<typeof ApplicationChatHistorySchema>

/** Generic accepted-operation response. */
export const ApplicationAcceptedResponseSchema = z.strictObject({ accepted: z.literal(true) })
/** Committed model-selection response. */
export const ApplicationModelResponseSchema = z.strictObject({ selected: ApplicationModelSelectionSchema })
