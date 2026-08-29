import { Service, type Context } from '@karaka/cordis'

declare module '@karaka/cordis' {
  interface Context {
    storage: StorageService
  }
}

/** Data that can be represented without provider-specific encoding. */
export type StorageValue =
  | null
  | boolean
  | number
  | string
  | readonly StorageValue[]
  | { readonly [key: string]: StorageValue }

/** Address of one record in a provider-neutral namespace. */
export interface StorageKey {
  readonly namespace: string
  readonly key: string
}

/** Immutable value and optimistic-concurrency version returned by Storage. */
export interface StorageRecord extends StorageKey {
  readonly value: StorageValue
  readonly version: number
}

/** Input for creating a record at version one. */
export interface StorageCreate extends StorageKey {
  readonly value: StorageValue
}

/** Input for replacing a record only at its expected version. */
export interface StorageUpdate extends StorageCreate {
  readonly expectedVersion: number
}

/** Backend implementation contributed by a Storage provider plugin. */
export interface StorageProvider {
  readonly name: string
  read(key: Readonly<StorageKey>): Promise<StorageRecord | undefined>
  create(record: Readonly<StorageCreate>): Promise<StorageRecord>
  update(record: Readonly<StorageUpdate>): Promise<StorageRecord>
}

/** Storage operations bound to one provider while it remains active. */
export interface StorageLease {
  read(key: Readonly<StorageKey>): Promise<StorageRecord | undefined>
  create(record: Readonly<StorageCreate>): Promise<StorageRecord>
  update(record: Readonly<StorageUpdate>): Promise<StorageRecord>
}

/** Stable Storage failures independent of backend implementations. */
export type StorageErrorCode =
  | 'INVALID_REQUEST'
  | 'UNAVAILABLE'
  | 'ALREADY_EXISTS'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_PROVIDER_RESPONSE'

/** Provider-neutral Storage failure. */
export class StorageError extends Error {
  override readonly name = 'StorageError'

  constructor(readonly code: StorageErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

interface RegisteredProvider {
  readonly name: string
  readonly implementation: StorageProvider
  leases: number
  active: boolean
  resolveDrained?: () => void
}

/** Routes versioned JSON record operations to the active Storage provider. */
export class StorageService extends Service {
  private provider: RegisteredProvider | undefined

  constructor(ctx: Context) {
    super(ctx, 'storage')
  }

  /** Register one provider until the contributing plugin unloads. */
  register(provider: StorageProvider) {
    const name = requireText(provider.name, 'provider name')
    const registration: RegisteredProvider = {
      name,
      implementation: provider,
      leases: 0,
      active: true,
    }

    return this.ctx.effect(() => {
      if (this.provider) throw new Error(`storage provider "${this.provider.name}" is already registered`)
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
    }, `storage.register(${JSON.stringify(name)})`)
  }

  read(key: Readonly<StorageKey>): Promise<StorageRecord | undefined> {
    return this.withProvider(storage => storage.read(key))
  }

  create(record: Readonly<StorageCreate>): Promise<StorageRecord> {
    return this.withProvider(storage => storage.create(record))
  }

  update(record: Readonly<StorageUpdate>): Promise<StorageRecord> {
    return this.withProvider(storage => storage.update(record))
  }

  /** Keep related operations on one provider while it unloads. */
  async withProvider<T>(operation: (storage: StorageLease) => T | Promise<T>): Promise<T> {
    if (typeof operation !== 'function') {
      throw new StorageError('INVALID_REQUEST', 'storage operation must be a function')
    }
    const registration = this.provider
    if (!registration) throw new StorageError('UNAVAILABLE', 'no storage provider is available')
    registration.leases++

    let released = false
    const assertLeased = () => {
      if (released) throw new StorageError('UNAVAILABLE', 'storage lease is no longer active')
    }
    const lease: StorageLease = Object.freeze({
      read: async (key: Readonly<StorageKey>) => {
        assertLeased()
        const normalizedKey = normalizeKey(key)
        const result = await registration.implementation.read(normalizedKey)
        return result === undefined ? undefined : validateRecord(result, normalizedKey)
      },
      create: async (record: Readonly<StorageCreate>) => {
        assertLeased()
        const normalized = normalizeCreate(record)
        return validateRecord(await registration.implementation.create(normalized), normalized, 1)
      },
      update: async (record: Readonly<StorageUpdate>) => {
        assertLeased()
        const normalized = normalizeUpdate(record)
        return validateRecord(
          await registration.implementation.update(normalized),
          normalized,
          normalized.expectedVersion + 1,
        )
      },
    })

    try {
      return await operation(lease)
    } finally {
      released = true
      registration.leases--
      if (!registration.active && !registration.leases) registration.resolveDrained?.()
    }
  }
}

function normalizeKey(key: Readonly<StorageKey>): StorageKey {
  return Object.freeze({
    namespace: requireRequestText(key?.namespace, 'storage namespace'),
    key: requireRequestText(key?.key, 'storage key'),
  })
}

function normalizeCreate(record: Readonly<StorageCreate>): StorageCreate {
  return Object.freeze({ ...normalizeKey(record), value: normalizeValue(record?.value) })
}

function normalizeUpdate(record: Readonly<StorageUpdate>): StorageUpdate {
  const expectedVersion = record?.expectedVersion
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new StorageError('INVALID_REQUEST', 'expected storage version must be a positive safe integer')
  }
  return Object.freeze({ ...normalizeCreate(record), expectedVersion })
}

function validateRecord(
  record: StorageRecord,
  expected: StorageKey,
  expectedVersion?: number,
): StorageRecord {
  if (
    record?.namespace !== expected.namespace
    || record.key !== expected.key
    || !Number.isSafeInteger(record.version)
    || record.version < 1
    || (expectedVersion !== undefined && record.version !== expectedVersion)
  ) {
    throw new StorageError('INVALID_PROVIDER_RESPONSE', 'storage provider returned an invalid record')
  }
  let value: StorageValue
  try {
    value = normalizeValue(record.value)
  } catch (error) {
    throw new StorageError('INVALID_PROVIDER_RESPONSE', 'storage provider returned an invalid value', { cause: error })
  }
  return Object.freeze({ namespace: record.namespace, key: record.key, value, version: record.version })
}

function normalizeValue(value: unknown): StorageValue {
  let json: string | undefined
  try {
    json = JSON.stringify(value, (_key, current: unknown) => {
      if (
        current === undefined
        || typeof current === 'bigint'
        || typeof current === 'function'
        || typeof current === 'symbol'
        || (typeof current === 'number' && !Number.isFinite(current))
      ) {
        throw new TypeError('storage values must contain only JSON-compatible data')
      }
      return current
    })
  } catch (error) {
    throw new StorageError('INVALID_REQUEST', 'storage value must be JSON-compatible', { cause: error })
  }
  if (json === undefined) throw new StorageError('INVALID_REQUEST', 'storage value must be JSON-compatible')
  return freezeValue(JSON.parse(json) as StorageValue)
}

function freezeValue(value: StorageValue): StorageValue {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeValue))
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, freezeValue(child)]),
    ))
  }
  return value
}

function requireText(value: unknown, label: string): string {
  if (typeof value === 'string' && value.trim()) return value
  throw new TypeError(`${label} must be a non-empty string`)
}

function requireRequestText(value: unknown, label: string): string {
  try {
    return requireText(value, label)
  } catch (error) {
    throw new StorageError('INVALID_REQUEST', `${label} must be a non-empty string`, { cause: error })
  }
}

export default StorageService
