import type { Context } from '@karaka/cordis'
import Schema from '@karaka/schemastery'
import type { EntitlementProvider, EntitlementStatus, SpendAmount } from './index.ts'

/** YAML-serializable defaults for ephemeral local entitlement accounts. */
export interface Config {
  name?: string
  unit?: string
  defaultLimit: string
}

export const Config: Schema<Config> = Schema.object({
  name: Schema.string().default('local'),
  unit: Schema.string().default('USD_MICRO'),
  defaultLimit: Schema.string().required(),
})

interface AccountState {
  readonly limit: bigint
  spent: bigint
}

/** Process-local entitlement provider intended for development and tests. */
export class LocalEntitlementProvider implements EntitlementProvider {
  readonly name: string
  private readonly unit: string
  private readonly defaultLimit: bigint
  private readonly states = new Map<string, AccountState>()

  constructor(config: Config) {
    this.name = requireText(config.name ?? 'local', 'provider name')
    this.unit = requireText(config.unit ?? 'USD_MICRO', 'spend unit')
    this.defaultLimit = parseAmount(config.defaultLimit)
  }

  async status(account: string): Promise<EntitlementStatus> {
    return this.snapshot(account, this.resolveAccount(account))
  }

  async recordSpend(account: string, spend: Readonly<SpendAmount>): Promise<EntitlementStatus> {
    const state = this.resolveAccount(account)
    if (spend.unit !== this.unit) throw new TypeError(`account "${account}" does not use "${spend.unit}"`)
    if (typeof spend.amount !== 'bigint' || spend.amount < 0n) {
      throw new TypeError('spend amount must be a non-negative bigint')
    }
    state.spent += spend.amount
    return this.snapshot(account, state)
  }

  private resolveAccount(account: string) {
    let state = this.states.get(account)
    if (!state) {
      state = { limit: this.defaultLimit, spent: 0n }
      this.states.set(account, state)
    }
    return state
  }

  private snapshot(account: string, state: AccountState): EntitlementStatus {
    return Object.freeze({ account, unit: this.unit, limit: state.limit, spent: state.spent })
  }
}

/** Contribute one ephemeral local entitlement provider. */
export const plugin = {
  name: 'entitlement-local',
  inject: ['entitlement'],
  Config,
  apply(ctx: Context, config: Config) {
    ctx.entitlement.register(new LocalEntitlementProvider(config))
  },
}

function parseAmount(value: string) {
  if (!/^\d+$/.test(value)) throw new TypeError('default limit must be a non-negative integer string')
  return BigInt(value)
}

function requireText(value: unknown, label: string): string {
  if (typeof value === 'string' && value.trim()) return value
  throw new TypeError(`${label} must be a non-empty string`)
}

export default plugin
