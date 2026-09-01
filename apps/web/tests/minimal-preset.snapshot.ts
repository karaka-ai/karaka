import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/minimal-preset', import.meta.url))
const MINIMAL_PRESET = fileURLToPath(new URL('../../../packages/preset/agent-presets/presets/minimal', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.jsonl')
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const MODE = webSnapshotMode()
const PROMPT = "Use the bash tool to run exactly: printf 'MINIMAL_BASH_CARD_OK\\n'. Then reply exactly MINIMAL_PRESET_REQUEST_OK and stop."

function applicationTool(name: string) {
  return defineTool({
    name,
    description: 'Read application data.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: () => Promise.resolve('ok'),
  })
}

describe('minimal agent preset', () => {
  let scaffold: WebScaffold
  let agentHandle: AgentHandle
  let disposeInjectedPrompt: () => void
  let browser: Browser | undefined
  let page: Page | undefined
  let tripwire: ReturnType<typeof watchConsole> | undefined
  let presetRoot: string | undefined
  const disposeApplicationTools: Array<() => void> = []

  beforeAll(async () => {
    presetRoot = await mkdtemp(join(tmpdir(), 'dsh-minimal-selected-'))
    const selectedDir = join(presetRoot, 'minimal-selected')
    await cp(MINIMAL_PRESET, selectedDir, { recursive: true })
    await writeFile(
      join(selectedDir, 'preset.yml'),
      'name: Minimal mode\ndescription: Selected application tools.\n',
    )
    const compositionPath = join(selectedDir, 'agent.cordis.yml')
    const composition = await readFile(compositionPath, 'utf8')
    await writeFile(compositionPath, `${composition.trimEnd()}

- id: tool-selection
  name: '@deepseek-ai/dsh-agent-tool-presentation'
  config:
    mode: native
    allow:
      - application_lookup
      - bash
`)
    scaffold = await launchWebScaffold({
      replayFixture: FIXTURE,
      compareReplaySession: true,
      paceMs: 10,
      agentPresets: {
        roots: [{ path: presetRoot, trust: 'user' }],
        default: 'minimal-selected',
      },
    })
    disposeApplicationTools.push(
      scaffold.ctx.tools.register(applicationTool('application_lookup')),
      scaffold.ctx.tools.register(applicationTool('application_private')),
      scaffold.ctx.tools.register(applicationTool('bash')),
    )
    disposeInjectedPrompt = scaffold.ctx.systemPrompt.section({
      name: 'test:injected-prompt',
      order: 999,
      text: 'THIS TEXT MUST NOT REACH THE MODEL.',
    })
    agentHandle = await scaffold.ctx.agents.create({
      sessionId: SessionId('minimal-preset-smoke'),
      meta: { cwd: scaffold.workspaceCwd, agentPreset: 'minimal-selected' },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx, 'minimal-selected').then(() => undefined),
    })
    agentHandle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: PROMPT }],
      source: { kind: 'user' },
    }))
    await agentHandle.agent.whenIdle()
  })

  afterAll(async () => {
    const failures: unknown[] = []
    await page?.close().catch((error: unknown) => failures.push(error))
    await browser?.close().catch((error: unknown) => failures.push(error))
    await agentHandle?.dispose().catch((error: unknown) => failures.push(error))
    try {
      disposeInjectedPrompt?.()
    } catch (error: unknown) {
      failures.push(error)
    }
    for (const dispose of disposeApplicationTools.splice(0)) {
      try {
        dispose()
      } catch (error: unknown) {
        failures.push(error)
      }
    }
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (presetRoot !== undefined) {
      await rm(presetRoot, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'minimal preset smoke teardown failed')
  })

  it('sends the selected schemas, then executes the persistent shell', async () => {
    const requestHeader = agentHandle.agent.session.requestHeader()
    if (requestHeader === undefined) throw new Error('the minimal agent issued no model request')
    expect(agentHandle.agent.session.events.some(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === '@deepseek-ai/dsh-system-prompt')).toBe(false)
    const presetFileSystem = scaffold.ctx.agentPresets.serviceFor(agentHandle.agent, 'fs')
    expect(presetFileSystem).toBeDefined()
    expect(presetFileSystem?.sandboxMode).toBeUndefined()
    expect(scaffold.ctx.agentPresets.serviceFor(agentHandle.agent, 'compaction')).toBeUndefined()

    const stateDir = join(scaffold.workspaceCwd, 'persistent-state')
    await mkdir(stateDir)
    const signal = new AbortController().signal
    await scaffold.ctx.tools.execute({
      signal,
      callId: ToolCallId('minimal-bash-state-setup'),
      name: 'bash',
      arguments: { command: `cd ${JSON.stringify(stateDir)} && export DSH_MINIMAL_STATE=PERSISTED` },
      agent: agentHandle.agent,
    })
    const bash = await scaffold.ctx.tools.execute({
      signal,
      callId: ToolCallId('minimal-bash-state-read'),
      name: 'bash',
      arguments: { command: 'printf \'%s:%s\n\' "$DSH_MINIMAL_STATE" "$PWD"' },
      agent: agentHandle.agent,
    })
    const text = (result: typeof bash): string => result.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
      .replaceAll(scaffold.workspaceCwd, '{{cwd}}')
      .trimEnd()

    expect({
      prompt: requestHeader.system,
      tools: requestHeader.tools?.map(tool => tool.name),
      goalCommand: scaffold.ctx.commands.find(agentHandle.agent, 'goal') !== undefined,
      bash: text(bash),
    }).toMatchInlineSnapshot(`
      {
        "bash": "PERSISTED:{{cwd}}/persistent-state",
        "goalCommand": false,
        "prompt": "You are a helpful software engineer assistant.",
        "tools": [
          "application_lookup",
          "bash",
        ],
      }
    `)
    expect(requestHeader.tools?.toSorted((left, right) => left.name.localeCompare(right.name)))
      .toEqual(scaffold.ctx.tools.schemas(agentHandle.agent).toSorted((left, right) => left.name.localeCompare(right.name)))
  })

  it.skipIf(MODE === 'record')('expands the completed persistent Bash call in the Web conversation', async () => {
    onTestFailed(() => { if (page !== undefined) void saveFailureShot(page, 'web-minimal-persistent-bash-card') })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })

    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    await page.getByText('MINIMAL_PRESET_REQUEST_OK', { exact: true }).waitFor({ timeout: 15_000 })

    const process = page.locator('[data-turn-process]')
    await process.waitFor({ timeout: 15_000 })
    await expect.poll(() => process.getAttribute('aria-expanded')).toBe('false')
    await process.click()
    await expect.poll(() => process.getAttribute('aria-expanded')).toBe('true')

    const row = page.locator('[data-sample="bash"]').first()
    await row.waitFor({ timeout: 15_000 })
    await expect.poll(() => row.getAttribute('aria-expanded')).toBe('false')
    await row.click()

    await expect.poll(() => row.getAttribute('aria-expanded')).toBe('true')
    const call = row.locator('xpath=..')
    await call.getByText('IN', { exact: true }).waitFor()
    await call.getByText('OUT', { exact: true }).waitFor()
    await call.getByText('MINIMAL_BASH_CARD_OK', { exact: true }).waitFor()
    await call.getByText(/"command": "printf 'MINIMAL_BASH_CARD_OK/).waitFor()

    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'session.jsonl',
      'system-prompt.expected.md',
      'tool-schemas.expected.json',
      'ui.expected.md',
    ])
  })
})
