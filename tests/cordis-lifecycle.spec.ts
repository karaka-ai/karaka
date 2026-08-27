import { Context, Service } from '@karaka/cordis'
import { describe, expect, it } from 'vitest'

describe('Cordis lifecycle ownership', () => {
  it('awaits effects registered before an asynchronous setup settles', async () => {
    const ctx = new Context()
    const setup = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    const cleaned: string[] = []

    const fiber = ctx.plugin(async (pluginContext) => {
      pluginContext.effect(() => async () => {
        await Promise.resolve()
        cleaned.push('early')
      })
      started.resolve()
      await setup.promise
      cleaned.push('setup-settled')
    })

    await started.promise
    const disposal = fiber.dispose()
    setup.resolve()
    await disposal

    expect(cleaned).toEqual(['setup-settled', 'early'])
    await ctx.fiber.dispose()
  })

  it('suspends and restarts a consumer when its provider is replaced', async () => {
    const ctx = new Context()
    const transitions: string[] = []

    class Greeter extends Service {
      constructor(serviceContext: Context, readonly word: string) {
        super(serviceContext, 'greeter')
      }
    }

    const consumer = {
      name: 'consumer',
      inject: ['greeter'],
      apply(consumerContext: Context) {
        transitions.push(`start:${(consumerContext.get('greeter') as Greeter).word}`)
        consumerContext.effect(() => () => transitions.push('stop'))
      },
    }

    const first = ctx.plugin(class extends Greeter {
      constructor(serviceContext: Context) {
        super(serviceContext, 'first')
      }
    })
    const dependent = ctx.plugin(consumer)
    await Promise.all([first, dependent])
    expect(transitions).toEqual(['start:first'])

    await first.dispose()
    expect(transitions).toEqual(['start:first', 'stop'])

    const second = ctx.plugin(class extends Greeter {
      constructor(serviceContext: Context) {
        super(serviceContext, 'second')
      }
    })
    await second
    await dependent.await()
    expect(transitions).toEqual(['start:first', 'stop', 'start:second'])

    await ctx.fiber.dispose()
    expect(transitions.at(-1)).toBe('stop')
  })
})
