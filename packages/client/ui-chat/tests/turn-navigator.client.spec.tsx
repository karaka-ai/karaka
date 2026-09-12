// @vitest-environment jsdom

import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { TurnNavigator } from '../src/client/chat/TurnNavigator.tsx'
import type { TurnRailItem } from '../src/client/chat/turn-rail-items.ts'
import { en } from '../src/client/locale.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('updates preview positioning on resize after the rail appears and reappears', () => {
  const observers = new Map<Element, () => void>()
  vi.stubGlobal('ResizeObserver', class {
    private readonly targets = new Set<Element>()
    constructor(private readonly callback: () => void) {}
    observe(target: Element) {
      this.targets.add(target)
      observers.set(target, this.callback)
    }
    disconnect() {
      for (const target of this.targets) observers.delete(target)
      this.targets.clear()
    }
  })
  const items: TurnRailItem[] = [1, 2, 3].map(turn => ({
    turn, prompt: `Prompt ${String(turn)}`, response: '', anchor: { kind: 'unloaded', seq: SessionSeq(turn * 10) },
  }))
  const props = { activeTurn: null, busyTurn: null, onNavigate: vi.fn(), t: makeTranslate(en) }
  const view = render(<TurnNavigator {...props} items={items.slice(0, 1)} />)
  expect(screen.queryByRole('navigation')).toBeNull()

  const resizeRail = (): void => {
    const rail = screen.getByRole('navigation')
    const scroller = rail.firstElementChild as HTMLElement
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 32 },
      clientHeight: { configurable: true, value: 12 },
      scrollTop: { configurable: true, value: 10 },
    })
    act(() => { observers.get(scroller)?.() })
    // The preview position must follow the resized scrollport even without a scroll event.
    expect(rail.style.getPropertyValue('--turn-scroll-top')).toBe('10px')
  }

  view.rerender(<TurnNavigator {...props} items={items} />)
  resizeRail()
  view.rerender(<TurnNavigator {...props} items={items.slice(0, 1)} />)
  expect(observers.size).toBe(0)
  view.rerender(<TurnNavigator {...props} items={items} />)
  resizeRail()
  view.unmount()
  expect(observers.size).toBe(0)
})
