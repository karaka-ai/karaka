import { AuthenticationService, type AuthenticationProvider } from '@karaka/authentication'
import OAuthClientCredentials, { OAuthClientCredentialsProvider } from '@karaka/authentication/oauth-client-credentials'
import { Context } from '@karaka/cordis'
import { exportJWK, exportPKCS8, generateKeyPair, jwtVerify, SignJWT, type JWK } from 'jose'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

let authorizationServer: Server
let issuer: string
let privateKey: CryptoKey
let publicKey: CryptoKey
let publicJwk: JWK
let privateKeyPath: string
let keyDirectory: string
let tokenRequests = 0
const secretEnvironment = 'KARAKA_TEST_OAUTH_SECRET'

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true })
  privateKey = pair.privateKey
  publicKey = pair.publicKey
  keyDirectory = await mkdtemp(join(tmpdir(), 'karaka-oauth-'))
  privateKeyPath = join(keyDirectory, 'client-key.pem')
  await writeFile(privateKeyPath, await exportPKCS8(privateKey), { mode: 0o600 })
  publicJwk = { ...await exportJWK(pair.publicKey), alg: 'RS256', kid: 'test-key', use: 'sig' }
  authorizationServer = createServer(async (request, response) => {
    if (request.url === '/jwks') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ keys: [publicJwk] }))
      return
    }
    if (request.url !== '/token' || request.method !== 'POST') {
      response.writeHead(404).end()
      return
    }
    tokenRequests++
    const body = new URLSearchParams(await readBody(request))
    const expected = `Basic ${Buffer.from('application-backend:test-secret').toString('base64')}`
    if (request.headers.authorization !== expected) {
      const assertion = body.get('client_assertion')
      if (!assertion) {
        response.writeHead(401).end()
        return
      }
      try {
        await jwtVerify(assertion, publicKey, {
          issuer: 'application-backend',
          subject: 'application-backend',
          audience: `${issuer}token`,
          algorithms: ['RS256'],
          requiredClaims: ['iss', 'sub', 'aud', 'exp', 'jti'],
        })
      } catch {
        response.writeHead(401).end()
        return
      }
    }
    const audience = body.get('resource')
    if (!audience || body.get('grant_type') !== 'client_credentials') {
      response.writeHead(400).end()
      return
    }
    const token = await signServerToken('application-backend', audience)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: 300 }))
  })
  await new Promise<void>((resolve, reject) => {
    authorizationServer.once('error', reject)
    authorizationServer.listen(0, '127.0.0.1', resolve)
  })
  issuer = `http://127.0.0.1:${(authorizationServer.address() as AddressInfo).port}/`
  process.env[secretEnvironment] = 'test-secret'
})

afterAll(async () => {
  delete process.env[secretEnvironment]
  if (keyDirectory) await rm(keyDirectory, { recursive: true, force: true })
  if (!authorizationServer) return
  await new Promise<void>((resolve, reject) => {
    authorizationServer.close(error => error ? reject(error) : resolve())
  })
})

