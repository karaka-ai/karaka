import type { Context } from '@karaka/cordis'
import Schema from '@karaka/schemastery'
import { EntitlementError, type EntitlementProvider, type EntitlementStatus, type SpendAmount } from './index.ts'

/** YAML-serializable overall spend limits, expressed as exact integer strings. */
export interface Config {
  name?: string
  unit?: string
  accounts: Record<string, string>
}

export const Config: Schema<Config> = Schema.object({
  name: Schema.string().default('memory'),
  unit: Schema.string().default('USD_MICRO'),
  accounts: Schema.dict(Schema.string()).required(),
})

interface AccountState {
  readonly limit: bigint
  spent: bigint
}

/** Process-local overall spend provider intended for development and tests. */
export class MemoryEntitlementProvider implements EntitlementProvider {
  readonly name: string
  private readonly unit: string
  private readonly states = new Map<string, AccountState>()

  constructor(config: Config) {
    this.name = requireText(config.name ?? 'memory', 'provider name')
    this.unit = requireText(config.unit ?? 'USD_MICRO', 'spend unit')
    const accounts = Object.keys(config.accounts)
    if (!accounts.length) throw new TypeError('memory entitlement requires at least one account')

    for (const account of accounts) {
      requireText(account, 'account')
      this.states.set(account, { limit: parseAmount(config.accounts[account]!, account), spent: 0n })
    }
  }

  async status(account: string): Promise<EntitlementStatus> {
    return this.snapshot(account, this.requireAccount(account))
  }

  async recordSpend(account: string, spend: Readonly<SpendAmount>): Promise<EntitlementStatus> {
    const state = this.requireAccount(account)
    if (spend.unit !== this.unit) throw new TypeError(`account "${account}" does not use "${spend.unit}"`)
    if (typeof spend.amount !== 'bigint' || spend.amount < 0n) {
      throw new TypeError('spend amount must be a non-negative bigint')
    }
    state.spent += spend.amount
    return this.snapshot(account, state)
  }

  private requireAccount(account: string) {
    const state = this.states.get(account)
    if (!state) throw new EntitlementError('UNKNOWN_ACCOUNT', `entitlement account "${account}" is unknown`)
    return state
  }

  private snapshot(account: string, state: AccountState): EntitlementStatus {
    return Object.freeze({ account, unit: this.unit, limit: state.limit, spent: state.spent })
  }
}

/** Contribute one process-local overall spend provider. */
export const plugin = {
  name: 'entitlement-memory',
  inject: ['entitlement'],
  Config,
  apply(ctx: Context, config: Config) {
    ctx.entitlement.register(new MemoryEntitlementProvider(config))
  },
}

function parseAmount(value: string, account: string) {
  if (!/^\d+$/.test(value)) throw new TypeError(`limit for account "${account}" must be a non-negative integer string`)
  return BigInt(value)
}

function requireText(value: unknown, label: string): string {
  if (typeof value === 'string' && value.trim()) return value
  throw new TypeError(`${label} must be a non-empty string`)
}

export default plugin
