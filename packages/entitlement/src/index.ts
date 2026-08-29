import { Service, type Context } from '@karaka/cordis'

declare module '@karaka/cordis' {
  interface Context {
    entitlement: EntitlementService
  }
}

/** An exact amount in an opaque spend unit such as `USD_MICRO` or `CREDIT`. */
export interface SpendAmount {
  readonly unit: string
  readonly amount: bigint
}

/** Overall accumulated spend and its configured ceiling for one account. */
export interface EntitlementStatus {
  readonly account: string
  readonly unit: string
  readonly limit: bigint
  readonly spent: bigint
}

/** Storage implementation contributed by an entitlement provider plugin. */
export interface EntitlementProvider {
  readonly name: string
  status(account: string): Promise<EntitlementStatus>
  recordSpend(account: string, spend: Readonly<SpendAmount>): Promise<EntitlementStatus>
}

/** Stable entitlement failures independent of storage implementations. */
export type EntitlementErrorCode =
  | 'INVALID_REQUEST'
  | 'UNKNOWN_ACCOUNT'
  | 'UNAVAILABLE'
  | 'UNIT_MISMATCH'
  | 'EXHAUSTED'
  | 'INVALID_PROVIDER_RESPONSE'

/** Provider-neutral entitlement failure. */
export class EntitlementError extends Error {
  override readonly name = 'EntitlementError'

  constructor(readonly code: EntitlementErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

interface RegisteredProvider {
  readonly name: string
  readonly implementation: EntitlementProvider
}

/** Routes overall account checks and spend recording to the active provider plugin. */
export class EntitlementService extends Service {
  private provider: RegisteredProvider | undefined

  constructor(ctx: Context) {
    super(ctx, 'entitlement')
  }

  /** Register the provider until the contributing plugin unloads. */
  register(provider: EntitlementProvider) {
    const name = requireText(provider.name, 'provider name')
    const registration = Object.freeze({ name, implementation: provider })

    return this.ctx.effect(() => {
      if (this.provider) throw new Error(`entitlement provider "${this.provider.name}" is already registered`)
      this.provider = registration

      return () => {
        if (this.provider === registration) this.provider = undefined
      }
    }, `entitlement.register(${JSON.stringify(name)})`)
  }

  /** Read the current overall spend status for an account. */
  async status(account: string): Promise<EntitlementStatus> {
    const { accountId, provider } = this.resolve(account)
    return validateStatus(await provider.status(accountId), accountId)
  }

  /** Reject an exhausted account or a balance in the wrong spend unit. */
  async assertAvailable(account: string, unit: string): Promise<EntitlementStatus> {
    const expectedUnit = requireRequestText(unit, 'spend unit')
    const status = await this.status(account)
    if (status.unit !== expectedUnit) {
      throw new EntitlementError('UNIT_MISMATCH', `entitlement account "${status.account}" does not use "${expectedUnit}"`)
    }
    if (status.spent >= status.limit) {
      throw new EntitlementError('EXHAUSTED', `entitlement account "${status.account}" is exhausted`)
    }
    return status
  }

  /** Add actual spend to an account's accumulated total. */
  async recordSpend(account: string, spend: Readonly<SpendAmount>): Promise<EntitlementStatus> {
    const { accountId, provider } = this.resolve(account)
    const amount = validateSpend(spend)
    const current = validateStatus(await provider.status(accountId), accountId)
    if (current.unit !== amount.unit) {
      throw new EntitlementError('UNIT_MISMATCH', `entitlement account "${accountId}" does not use "${amount.unit}"`)
    }
    const updated = validateStatus(await provider.recordSpend(accountId, amount), accountId)
    if (updated.unit !== amount.unit || updated.spent < current.spent + amount.amount) {
      throw new EntitlementError('INVALID_PROVIDER_RESPONSE', 'entitlement provider did not record spend')
    }
    return updated
  }

  private resolve(account: string) {
    const accountId = requireRequestText(account, 'entitlement account')
    if (!this.provider) {
      throw new EntitlementError('UNAVAILABLE', 'no entitlement provider is available')
    }
    return { accountId, provider: this.provider.implementation }
  }
}

function validateSpend(spend: Readonly<SpendAmount>): SpendAmount {
  const unit = requireRequestText(spend?.unit, 'spend unit')
  if (typeof spend?.amount !== 'bigint' || spend.amount < 0n) {
    throw new EntitlementError('INVALID_REQUEST', 'spend amount must be a non-negative bigint')
  }
  return Object.freeze({ unit, amount: spend.amount })
}

function validateStatus(status: EntitlementStatus, account: string): EntitlementStatus {
  if (
    status?.account !== account
    || typeof status.unit !== 'string'
    || !status.unit.trim()
    || typeof status.limit !== 'bigint'
    || status.limit < 0n
    || typeof status.spent !== 'bigint'
    || status.spent < 0n
  ) {
    throw new EntitlementError('INVALID_PROVIDER_RESPONSE', 'entitlement provider returned an invalid status')
  }
  return Object.freeze({ account, unit: status.unit, limit: status.limit, spent: status.spent })
}

function requireText(value: unknown, label: string): string {
  if (typeof value === 'string' && value.trim()) return value
  throw new TypeError(`${label} must be a non-empty string`)
}

function requireRequestText(value: unknown, label: string): string {
  try {
    return requireText(value, label)
  } catch (error) {
    throw new EntitlementError('INVALID_REQUEST', `${label} must be a non-empty string`, { cause: error })
  }
}

export default EntitlementService
