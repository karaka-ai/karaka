import type { Context } from '@karaka/cordis'
import Schema from '@karaka/schemastery'
import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import {
  StorageError,
  type StorageCreate,
  type StorageKey,
  type StorageProvider,
  type StorageRecord,
  type StorageUpdate,
  type StorageValue,
} from './index.ts'

/** YAML-serializable configuration for persistent local Storage. */
export interface Config {
  path: string
  name?: string
}

export const Config: Schema<Config> = Schema.object({
  path: Schema.string().required(),
  name: Schema.string().default('local'),
})

interface Row {
  value: string
  version: number
}

/** Persistent SQLite Storage provider for one local Karaka process. */
export class LocalStorageProvider implements StorageProvider {
  readonly name: string
  private readonly database: DatabaseSync
  private readonly readStatement: StatementSync
  private readonly createStatement: StatementSync
  private readonly updateStatement: StatementSync
  private readonly existsStatement: StatementSync
  private closed = false

  constructor(path: string, name = 'local') {
    this.name = requireText(name, 'provider name')
    const databasePath = requireText(path, 'storage path')
    if (databasePath === ':memory:') throw new TypeError('local storage path must be persistent')
    mkdirSync(dirname(databasePath), { recursive: true })
    this.database = new DatabaseSync(databasePath)
    this.database.exec('PRAGMA busy_timeout = 5000')
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS karaka_storage_records (
        namespace TEXT NOT NULL,
        record_key TEXT NOT NULL,
        value TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 1),
        PRIMARY KEY (namespace, record_key)
      ) STRICT
    `)
    this.readStatement = this.database.prepare(`
      SELECT value, version
      FROM karaka_storage_records
      WHERE namespace = ? AND record_key = ?
    `)
    this.createStatement = this.database.prepare(`
      INSERT INTO karaka_storage_records (namespace, record_key, value, version)
      VALUES (?, ?, ?, 1)
      ON CONFLICT (namespace, record_key) DO NOTHING
    `)
    this.updateStatement = this.database.prepare(`
      UPDATE karaka_storage_records
      SET value = ?, version = version + 1
      WHERE namespace = ? AND record_key = ? AND version = ?
    `)
    this.existsStatement = this.database.prepare(`
      SELECT 1 AS found
      FROM karaka_storage_records
      WHERE namespace = ? AND record_key = ?
    `)
  }

  async read(key: Readonly<StorageKey>): Promise<StorageRecord | undefined> {
    this.assertOpen()
    const row = this.readStatement.get(key.namespace, key.key) as Row | undefined
    return row ? snapshot(key, row) : undefined
  }

  async create(record: Readonly<StorageCreate>): Promise<StorageRecord> {
    this.assertOpen()
    const result = this.createStatement.run(record.namespace, record.key, JSON.stringify(record.value))
    if (!result.changes) {
      throw new StorageError('ALREADY_EXISTS', `storage record "${record.namespace}/${record.key}" already exists`)
    }
    return { ...record, version: 1 }
  }

  async update(record: Readonly<StorageUpdate>): Promise<StorageRecord> {
    this.assertOpen()
    const result = this.updateStatement.run(
      JSON.stringify(record.value),
      record.namespace,
      record.key,
      record.expectedVersion,
    )
    if (!result.changes) {
      const exists = this.existsStatement.get(record.namespace, record.key)
      if (!exists) throw new StorageError('NOT_FOUND', `storage record "${record.namespace}/${record.key}" does not exist`)
      throw new StorageError('CONFLICT', `storage record "${record.namespace}/${record.key}" changed`)
    }
    return { namespace: record.namespace, key: record.key, value: record.value, version: record.expectedVersion + 1 }
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.database.close()
  }

  private assertOpen() {
    if (this.closed) throw new StorageError('UNAVAILABLE', 'local storage provider is closed')
  }
}

/** Contribute one persistent local Storage provider. */
export const plugin = {
  name: 'storage-local',
  inject: ['storage'],
  Config,
  apply(ctx: Context, config: Config) {
    const provider = new LocalStorageProvider(resolvePath(ctx, config.path), config.name)
    try {
      const unregister = ctx.storage.register(provider)
      return async () => {
        try {
          await unregister()
        } finally {
          provider.close()
        }
      }
    } catch (error) {
      provider.close()
      throw error
    }
  },
}

function resolvePath(ctx: Context, path: string) {
  const configured = requireText(path, 'storage path')
  if (configured === ':memory:') return configured
  if (configured.startsWith('file:')) return fileURLToPath(configured)
  if (isAbsolute(configured)) return configured
  if (ctx.baseUrl) return fileURLToPath(new URL(configured, ctx.baseUrl))
  return resolve(configured)
}

function snapshot(key: StorageKey, row: Row): StorageRecord {
  return {
    namespace: key.namespace,
    key: key.key,
    value: JSON.parse(row.value) as StorageValue,
    version: Number(row.version),
  }
}

function requireText(value: unknown, label: string): string {
  if (typeof value === 'string' && value.trim()) return value
  throw new TypeError(`${label} must be a non-empty string`)
}

export default plugin
