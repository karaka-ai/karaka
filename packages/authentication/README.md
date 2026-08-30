# @karaka/authentication

English | [中文](README.zh.md)

Karaka authenticates servers, not end users. The application backend authenticates its own users and sends trusted `tenantId` and `userId` context after Karaka has verified that backend.

The package exports:

- `AuthenticationService`, the provider-neutral Cordis contract;
- `@karaka/authentication/oauth-client-credentials`, the default OAuth 2.0 Client Credentials provider.

```yaml
- name: '@karaka/authentication/oauth-client-credentials'
  config:
    issuer: https://identity.example.com/
    audience: https://karaka.internal
    tokenEndpoint: https://identity.example.com/oauth/token
    jwksUri: https://identity.example.com/.well-known/jwks.json
    clientId: karaka-server
    clientSecretEnv: KARAKA_OAUTH_CLIENT_SECRET
```

Use `privateKeyPath` instead of `clientSecretEnv` to authenticate the OAuth client with `private_key_jwt`. Secrets belong in the environment or a mounted key file, not directly in setup YAML. Token acquisition rejects redirects and uses a 10-second timeout by default; `tokenTimeoutMs` can set another positive bound.

## Provider contract

An alternative authentication plugin registers one implementation:

```ts
interface AuthenticationProvider {
  name: string
  challenge?: string
  authenticate(request: Request): Promise<AuthenticatedServer>
  request(target: { audience: string }, request: Request, dispatch: AuthenticationDispatch): Promise<Response>
}
```

`authenticate()` verifies incoming servers from Web `Request` metadata. `request()` performs outgoing authenticated requests, so providers may use OAuth, header credentials, or another metadata mechanism without changing Transport or MCP. `challenge` optionally supplies the provider's `WWW-Authenticate` value for invalid incoming credentials. Carrier and body-bound authentication such as mTLS or body signatures need a future contract extension carrying verified TLS or bounded-body evidence. The OAuth plugin mounts the contract and its provider as one normal setup entry. Exactly one provider is active in a Cordis graph, and its registration is removed with its plugin.

Remote Chat endpoints must use HTTPS; plain HTTP is accepted only on loopback addresses. The default Chat OAuth audience is the endpoint origin, such as `https://karaka.internal`, without `/v1`. The SDK derives it automatically. In the setup above, `karaka-server` is Karaka's OAuth client identity for outgoing MCP requests; an application backend uses its own client identity when constructing the SDK authentication provider.

Transport binds the trusted application-supplied user context for the complete chat invocation. MCP authenticates `tools/list` and `tools/call`; a tool call also forwards the already-bound user context over that authenticated channel. User context is not a second credential.
