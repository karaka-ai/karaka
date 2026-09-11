/** jsdom has no layout; ordinary component tests treat mounted roots as visible. */
import { afterEach, beforeEach } from 'vitest'

class VisibleIntersectionObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}

  observe(target: Element): void {
    this.callback(
      [{ target, isIntersecting: true } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    )
  }

  unobserve(): void { /* The synchronous observation retains no target. */ }
  disconnect(): void { /* The synchronous observation retains no target. */ }
}

let previous: PropertyDescriptor | undefined

beforeEach(() => {
  if (typeof document === 'undefined') return
  previous = Object.getOwnPropertyDescriptor(globalThis, 'IntersectionObserver')
  Object.defineProperty(globalThis, 'IntersectionObserver', {
    configurable: true, writable: true, value: VisibleIntersectionObserver,
  })
})

afterEach(() => {
  if (typeof document === 'undefined') return
  if (previous === undefined) Reflect.deleteProperty(globalThis, 'IntersectionObserver')
  else Object.defineProperty(globalThis, 'IntersectionObserver', previous)
})
