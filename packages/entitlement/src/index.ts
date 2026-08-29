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

/** One overall account bound to the provider that resolved it. */
export interface EntitlementAccount {
  readonly account: string
  status(): Promise<EntitlementStatus>
  assertAvailable(unit: string): Promise<EntitlementStatus>
  recordSpend(spend: Readonly<SpendAmount>): Promise<EntitlementStatus>
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
  leases: number
  active: boolean
  resolveDrained?: () => void
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
    const registration: RegisteredProvider = {
      name,
      implementation: provider,
      leases: 0,
      active: true,
    }

    return this.ctx.effect(() => {
      if (this.provider) throw new Error(`entitlement provider "${this.provider.name}" is already registered`)
      this.provider = registration

      return async () => {
        if (this.provider === registration) this.provider = undefined
        registration.active = false
        if (registration.leases) {
          await new Promise<void>(resolve => {
            registration.resolveDrained = resolve
          })
        }
      }
    }, `entitlement.register(${JSON.stringify(name)})`)
  }

  /** Read the current overall spend status for an account. */
  status(account: string): Promise<EntitlementStatus> {
    return this.withAccount(account, lease => lease.status())
  }

  /** Reject an exhausted account or a balance in the wrong spend unit. */
  assertAvailable(account: string, unit: string): Promise<EntitlementStatus> {
    return this.withAccount(account, lease => lease.assertAvailable(unit))
  }

  /** Add actual spend to an account's accumulated total. */
  recordSpend(account: string, spend: Readonly<SpendAmount>): Promise<EntitlementStatus> {
    return this.withAccount(account, lease => lease.recordSpend(spend))
  }

  /** Run related operations against one provider capability, even while it unloads. */
  async withAccount<T>(
    account: string,
    operation: (boundAccount: EntitlementAccount) => T | Promise<T>,
  ): Promise<T> {
    const accountId = requireRequestText(account, 'entitlement account')
    const registration = this.provider
    if (!registration) {
      throw new EntitlementError('UNAVAILABLE', 'no entitlement provider is available')
    }
    registration.leases++

    let released = false
    const assertLeased = () => {
      if (released) throw new EntitlementError('UNAVAILABLE', 'entitlement account is no longer active')
    }
    const boundAccount: EntitlementAccount = Object.freeze({
      account: accountId,
      status: async () => {
        assertLeased()
        return readStatus(registration.implementation, accountId)
      },
      assertAvailable: async (unit: string) => {
        assertLeased()
        return assertProviderAvailable(registration.implementation, accountId, unit)
      },
      recordSpend: async (spend: Readonly<SpendAmount>) => {
        assertLeased()
        return recordProviderSpend(registration.implementation, accountId, spend)
      },
    })

    try {
      return await operation(boundAccount)
    } finally {
      released = true
      registration.leases--
      if (!registration.active && !registration.leases) registration.resolveDrained?.()
    }
  }
}

async function readStatus(provider: EntitlementProvider, account: string) {
  return validateStatus(await provider.status(account), account)
}

async function assertProviderAvailable(provider: EntitlementProvider, account: string, unit: string) {
  const expectedUnit = requireRequestText(unit, 'spend unit')
  const status = await readStatus(provider, account)
  if (status.unit !== expectedUnit) {
    throw new EntitlementError('UNIT_MISMATCH', `entitlement account "${status.account}" does not use "${expectedUnit}"`)
  }
  if (status.spent >= status.limit) {
    throw new EntitlementError('EXHAUSTED', `entitlement account "${status.account}" is exhausted`)
  }
  return status
}

async function recordProviderSpend(
  provider: EntitlementProvider,
  account: string,
  spend: Readonly<SpendAmount>,
) {
  const amount = validateSpend(spend)
  const current = await readStatus(provider, account)
  if (current.unit !== amount.unit) {
    throw new EntitlementError('UNIT_MISMATCH', `entitlement account "${account}" does not use "${amount.unit}"`)
  }
  const updated = validateStatus(await provider.recordSpend(account, amount), account)
  if (updated.unit !== amount.unit || updated.spent < current.spent + amount.amount) {
    throw new EntitlementError('INVALID_PROVIDER_RESPONSE', 'entitlement provider did not record spend')
  }
  return updated
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
