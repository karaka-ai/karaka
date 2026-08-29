import type { Context } from '@karaka/cordis'
import Schema from '@karaka/schemastery'
import Storage from './index.ts'
import StorageLocal from './local.ts'

/** Optional override for the default local SQLite file. */
export interface Config {
  path?: string
}

export const Config: Schema<Config> = Schema.object({
  path: Schema.string().default('./.karaka/storage.sqlite'),
})

/** Mount the Storage contract and its default local SQLite provider. */
export const plugin = {
  name: 'storage-default',
  Config,
  async apply(ctx: Context, config: Config) {
    await ctx.plugin(Storage)
    await ctx.plugin(StorageLocal, {
      path: config.path ?? './.karaka/storage.sqlite',
    })
  },
}

export default plugin
