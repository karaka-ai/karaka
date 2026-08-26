# @deepseek-ai/dsh-identity-http-bearer

English | [中文](README.zh.md)

HTTP Authorization Bearer Consumer for [`@deepseek-ai/dsh-identity`](../identity/README.md). `IdentityHttpBearer` registers `ctx.identityHttpBearer`, injects only `ctx.identity`, converts a raw HTTP `Authorization` value into the Service Definition's bearer credential request, and returns `VerifiedIdentity`.

## Service API

`ctx.identityHttpBearer.authenticate({ authorization, signal? })` accepts the string, string array, or `undefined` shape exposed by common HTTP runtimes. It accepts exactly one case-insensitive `Bearer` scheme and one non-empty token. Missing credentials, multiple header values, commas, whitespace inside the token, malformed bearer values, and other authentication schemes reject with stable `IdentityError` codes before the identity provider runs.

This package does not register REST or SSE routes and contains no business logic. Future transport plugins inject it and remain responsible for converting safe identity failures into their own HTTP response contract. The Consumer never imports or selects a concrete provider.

## Model Experience

### HTTP credential admission

#### What the model sees

Nothing. `Authorization` parsing and verified identity remain outside prompts, tools, messages, and model request bodies.

#### Token effect

Zero tokens.

#### KV Cache effect

None; the Consumer does not change the model-visible prefix.

## Known Limitations and Deferred Work

- **Authorization header only** — cookies, query parameters, mTLS, and WebSocket subprotocol credentials need separate Consumers.
- **No HTTP response policy** — status codes, challenges, CORS, and safe error bodies belong to the transport plugin that calls this service.
- **No authority scope** — a later authority-normalization Consumer must turn `VerifiedIdentity` into application authority before protected domain work.
