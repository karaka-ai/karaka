/** Server-verified callers shared by Connection and its authenticated consumers. */

import type { ApplicationOwner } from '@deepseek-ai/dsh-session/types'

/** Authentication retained for one request or physical connection. */
export type ConnectionCaller =
  | { readonly kind: 'host' }
  | { readonly kind: 'application'; readonly owner: ApplicationOwner; readonly expiresAt: number }

/** Application credential verifier supplied by deployment composition. */
export interface ConnectionAuth {
  /**
   * Verify a credential without trusting caller-supplied identity fields.
   * @param credential - opaque bearer credential.
   * @returns verified application caller, or undefined for an invalid credential.
   */
  authenticate(credential: string): Promise<Extract<ConnectionCaller, { kind: 'application' }> | undefined>
}

/** Authentication result before HTTP or WebSocket dispatch. */
export type ConnectionAuthentication =
  | { readonly caller: ConnectionCaller }
  | { readonly rejection: 401 | 403 }

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Deployment-owned application credential verifier. */
    connectionAuth: ConnectionAuth
    /** Server-only caller attached to an individual Remote invocation. */
    connectionCaller?: ConnectionCaller
  }
}
