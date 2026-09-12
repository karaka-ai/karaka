# Karaka Application MCP

Application tools register only in authorized Agent scopes. The bridge resolves trusted ownership and current credentials before dispatching authenticated MCP requests. Original DSH Tools owns execution and errors.

Input schemas must use DSH's supported object-rooted JSON Schema subset. The root `$schema` dialect marker is omitted; unsupported schema keywords reject catalog admission. Before an MCP call, the bridge validates arguments with the original DSH validator and throws `ToolArgsError` with code `INVALID_ARGS` on failure. This local error establishes that no callback was dispatched, allowing application quota policies to admit a corrected proposal. Remote failures retain their existing classification and do not establish that an operation had no effect.

## Model Experience

The model receives the admitted tool schema and argument-validation errors. A local schema rejection causes no MCP callback; a corrected model proposal still incurs its normal model-call cost. This validation adds no prompt or KV-cache change.

## Known Limitations and Deferred Work

The bridge supports the original DSH JSON Schema subset, not every MCP schema keyword. Application domain constraints and transaction guarantees remain the callback owner's responsibility. Task-based MCP execution is unsupported.
