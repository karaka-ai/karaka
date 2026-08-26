/**
 * HTTP Authorization Bearer Consumer for `ctx.identity`.
 * @module @deepseek-ai/dsh-identity-http-bearer
 */

import { Context, Service } from '@deepseek-ai/cordis'
import {
  IdentityError,
  type VerifiedIdentity,
} from '@deepseek-ai/dsh-identity'

/** Transport input accepted by {@link IdentityHttpBearer.authenticate}. */
export interface HttpBearerIdentityRequest {
  /** Raw HTTP Authorization value(s), as exposed by common server runtimes. */
  readonly authorization: string | readonly string[] | undefined
  /** Optional cooperative verification cancellation. */
  readonly signal?: AbortSignal
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    identityHttpBearer: IdentityHttpBearer
  }
}

function bearerToken(value: string | readonly string[] | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new IdentityError('IDENTITY_CREDENTIAL_MISSING')
  }
  let header: string
  if (typeof value === 'string') {
    header = value
  } else {
    const single = value[0]
    if (value.length !== 1 || single === undefined) {
      throw new IdentityError('IDENTITY_CREDENTIAL_MALFORMED')
    }
    header = single
  }
  const match = /^[\t ]*Bearer[\t ]+([^\s,]+)[\t ]*$/i.exec(header)
  const token = match?.[1]
  if (token !== undefined) return token
  const scheme = /^[\t ]*([^\s,]+)(?:[\t ]+|$)/.exec(header)?.[1]
  if (scheme !== undefined && scheme.toLowerCase() !== 'bearer') {
    throw new IdentityError('IDENTITY_CREDENTIAL_UNSUPPORTED')
  }
  throw new IdentityError('IDENTITY_CREDENTIAL_MALFORMED')
}

/**
 * HTTP-specific credential adapter. Future REST/SSE plugins inject this
 * service instead of parsing credentials or selecting an identity provider.
 */
export class IdentityHttpBearer extends Service {
  static inject = ['identity']

  constructor(ctx: Context) {
    super(ctx, 'identityHttpBearer')
  }

  /**
   * Parse exactly one Bearer credential and delegate provider verification.
   * @param request - raw Authorization value and optional cancellation.
   * @returns the provider's deeply immutable verified identity.
   */
  async authenticate(request: HttpBearerIdentityRequest): Promise<VerifiedIdentity> {
    if (request.signal?.aborted === true) {
      return Promise.reject(new IdentityError('IDENTITY_VERIFICATION_ABORTED'))
    }
    return this.ctx.identity.verify({
      credential: { kind: 'bearer', token: bearerToken(request.authorization) },
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
  }
}

export default IdentityHttpBearer
