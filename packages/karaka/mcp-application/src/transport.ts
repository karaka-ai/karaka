/** Fetch-time credentials rotate without reconnecting or modifying DSH transport. */
import { StreamableHTTPClientTransport, type Transport } from '@modelcontextprotocol/client'
import type { ApplicationBridge, Config } from './index.ts'

/**
 * Create an MCP HTTP transport that renews credentials for every request.
 * @param config - Endpoint and static request headers.
 * @param bridge - Current application credentials.
 * @returns An unconnected transport that rejects redirects.
 */
export function createTransport(config: Config, bridge: ApplicationBridge): Transport {
  const endpoint = new URL(config.url)
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') throw new Error('MCP endpoint must use HTTP or HTTPS')
  return new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: config.headers },
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers)
      for (const [key, value] of Object.entries(await bridge.headers(init?.signal ?? undefined))) headers.set(key, value)
      // A credential-bearing request must never follow a redirect to another origin.
      return fetch(input, { ...init, headers, redirect: 'error' })
    },
  })
}
