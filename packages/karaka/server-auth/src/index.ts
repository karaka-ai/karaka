/** Server-to-server authentication used by Karaka transports and application MCP endpoints. */

import { timingSafeEqual } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { ApplicationId } from '@deepseek-ai/dsh-session'

/** Verified application server identity. */
export interface AuthenticatedApplication {
  readonly applicationId: ApplicationId
}

/** Replaceable authentication used for both inbound chat and outbound tool traffic. */
export abstract class ServerAuth extends Service {
  constructor(ctx: Context) {
    super(ctx, 'serverAuth')
  }

  /**
   * Verify an inbound authorization value.
   * @param authorization - complete inbound Authorization header.
   * @param signal - caller lifetime; implementations must stop credential work when aborted.
   * @returns the authenticated application, or undefined when verification fails.
   */
  abstract authenticate(
    authorization: string | undefined,
    signal?: AbortSignal,
  ): Promise<AuthenticatedApplication | undefined>

  /**
   * Build outbound authorization for one application's MCP endpoint.
   * @param applicationId - authenticated application identity.
   * @param signal - outbound request lifetime.
   * @returns complete outbound Authorization header.
   */
  abstract authorizeTools(applicationId: ApplicationId, signal?: AbortSignal): Promise<string>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    serverAuth: ServerAuth
  }
}

/** One application and its independently rotatable directional credentials. */
export interface ApplicationCredentialConfig {
  /** Stable application-server identity. */
  readonly id: string
  /** Credential reference accepted on inbound chat requests. */
  readonly chatCredential: string
  /** Credential reference sent to this application's MCP endpoint. */
  readonly toolCredential: string
}

/** Shared-bearer provider configuration. */
export interface Config {
  /** Authenticated application servers and their directional credentials. */
  readonly applications: ApplicationCredentialConfig[]
}

interface ApplicationCredentials {
  readonly id: ApplicationId
  readonly chatCredential: CredentialRef
  readonly toolCredential: CredentialRef
}

/** Default shared-bearer implementation of the server-auth service. */
export default class BearerServerAuth extends ServerAuth {
  static inject = ['credentials']
  static Config: z<Config> = z.object({
    applications: z.array(z.object({
      id: z.string().required(),
      chatCredential: z.string().required(),
      toolCredential: z.string().required(),
    })).required(),
  })

  private readonly applications: readonly ApplicationCredentials[]

  constructor(ctx: Context, config: Config) {
    super(ctx)
    const ids = new Set<string>()
    this.applications = config.applications.map((application) => {
      if (application.id.length === 0) throw new Error('server-auth: application id must not be empty')
      if (ids.has(application.id)) throw new Error(`server-auth: duplicate application id "${application.id}"`)
      ids.add(application.id)
      return {
        id: ApplicationId(application.id),
        chatCredential: credentialRef(application.chatCredential),
        toolCredential: credentialRef(application.toolCredential),
      }
    })
  }

  async authenticate(
    authorization: string | undefined,
    signal?: AbortSignal,
  ): Promise<AuthenticatedApplication | undefined> {
    signal?.throwIfAborted()
    const supplied = bearerToken(authorization)
    if (supplied === undefined) return undefined
    let match: AuthenticatedApplication | undefined
    for (const application of this.applications) {
      const configured = await abortable(
        this.ctx.credentials.resolve(application.chatCredential),
        signal,
      )
      if (configured !== undefined && equalSecret(supplied, configured.value)) {
        if (match !== undefined) return undefined
        match = { applicationId: application.id }
      }
    }
    return match
  }

  async authorizeTools(applicationId: ApplicationId, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const application = this.applications.find(candidate => candidate.id === applicationId)
    if (application === undefined) throw new Error(`server-auth: unknown application "${applicationId}"`)
    const configured = await abortable(
      this.ctx.credentials.resolve(application.toolCredential),
      signal,
    )
    if (configured === undefined) {
      throw new Error(`server-auth: tool credential for application "${applicationId}" is not configured`)
    }
    return `Bearer ${configured.value}`
  }
}

async function abortable<Value>(operation: Promise<Value>, signal?: AbortSignal): Promise<Value> {
  if (signal === undefined) return operation
  signal.throwIfAborted()
  return new Promise<Value>((resolve, reject) => {
    const abort = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('server authentication cancelled'))
    }
    signal.addEventListener('abort', abort, { once: true })
    void operation.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
  })
}

function bearerToken(authorization: string | undefined): string | undefined {
  if (authorization === undefined) return undefined
  const match = /^Bearer ([^\s]+)$/iu.exec(authorization)
  return match?.[1]
}

function equalSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}
