/** The sole authorized E2E: SDK -> HTTP -> DSH model/loop -> MCP -> JSONL -> restart. */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const artifact = process.env.KARAKA_ARTIFACT_ROOT
if (!artifact) throw new Error('KARAKA_ARTIFACT_ROOT must identify the materialized built runtime')
const cliRoot = process.env.KARAKA_CLI_ROOT ?? resolve(artifact, 'node_modules/@karaka-ai/cli')
const cliBin = resolve(cliRoot, 'lib/bin.js')
const sdkRoot = process.env.KARAKA_SDK_ROOT
if (!sdkRoot) throw new Error('KARAKA_SDK_ROOT must identify the separately built SDK repository')
const sdk = await import(pathToFileURL(resolve(sdkRoot, 'lib/index.js')).href)
const { z } = createRequire(resolve(sdkRoot, 'package.json'))('zod')
const { createBrowserClient } = await import(pathToFileURL(resolve(artifact, 'lib/browser.js')).href)
const { generateKeyPair, exportSPKI, SignJWT } = await import(pathToFileURL(resolveFixtureJose()).href)
const keyPair = await generateKeyPair('ES256')
const browserOrigin = 'https://karaka-flow.example'
let browserClient
const realFetch = globalThis.fetch
const home = await mkdtemp(resolve(tmpdir(), 'karaka-application-flow-'))
const evidence = { home, artifact, cliRoot, sdkRoot, launcher: 'built standalone Karaka CLI and built DSH CLI', browser: 'Node-driven browser facade with explicit Origin header; not a rendered UI', model: 'local deterministic HTTP fixture through the original DSH DeepSeek provider', stages: [], toolCalls: [], modelRequests: 0 }
const token = randomUUID()
const toolToken = randomUUID()
const expected = `DELIVERY-${randomUUID()}`
const deadline = AbortSignal.timeout(120_000)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let processHandle
let processLog = ''
const toolHost = sdk.createKarakaToolHost({ verifyToken: toolToken })
toolHost.registerTool('delivery_status', {
  description: 'Look up the authenticated user delivery status.',
  inputSchema: z.object({ orderId: z.string() }),
}, (arguments_, identity) => {
  const { signal, ...owner } = identity
  signal.throwIfAborted()
  if (owner.applicationId !== 'flow-app' || owner.tenantId !== 'tenant-a' || owner.userId !== 'alice') throw new Error('MCP received incorrect trusted owner')
  if (arguments_.orderId !== 'ORDER-1') throw new Error('Model did not supply the requested order')
  evidence.toolCalls.push(owner)
  return { content: [{ type: 'text', text: expected }] }
})
const toolServer = createServer((request, response) => {
  Promise.resolve(toolHost.expressHandler()(request, response)).catch(error => {
    if (!response.headersSent) response.writeHead(500)
    response.end(String(error))
  })
})
const modelServer = createServer(async (request, response) => {
  try {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    if (!request.url.endsWith('/chat/completions')) throw new Error(`Unexpected model route ${request.url}`)
    evidence.modelRequests++
    const messages = body.messages
    const lastUser = messages.findLast(message => message.role === 'user')
    const recalling = JSON.stringify(lastUser?.content).includes('Remember the delivery')
    const last = messages.at(-1)
    let delta
    let finish
    if (recalling) {
      if (!messages.some(message => message.role === 'assistant' && JSON.stringify(message.content).includes(expected))) throw new Error('Restarted model did not receive the persisted answer')
      delta = { role: 'assistant', content: `I remember ${expected}.` }
      finish = 'stop'
    } else if (last?.role === 'tool') {
      if (!JSON.stringify(last.content).includes(expected)) throw new Error('The real MCP result did not reach the model')
      delta = { role: 'assistant', content: `Your delivery status is ${expected}.` }
      finish = 'stop'
    } else {
      const names = body.tools?.map(tool => tool.function.name) ?? []
      if (!names.includes('mcp__application__delivery_status')) throw new Error('Application MCP schema did not reach the model')
      delta = { role: 'assistant', content: null, tool_calls: [{ index: 0, id: `call_${randomUUID()}`, type: 'function', function: { name: 'mcp__application__delivery_status', arguments: JSON.stringify({ orderId: 'ORDER-1' }) } }] }
      finish = 'tool_calls'
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const frame = (delta, finish_reason) => ({ id: 'chatcmpl-karaka-flow', object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: body.model, choices: [{ index: 0, delta, finish_reason }] })
    response.write(`data: ${JSON.stringify(frame(delta, null))}\n\n`)
    response.write(`data: ${JSON.stringify({ ...frame({}, finish), usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 20 } })}\n\n`)
    response.end('data: [DONE]\n\n')
  } catch (error) {
    evidence.fixtureError = String(error)
    response.writeHead(500, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: String(error), type: 'invalid_request_error' } }))
  }
})

