import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { bindingOf, matchesBinding } from '../src/records.ts'
import { owner } from './helpers.ts'

it('binds optional immutable Session fields and rejects another source with the same id', () => {
  const session = Session.create(SessionId('bound'))
  const header = { ...session.header, cwd: resolve('workspace'), origin: 'subagent' as const, delegationDepth: 1, agentPreset: 'coding' }
  const record = { state: 'bound' as const, owner, binding: bindingOf(header) }
  expect(matchesBinding(record, header)).toBe(true)
  expect(matchesBinding(record, { ...header, cwd: resolve('other') })).toBe(false)
  expect(matchesBinding(record, { ...header, agentPreset: 'other' })).toBe(false)
})
