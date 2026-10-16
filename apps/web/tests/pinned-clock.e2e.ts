/** Pinned Host and page calendars keep page timers on their real schedule across navigations. */
import { chromium, type Browser } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { newEnglishPage, pinBrowserClock, pinHostClock, WEB_FIXTURE_TIME } from './support.ts'

let browser: Browser | undefined
let hostClock: ReturnType<typeof pinHostClock> | undefined

beforeAll(async () => {
  hostClock = pinHostClock()
  browser = await chromium.launch()
})

afterAll(async () => {
  try {
    await browser?.close()
  } finally {
    hostClock?.mockRestore()
  }
})

it('fires page timers after each navigation while reading the fixture day', async () => {
  const page = await newEnglishPage(browser!)
  await pinBrowserClock(page)
  for (const body of ['<p>first document</p>', '<p>second document</p>']) {
    await page.goto(`data:text/html,${encodeURIComponent(body)}`)
    const fired = page.evaluate(() => Promise.all([
      new Promise<void>((resolve) => { setTimeout(resolve, 0) }),
      new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve() }) }),
    ]).then(() => 'fired' as const))
    // The Node timer runs on the real clock, so it bounds a stalled page.
    const stalled = new Promise<'stalled'>((resolve) => { setTimeout(() => { resolve('stalled') }, 5_000) })
    expect(await Promise.race([fired, stalled])).toBe('fired')
    const read = await page.evaluate(() => ({ now: Date.now(), constructed: new Date().getTime() }))
    expect(Math.abs(read.now - WEB_FIXTURE_TIME)).toBeLessThan(120_000)
    expect(Math.abs(read.constructed - WEB_FIXTURE_TIME)).toBeLessThan(120_000)
  }
})