describe('Authentication seam', () => {
  it('owns one provider through its contributing Cordis plugin', async () => {
    const ctx = new Context()
    await ctx.plugin(AuthenticationService)
    const mounted = ctx.plugin(testAuthenticationPlugin)
    await mounted

    expect(ctx.authentication.currentProvider()).toEqual({ name: 'test-server-auth' })
    await expect(ctx.authentication.authenticate(requestWithToken('trusted-server'))).resolves.toEqual({
      id: 'trusted-server',
      provider: 'test-server-auth',
      claims: {},
    })
    await expect(ctx.plugin(testAuthenticationPlugin)).rejects.toThrow('already registered')

    await mounted.dispose()
    expect(ctx.authentication.currentProvider()).toBeUndefined()
    await expect(ctx.authentication.authenticate(requestWithToken('trusted-server'))).rejects.toMatchObject({
      code: 'NO_PROVIDER',
    })
    await ctx.fiber.dispose()
  })

  it('binds authenticated-server user context to concurrent invocations', async () => {
    const ctx = new Context()
    await ctx.plugin(AuthenticationService)
    await ctx.plugin(testAuthenticationPlugin)
    const server = await ctx.authentication.authenticate(requestWithToken('application'))

    const current = (tenantId: string, userId: string) => ctx.authentication.withUser(
      { tenantId, userId },
      server,
      async () => {
        await Promise.resolve()
        return ctx.authentication.currentPrincipal()
      },
    )
    const [acme, beta] = await Promise.all([
      current('acme', 'user-acme'),
      current('beta', 'user-beta'),
    ])

    expect(acme).toMatchObject({ tenantId: 'acme', subject: 'user-acme', provider: 'test-server-auth:application' })
    expect(beta).toMatchObject({ tenantId: 'beta', subject: 'user-beta', provider: 'test-server-auth:application' })
    await expect(ctx.authentication.currentPrincipal()).rejects.toMatchObject({ code: 'NO_CURRENT_PRINCIPAL' })
    await ctx.fiber.dispose()
  })

  it('lets provider plugins implement arbitrary outgoing authentication', async () => {
    const ctx = new Context()
    await ctx.plugin(AuthenticationService)
    await ctx.plugin(testAuthenticationPlugin)

    const response = await ctx.authentication.request(
      { audience: 'inventory-service' },
      new Request('https://inventory.example.test/items'),
      async request => Response.json({
        server: request.headers.get('x-test-server'),
        audience: request.headers.get('x-test-audience'),
      }),
    )
    await expect(response.json()).resolves.toEqual({ server: 'application', audience: 'inventory-service' })
    await ctx.fiber.dispose()
  })

  it('uses OAuth Client Credentials for incoming and outgoing server authentication', async () => {
    const audience = 'https://karaka.example.test'
    const provider = oauthProvider(audience)
    const before = tokenRequests
    let authenticatedRequest: Request | undefined

    await provider.request(
      { audience },
      new Request(`${audience}/v1/chats`, { method: 'POST', body: '{}' }),
      async request => {
        authenticatedRequest = request
        return new Response(null, { status: 204 })
      },
    )
    await provider.request(
      { audience },
      new Request(`${audience}/v1/chats`, { method: 'POST', body: '{}' }),
      async () => new Response(null, { status: 204 }),
    )

    expect(tokenRequests).toBe(before + 1)
    const server = await provider.authenticate(authenticatedRequest!)
    expect(server).toMatchObject({ id: 'application-backend', provider: 'oauth-client-credentials' })
    expect(server.claims.aud).toBe(audience)
  })

  it('mounts the contract and provider from one OAuth plugin row', async () => {
    const ctx = new Context()
    const mounted = ctx.plugin(OAuthClientCredentials, oauthConfig('https://karaka.example.test'))
    await mounted

    expect(ctx.authentication.currentProvider()).toEqual({ name: 'oauth-client-credentials' })
    await mounted.dispose()
    expect(ctx.authentication).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('supports asymmetric private_key_jwt client authentication', async () => {
    const { clientSecretEnv: _clientSecretEnv, ...config } = oauthConfig('https://tools.example.test')
    const provider = new OAuthClientCredentialsProvider({
      ...config,
      privateKeyPath,
      privateKeyAlgorithm: 'RS256',
      privateKeyId: 'test-key',
    })
    const response = await provider.request(
      { audience: 'https://tools.example.test' },
      new Request('https://tools.example.test/mcp'),
      async request => new Response(request.headers.get('authorization')),
    )
    expect(await response.text()).toMatch(/^Bearer\s+\S+$/)
  })

  it('fails closed on invalid OAuth credentials, audiences, and provider configuration', async () => {
    const provider = oauthProvider('https://karaka.example.test')
    await expect(provider.authenticate(new Request('https://karaka.example.test'))).rejects.toMatchObject({
      code: 'INVALID_CREDENTIAL',
    })
    await expect(provider.authenticate(new Request('https://karaka.example.test', {
      headers: { authorization: `Bearer ${await signServerToken('application-backend', 'wrong-audience')}` },
    }))).rejects.toMatchObject({ code: 'INVALID_CREDENTIAL' })
    expect(() => new OAuthClientCredentialsProvider({
      ...oauthConfig('https://karaka.example.test'),
      privateKeyPath: '/private/key.pem',
    })).toThrow('exactly one')
    const config = oauthConfig('https://karaka.example.test')
    delete (config as { clientSecretEnv?: string }).clientSecretEnv
    expect(() => new OAuthClientCredentialsProvider(config)).toThrow('exactly one')
  })
})

const testProvider: AuthenticationProvider = {
  name: 'test-server-auth',
  async authenticate(request) {
    const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    if (!token) throw new Error('missing credential')
    return { id: token, provider: 'test-server-auth', claims: {} }
  },
  async request(target, request, dispatch) {
    const headers = new Headers(request.headers)
    headers.set('x-test-server', 'application')
    headers.set('x-test-audience', target.audience)
    return dispatch(new Request(request, { headers }))
  },
}

const testAuthenticationPlugin = {
  name: 'test-server-authentication',
  inject: ['authentication'],
  apply(ctx: Context) {
    ctx.authentication.register(testProvider)
  },
}

function oauthProvider(audience: string) {
  return new OAuthClientCredentialsProvider(oauthConfig(audience))
}

function oauthConfig(audience: string) {
  return {
    issuer,
    audience,
    tokenEndpoint: `${issuer}token`,
    jwksUri: `${issuer}jwks`,
    clientId: 'application-backend',
    clientSecretEnv: secretEnvironment,
    algorithms: ['RS256'] as Array<'RS256'>,
  }
}

function requestWithToken(token: string) {
  return new Request('https://karaka.example.test', { headers: { authorization: `Bearer ${token}` } })
}

function signServerToken(subject: string, audience: string) {
  return new SignJWT({ client_id: subject })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey)
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}
