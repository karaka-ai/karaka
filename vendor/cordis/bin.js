#!/usr/bin/env node

import { Context } from '@karaka/cordis'
import { pathToFileURL } from 'node:url'
import Loader from '@karaka/cordis-plugin-loader'

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'

await ctx.plugin(Loader)
await ctx.loader.create({
  name: '@karaka/cordis-plugin-include',
  config: {
    path: './cordis.yml',
  },
})
