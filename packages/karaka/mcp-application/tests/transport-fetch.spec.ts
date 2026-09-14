/** The SDK FetchLike callback accepts requests with omitted RequestInit fields. */
import type { StreamableHTTPClientTransportOptions } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { expect, it, vi } from 'vitest'
import { createTransport } from '../src/transport.ts'

const sdk = vi.hoisted(() => ({ options: undefined as StreamableHTTPClientTransportOptions | undefined }))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(function (_url: URL, options: StreamableHTTPClientTransportOptions) { sdk.options = options }),
}))

it('obtains credentials without inventing a signal when the SDK omits request options', async () => {
  const headers = vi.fn(async (_signal?: AbortSignal) => ({ authorization: 'Bearer current' }))
  createTransport({
    applicationId: 'app', serverName: 'app', url: 'https://example.test/mcp', headers: {},
    allow: [], deny: [], toolCallTimeoutMs: 1000, failOnStartupError: true,
  }, { headers, metadata: async () => ({}), register: () => () => {} })
  const request = sdk.options?.fetch
  if (request === undefined) throw new Error('SDK fetch callback was not configured')
  // Native fetch resolves data URLs locally, without a listener or process-global replacement.
  expect(await (await request('data:text/plain,accepted')).text()).toBe('accepted')
  expect(await (await request('data:text/plain,accepted', { signal: null })).text()).toBe('accepted')
  expect(headers.mock.calls).toEqual([[undefined], [undefined]])
})
