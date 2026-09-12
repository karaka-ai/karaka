# Karaka application HTTP transport

Backend applications authenticate through `serverAuth`, supply tenant/user identity, and call the standalone SDK's `/v1` JSON and SSE API. This package owns application operations; it does not mount DSH Host remotes or replace DSH Session, Agent, query, persistence or the loop.

Chat creation reserves durable Karaka identity before creating an original DSH Agent. Unpublished setup binds the original header, mounts the chosen preset, and installs original model-selection hooks. Creation is acknowledged after JSONL flush and authority publication. Resume authorizes persisted data before activating the original Agent and checks its reconstructed Session again during setup.

Mutating operations serialize per chat. Prompt admission checks durable inbox/user history for the SDK request id and flushes before acknowledging either new or duplicate requests. History and snapshot-first SSE authorize the requested owner. Cancellation retains the inbox; model changes use DSH's existing model-selection event and request routing.

Optional `browserPath` mounts the existing applicationAgents/Create/Prompt/History/Follow/Cancel facade under a separate path, together with an owner-filtered approval/question event channel and response route. `browserMethods` and `browserEvents` select the server capabilities. The browser-safe `./browser` entry preserves `createBrowserClient`, per-instance renewable credentials, `forChat().$on`, state/generation observers, explicit reconnect and disposal. Its default route is `/karaka/browser`. `browserOrigins` must explicitly list allowed origins, and `@karaka-ai/browser-auth` verifies JWT claims. The request identity must equal the signed owner, and a stream closes when its credential expires. This endpoint does not implement the DSH browser Connection protocol.

## Model Experience

Application identity changes authorization, not model input. Presets supply the model-facing tools and persona. HTTP prompts enter DSH's normal durable inbox; model selection uses DSH's existing request hooks and switch notices.

## Known Limitations and Deferred Work

The selected validation is one end-to-end flow. Browser client integration, image admission, interaction responses, model changes and concurrency are not separately verified. Streams project durable complete assistant messages and transient text deltas from original DSH assistant-stream events. Transient deltas share the current durable cursor and are preview data: they do not advance replay position, and the complete settled message is authoritative. The existing SDK has no per-attempt rollback/reset event, so cancelled/retried partial previews require consumer reconciliation. Pending questions remain process-local, as in the existing transport. The application profile must not expose unfiltered Host remotes against this data store.
