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
    clientId: application-backend
    clientSecretEnv: KARAKA_OAUTH_CLIENT_SECRET
```

Use `privateKeyPath` instead of `clientSecretEnv` to authenticate the OAuth client with `private_key_jwt`. Secrets belong in the environment or a mounted key file, not directly in setup YAML.

## Provider contract

An alternative authentication plugin registers one implementation:

```ts
interface AuthenticationProvider {
  name: string
  authenticate(request: Request): Promise<AuthenticatedServer>
  request(target: { audience: string }, request: Request, dispatch: AuthenticationDispatch): Promise<Response>
}
```

`authenticate()` verifies incoming servers. `request()` performs outgoing authenticated requests, so providers may use OAuth, mTLS, signed requests, or another mechanism without changing Transport or MCP. The OAuth plugin mounts the contract and its provider as one normal setup entry. Exactly one provider is active in a Cordis graph, and its registration is removed with its plugin.

Transport binds the trusted application-supplied user context for the complete chat invocation. MCP authenticates `tools/list` and `tools/call`; a tool call also forwards the already-bound user context over that authenticated channel. User context is not a second credential.
