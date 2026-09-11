/** Standalone browser assembly for authenticated application chats and human interactions. */

import { Context } from '@deepseek-ai/cordis'
import * as connection from '@deepseek-ai/dsh-client-connection/client'
import * as registry from '@deepseek-ai/dsh-typert-registry/client'
import * as gateway from '@deepseek-ai/dsh-api-gateway/client'
import * as remotes from '@deepseek-ai/dsh-api-remotes/client'
import { createScope, scopeOf } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'

export { SessionId } from '@deepseek-ai/dsh-session/types'
export type { ApplicationRemoteMethod } from '@deepseek-ai/dsh-api-remotes/client'
export type { RemoteResult, RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'

/** Endpoint and credential acquisition owned by one application browser client. */
export interface BrowserClientConfig {
  readonly endpoint: string
  readonly credential: NonNullable<connection.BrowserConnectionConfig['credential']>
  /** Methods to mount locally; the server independently enforces its selection. */
  readonly methods?: readonly remotes.ApplicationRemoteMethod[]
}

/** Typed chat operations and the existing Remote interaction interface. */
export interface BrowserClient {
  readonly chats: Pick<gateway.ClientRemote['session'], remotes.ApplicationRemoteMethod>
  readonly connection: Pick<connection.ConnectionHandle, 'state' | 'generation' | 'reconnect'>
  /**
   * Subscribe to approval/question events for one chat through `$on`.
   * @param chatId - application chat id; server ownership still controls delivery.
   * @returns chat-scoped Remote event subscriptions.
   */
  forChat(chatId: string): Pick<gateway.ClientRemote, '$on'>
  /** Stop network activity and dispose all chat subscriptions. */
  dispose(): Promise<void>
}

/**
 * Assemble an independent browser client over the existing Connection and Typert services.
 * @param config - server endpoint, renewable credential and selected methods.
 * @returns typed operations, chat-scoped interactions and asynchronous disposal.
 */
export async function createBrowserClient(config: BrowserClientConfig): Promise<BrowserClient> {
  const ctx = new Context()
  const scopes = new Map<string, ReturnType<typeof createScope>>()
  try {
    await ctx.plugin(connection, { endpoint: config.endpoint, credential: config.credential })
    await ctx.plugin(registry)
    ctx.effect(() => ctx.typert.contexts.registerClient('agent', {
      identity: scopeOf,
      resolve: id => scopes.get(id)?.ctx as Context | undefined,
    }))
    await ctx.plugin(gateway)
    await ctx.plugin(remotes, { applicationMethods: config.methods ?? remotes.APPLICATION_REMOTE_METHODS })
    return {
      chats: ctx.remote.session,
      connection: ctx.get('connection') as connection.ConnectionHandle,
      forChat(chatId) {
        let scope = scopes.get(chatId)
        if (scope === undefined) {
          scope = createScope(ctx, SessionId(chatId))
          scopes.set(chatId, scope)
        }
        return scope.ctx.get('remote') as gateway.ClientRemote
      },
      dispose: async () => { await ctx.fiber.dispose() },
    }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}
