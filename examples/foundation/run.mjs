import { Context } from '@karaka/cordis'
import Include from '@karaka/cordis-plugin-include'
import Loader from '@karaka/cordis-plugin-loader'
import { pathToFileURL } from 'node:url'

const baseUrl = pathToFileURL(`${import.meta.dirname}/`).href
const ctx = new Context()
ctx.baseUrl = baseUrl

try {
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: new URL('cordis.yml', baseUrl).href },
  })
  await ctx.loader.await()
  const greeting = ctx.get('exampleGreeting')
  if (greeting === undefined) throw new Error('foundation consumer did not start')
  console.log(greeting)
} finally {
  await ctx.fiber.dispose()
}