function resolveFixtureJose() {
  const installed = createRequire(resolve(artifact, 'package.json'))
  try {
    const browserAuth = installed.resolve('@karaka-ai/browser-auth/package.json')
    return createRequire(browserAuth).resolve('jose')
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error
  }
  try {
    return installed.resolve('jose')
  } catch (error) {
    // Older local artifacts left this fixture dependency in the source checkout.
    if (error.code !== 'MODULE_NOT_FOUND') throw error
    return createRequire(resolve(root, 'packages/karaka/browser-auth/package.json')).resolve('jose')
  }
}

async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `http://127.0.0.1:${server.address().port}`
}
async function stopServer() {
  if (!processHandle || processHandle.exitCode !== null) return
  const child = processHandle
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  const force = setTimeout(() => child.kill('SIGKILL'), 10_000)
  try { await exited } finally { clearTimeout(force) }
}
async function runNode(args, env) {
  const child = spawn(process.execPath, args, { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', data => { processLog += data })
  child.stderr.on('data', data => { processLog += data })
  const [code] = await once(child, 'exit')
  if (code !== 0) throw new Error(`Profile initialization exited ${code}: ${processLog}`)
}
async function awaitTurn(user, chatId, cursor = -1) {
  for await (const event of user.chats.stream({ chatId, cursor, signal: deadline })) {
    if (event.type === 'error') throw new Error(`Chat error: ${event.message}`)
    if (event.type === 'turn-end') return event.cursor
  }
  throw new Error('Stream ended before a completed turn')
}

try {
  const toolsUrl = await listen(toolServer)
  const modelUrl = await listen(modelServer)
  const portReservation = createServer()
  const endpoint = await listen(portReservation)
  const port = portReservation.address().port
  await new Promise(resolve => portReservation.close(resolve))
  const env = {
    ...process.env, DSH_HOME: resolve(home, '.karaka'),
    KARAKA_PORT: String(port), DEEPSEEK_BASE_URL: modelUrl,
    DEEPSEEK_API_KEY: 'fixture-only-no-provider-credential',
    KARAKA_CHAT_TOKEN: token, KARAKA_TOOL_TOKEN: toolToken,
    KARAKA_APPLICATIONS: JSON.stringify([{ id: 'flow-app', chatCredential: 'KARAKA_CHAT_TOKEN', toolCredential: 'KARAKA_TOOL_TOKEN' }]),
    KARAKA_MCP_APPLICATION_ID: 'flow-app', KARAKA_MCP_URL: `${toolsUrl}/mcp`,
    KARAKA_MCP_ALLOW: JSON.stringify(['mcp__application__delivery_status']),
    KARAKA_PRESET_TOOL_ALLOW: JSON.stringify(['mcp__application__delivery_status']),
    KARAKA_BROWSER_AUTH: JSON.stringify({ applicationId: 'flow-app', issuer: 'karaka-flow', audience: 'karaka-browser', maxTokenAgeSeconds: 600, keys: [{ id: 'flow-key', algorithm: 'ES256', publicKey: await exportSPKI(keyPair.publicKey) }] }),
    KARAKA_BROWSER_ORIGINS: JSON.stringify([browserOrigin]),
  }
  delete env.TSX_TSCONFIG_PATH
  delete env.NODE_OPTIONS
  await runNode([cliBin, 'init', '--dir', home], env)
  const patchPath = resolve(home, 'karaka.cordis.yml')
  await writeFile(patchPath, '- id: server-auth\n  config:\n    applications:\n      - id: flow-app\n        chatCredential: KARAKA_CHAT_TOKEN\n        toolCredential: KARAKA_TOOL_TOKEN\n')
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith(`${endpoint}/karaka/browser/`)) {
      const headers = new Headers(init?.headers)
      headers.set('origin', browserOrigin)
      return realFetch(input, { ...init, headers })
    }
    return realFetch(input, init)
  }
  async function startServer() {
    processHandle = spawn(process.execPath, [cliBin, 'start', '--config', patchPath], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] })
    processHandle.stdout.on('data', data => { processLog += data })
    processHandle.stderr.on('data', data => { processLog += data })
    while (!deadline.aborted) {
      if (processHandle.exitCode !== null) throw new Error(`Karaka exited ${processHandle.exitCode}: ${processLog}`)
      try {
        const response = await fetch(`${endpoint}/v1/agents`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000) })
        if (response.ok) return
      } catch { /* Server socket has not opened yet. */ }
      await pause(100)
    }
    deadline.throwIfAborted()
  }
  await startServer()
  evidence.stages.push('running-profile')
  const client = sdk.createKarakaClient({ endpoint, path: '/v1', chatToken: token })
  const user = client.forUser({ tenantId: 'tenant-a', userId: 'alice' })
  const chat = await user.chats.create({ agentId: 'application' })
  evidence.chatId = chat.chatId
  evidence.stages.push('sdk-authenticated-chat-created')
  await user.chats.send({ chatId: chat.chatId, content: 'Look up delivery status for ORDER-1 using the application tool.' })
  const cursor = await awaitTurn(user, chat.chatId)
  const history = await user.chats.history(chat.chatId)
  if (!JSON.stringify(history).includes(expected) || evidence.toolCalls.length !== 1) throw new Error('Model/tool response did not complete')
  evidence.stages.push('model-called-authenticated-application-tool-and-answered')
  await stopServer()
  await startServer()
  const credential = await new SignJWT({ applicationId: 'flow-app', tenantId: 'tenant-a', userId: 'alice' })
    .setProtectedHeader({ alg: 'ES256', kid: 'flow-key' }).setIssuer('karaka-flow').setAudience('karaka-browser').setIssuedAt().setExpirationTime('5m').sign(keyPair.privateKey)
  browserClient = await createBrowserClient({ endpoint, credential: () => credential })
  const resumedHistory = await browserClient.chats.applicationHistory({ chatId: chat.chatId }, deadline)
  evidence.browserHistory = resumedHistory.ok
    ? { ok: true, containsExpected: JSON.stringify(resumedHistory.value).includes(expected) }
    : { ok: false, error: { code: resumedHistory.error.code, message: resumedHistory.error.message } }
  if (!resumedHistory.ok || !JSON.stringify(resumedHistory.value).includes(expected)) throw new Error('Browser history was not preserved across restart')
  evidence.stages.push('jsonl-history-survived-restart')
  const prompted = await browserClient.chats.applicationPrompt({ chatId: chat.chatId, requestId: randomUUID(), content: [{ type: 'text', text: 'Remember the delivery status you just looked up and repeat it without another lookup.' }] }, deadline)
  if (!prompted.ok) throw new Error(`Browser prompt failed: ${prompted.error.message}`)
  let completed = false
  for await (const result of browserClient.chats.applicationFollow({ chatId: chat.chatId }, deadline)) {
    if (!result.ok) throw new Error(`Browser follow failed: ${result.error.message}`)
    const frame = result.value
    const events = frame.type === 'snapshot' ? frame.records.filter(record => record.type === 'event').map(record => record.event) : frame.type === 'event' ? [frame.event] : []
    if (events.some(event => event.type === 'turn/end' && event.seq > cursor)) { completed = true; break }
  }
  if (!completed) throw new Error('Browser stream ended before the resumed turn completed')
  const continued = await browserClient.chats.applicationHistory({ chatId: chat.chatId }, deadline)
  if (!continued.ok || !JSON.stringify(continued.value).includes(`I remember ${expected}`)) throw new Error('Persisted history did not reach the resumed model')
  evidence.stages.push('continued-original-session-after-restart')
  let denied = false
  try { await client.forUser({ tenantId: 'tenant-a', userId: 'bob' }).chats.history(chat.chatId) }
  catch (error) { denied = /forbidden|owner|authoriz/i.test(String(error.code) + String(error.message)) }
  if (!denied) throw new Error('Wrong-owner history request was not denied')
  evidence.stages.push('wrong-owner-denied')
  evidence.success = true
} catch (error) {
  evidence.success = false
  evidence.error = String(error)
  process.exitCode = 1
} finally {
  await browserClient?.dispose()
  globalThis.fetch = realFetch
  await stopServer()
  await toolHost.close()
  toolServer.closeAllConnections()
  modelServer.closeAllConnections()
  await Promise.all([new Promise(resolve => toolServer.close(resolve)), new Promise(resolve => modelServer.close(resolve))])
  await writeFile(resolve(home, 'server.log'), processLog)
  await writeFile(resolve(home, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence, null, 2))
}
