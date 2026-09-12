/** Real browser activation and scroll geometry for code fences and read cards. */
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const SESSION_ID = 'viewport-highlight-browser'
const PROMPT = 'VIEWPORT_HIGHLIGHT Inspect this code and file.'
const CODE = `**viewport emphasis** ${'wrapped source text '.repeat(24)}\nconst viewport_marker = 1`
const READ = 'export const read_marker = 2'
const TAIL = 'VIEWPORT_HIGHLIGHT_END'

function fixtureLog(): string {
  const session = Session.create(SessionId(SESSION_ID))
  const source = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  const content = (text: string) => [{ type: 'text' as const, text }]
  const callId = ToolCallId('viewport-read')
  const args = JSON.stringify({ file_path: 'viewport.ts' })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({ content: content(PROMPT), source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', { header: { config: source, system: 'Viewport fixture.' }, reason: 'initial' })
  session.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({
    source, content: [{ type: 'tool-call', id: callId, name: 'read', arguments: args }],
  }) }, { surfaceOp: 'append' })
  const call = session.append('tool/call', { turn: 1, step: 1, callId, name: 'read', arguments: args })
  session.append('tool/result', {
    turn: 1, step: 1,
    message: createToolResultMessage({ callId, isError: false, content: content(`<path>viewport.ts</path>\n<type>file</type>\n<content>\n${READ}\n</content>`) }),
    meta: { path: 'viewport.ts', offset: 1, lines: [{ number: 1, text: READ }], totalLines: 1, lang: 'ts' },
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('step/start', { turn: 1, step: 2 })
  const padding = Array.from({ length: 45 }, (_, index) => `Viewport paragraph ${String(index)} keeps the code above the initial visible history.`).join('\n\n')
  session.append('assistant/message', { turn: 1, step: 2, message: createAssistantMessage({
    source, content: content(`${padding}\n\n\`\`\`md\n${CODE}\n\`\`\`\n\n${padding}\n\n${TAIL}`),
  }) }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 2 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: Date.now(), cwd: '{{cwd}}', delegationDepth: 0 }), ...session.events.map(event => JSON.stringify(event)), ''].join('\n')
}

async function revealGeometry(block: Locator): Promise<{ height: number; top: number; scroll: number }> {
  return await block.evaluate((element) => {
    element.scrollIntoView({ block: 'center', behavior: 'instant' })
    const rect = element.getBoundingClientRect()
    return { height: rect.height, top: rect.top, scroll: document.querySelector('[data-conversation-scroll]')!.scrollTop }
  })
}

async function geometry(block: Locator): Promise<{ height: number; top: number; scroll: number }> {
  return await block.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { height: rect.height, top: rect.top, scroll: document.querySelector('[data-conversation-scroll]')!.scrollTop }
  })
}

describe.skipIf(MODE === 'record')('web e2e: viewport highlighting', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold()
    await seedSession(scaffold, fixtureLog(), SESSION_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser, 720)
    await page.setViewportSize({ width: 980, height: 720 })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const searchButton = page.getByRole('button', { name: 'Search sessions' })
    await searchButton.click()
    await page.getByRole('textbox', { name: 'Search sessions...', exact: true }).fill(PROMPT)
    const result = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem')
    await result.first().waitFor({ state: 'visible', timeout: 60_000 })
    expect(await result.count()).toBe(1)
    await result.click()
    await page.getByText(TAIL, { exact: true }).waitFor()
    await page.evaluate(async () => {
      await document.fonts.ready
      await new Promise<void>(resolve => requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) }))
    })
  }, 120_000)

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('activates offscreen code and read content once without moving the reader', async () => {
    onTestFailed(() => saveFailureShot(page, `web-e2e-viewport-highlight-${String(process.pid)}`))
    const block = page.locator('.md-code-block').filter({ hasText: 'viewport_marker' })
    expect((await geometry(block)).top).toBeLessThan(0)
    expect(await block.locator('pre.shiki').count()).toBe(0)
    expect(await block.locator('pre').textContent()).toBe(CODE)

    // Open the real disclosure controls without Playwright scrolling them into view.
    const processControl = page.locator('[data-turn-process]')
    if (await processControl.getAttribute('aria-expanded') !== 'true') {
      await processControl.evaluate((element: HTMLElement) => { element.click() })
    }
    // The process button focuses itself; return to the tail before mounting the read body.
    await page.getByText(TAIL, { exact: true }).scrollIntoViewIfNeeded()
    const readRow = page.locator('[data-tool="read"] [data-disclosure-row]').first()
    if (await readRow.getAttribute('aria-expanded') !== 'true') {
      await readRow.evaluate((element: HTMLElement) => { element.click() })
    }
    const read = page.locator('[data-read]')
    await read.waitFor({ state: 'attached' })
    expect((await geometry(read)).top).toBeLessThan(0)
    expect(await read.locator('span[style]').count()).toBe(0)

    const before = await revealGeometry(block)
    await block.locator('pre.shiki span[style]').first().waitFor()
    await page.evaluate(() => document.fonts.ready)
    const after = await geometry(block)
    expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1)
    expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1)
    expect(Math.abs(after.scroll - before.scroll)).toBeLessThanOrEqual(1)
    expect(await block.locator('pre').textContent()).toBe(CODE)
    await block.locator('pre.shiki').evaluate((element) => { element.setAttribute('data-retained-highlight', 'yes') })
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await block.getByRole('button', { name: 'Copy', exact: true }).click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(CODE)

    expect((await geometry(read)).top).toBeLessThan(0)
    expect(await read.locator('span[style]').count()).toBe(0)
    const readBefore = await revealGeometry(read)
    await read.locator('span[style]').first().waitFor()
    const readAfter = await geometry(read)
    expect(Math.abs(readAfter.height - readBefore.height)).toBeLessThanOrEqual(1)
    expect(Math.abs(readAfter.top - readBefore.top)).toBeLessThanOrEqual(1)
    expect(Math.abs(readAfter.scroll - readBefore.scroll)).toBeLessThanOrEqual(1)
    await read.getByRole('button', { name: 'Copy', exact: true }).click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(READ)
    await read.evaluate((element) => {
      const range = document.createRange()
      const content = element.querySelector('[class*="content"]')!
      range.selectNodeContents(content)
      window.getSelection()!.removeAllRanges()
      window.getSelection()!.addRange(range)
    })
    expect(await page.evaluate(() => window.getSelection()!.toString())).toBe(READ)
    await page.getByText(TAIL, { exact: true }).scrollIntoViewIfNeeded()
    await revealGeometry(block)
    expect(await block.locator('pre.shiki').getAttribute('data-retained-highlight')).toBe('yes')
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
