import { describe, expect, it } from 'vitest'
import { startResponsesFixture, type ResponsesFixture } from './responses-fixture.ts'

async function commandResult(fixture: ResponsesFixture, output: string, tools = [{ type: 'function', name: 'write_stdin' }]): Promise<Response> {
  return fetch(`${fixture.baseUrl}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tools, input: [{ type: 'function_call_output', output }] }),
  })
}

describe('Responses command completion fixture', () => {
  it('collects successive running sessions before returning the final answer', async () => {
    const fixture = await startResponsesFixture([{ kind: 'completeAfterCommand', text: 'finished' }])
    try {
      for (const sessionId of [12, 34]) {
        const response = await commandResult(fixture, `Process running with session ID ${sessionId}`)
        expect(response.status).toBe(200)
        const events = (await response.text()).split('\n')
          .filter(line => line.startsWith('data: {'))
          .map(line => JSON.parse(line.slice(6)) as Record<string, unknown>)
        const event = events.find(item => item.type === 'response.output_item.done')
        expect(event?.item).toMatchObject({
          type: 'function_call',
          name: 'write_stdin',
          call_id: `call_fixture_${fixture.requests.length}`,
          arguments: JSON.stringify({ session_id: sessionId, chars: '', yield_time_ms: 1_000 }),
        })
      }
      const response = await commandResult(fixture, 'Process exited with code 0\nOutput:\n')
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('finished')
    } finally {
      await fixture.close()
    }
  })

  it.each([
    'Process exited with code 1\nOutput:\nfailed',
    'Command timed out',
    'unrecognized result',
  ])('rejects unsuccessful or unknown command output: %s', async (output) => {
    const fixture = await startResponsesFixture([{ kind: 'completeAfterCommand', text: 'finished' }])
    try {
      const response = await commandResult(fixture, output)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: { message: `fixture command did not complete successfully: ${output}` } })
    } finally {
      await fixture.close()
    }
  })

  it('rejects a running command when write_stdin is not advertised', async () => {
    const fixture = await startResponsesFixture([{ kind: 'completeAfterCommand', text: 'finished' }])
    try {
      const response = await commandResult(fixture, 'Process running with session ID 12', [])
      expect(response.status).toBe(400)
      expect(await response.text()).toContain('fixture command did not complete successfully')
    } finally {
      await fixture.close()
    }
  })
})
