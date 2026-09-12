// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReadBlock } from '../src/ReadBlock.tsx'
import { CodeBlock } from '../src/markdown/CodeBlock.tsx'
import { markdownLabels, readBlockLabels } from './labels.client.ts'

class IntersectionObserverStub {
  static instances: IntersectionObserverStub[] = []

  readonly observed = new Set<Element>()
  readonly unobserved = new Set<Element>()
  disconnected = false

  constructor(private readonly callback: IntersectionObserverCallback) {
    IntersectionObserverStub.instances.push(this)
  }

  observe(element: Element): void {
    this.observed.add(element)
  }

  unobserve(element: Element): void {
    this.observed.delete(element)
    this.unobserved.add(element)
  }

  disconnect(): void {
    this.disconnected = true
    this.observed.clear()
  }

  takeRecords(): IntersectionObserverEntry[] {
    return []
  }

  intersect(element: Element, isIntersecting: boolean): void {
    this.callback(
      [{ target: element, isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    )
  }
}

beforeEach(() => {
  IntersectionObserverStub.instances = []
  vi.stubGlobal('IntersectionObserver', IntersectionObserverStub)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('viewport-activated syntax highlighting', () => {
  it('keeps offscreen blocks plain and permanently activates only intersecting blocks', async () => {
    const view = render(
      <>
        <CodeBlock code="const first = 1" lang="ts" {...markdownLabels.code} />
        <CodeBlock code="const second = 2" lang="ts" {...markdownLabels.code} />
        <CodeBlock code="const third = 3" lang="ts" {...markdownLabels.code} />
      </>,
    )
    const blocks = [...view.container.querySelectorAll('.md-code-block')]
    expect(blocks).toHaveLength(3)
    expect(IntersectionObserverStub.instances).toHaveLength(1)
    const observer = IntersectionObserverStub.instances[0]!
    expect(observer.observed.size).toBe(3)
    expect(view.container.querySelectorAll('pre.shiki')).toHaveLength(0)

    act(() => { observer.intersect(blocks[0]!, false) })
    expect(view.container.querySelectorAll('pre.shiki')).toHaveLength(0)

    act(() => {
      observer.intersect(blocks[0]!, true)
      observer.intersect(blocks[1]!, true)
    })
    await waitFor(() => {
      expect(blocks[0]!.querySelector('pre.shiki')).not.toBeNull()
      expect(blocks[1]!.querySelector('pre.shiki')).not.toBeNull()
    })
    expect(blocks[2]!.querySelector('pre.shiki')).toBeNull()
    expect(observer.unobserved.has(blocks[0]!)).toBe(true)

    act(() => { observer.intersect(blocks[0]!, false) })
    expect(blocks[0]!.querySelector('pre.shiki')).not.toBeNull()

    view.rerender(
      <>
        <CodeBlock code="const first = 10" lang="ts" {...markdownLabels.code} />
        <CodeBlock code="const second = 2" lang="ts" {...markdownLabels.code} />
        <CodeBlock code="const third = 3" lang="ts" {...markdownLabels.code} />
      </>,
    )
    expect(blocks[0]!.querySelector('pre.shiki')?.textContent).toBe('const first = 10')

    act(() => { observer.intersect(blocks[2]!, true) })
    await waitFor(() => { expect(blocks[2]!.querySelector('pre.shiki')).not.toBeNull() })
    expect(observer.disconnected).toBe(true)
  })

  it('does not observe an unsupported language', () => {
    const view = render(
      <CodeBlock code="IDENTIFICATION DIVISION." lang="cobol" {...markdownLabels.code} />,
    )
    expect(view.container.querySelector('pre.shiki')).toBeNull()
    expect(IntersectionObserverStub.instances).toHaveLength(0)
  })

  it('releases the shared observer when the last pending block unmounts', () => {
    const view = render(<CodeBlock code="const pending = true" lang="ts" {...markdownLabels.code} />)
    const block = view.container.querySelector('.md-code-block')!
    const observer = IntersectionObserverStub.instances[0]!

    view.unmount()

    expect(observer.unobserved.has(block)).toBe(true)
    expect(observer.disconnected).toBe(true)
  })

  it('keeps an intersecting streaming block plain until its lazy grammar loads', async () => {
    const view = render(
      <CodeBlock code="print(1)" lang="python" streaming {...markdownLabels.code} />,
    )
    const block = view.container.querySelector('.md-code-block')!
    const observer = IntersectionObserverStub.instances[0]!

    act(() => { observer.intersect(block, true) })
    expect(block.querySelector('pre.shiki')).toBeNull()

    await waitFor(() => { expect(block.querySelector('pre.shiki')).not.toBeNull() }, { timeout: 5_000 })
  })

  it('starts a newly visible stream from all accumulated text and retains activation across language changes', async () => {
    const view = render(<CodeBlock code="const start = 1" lang="cobol" streaming {...markdownLabels.code} />)
    const block = view.container.querySelector('.md-code-block')!
    expect(IntersectionObserverStub.instances).toHaveLength(0)
    view.rerender(<CodeBlock code="const start = 1" lang="ts" streaming {...markdownLabels.code} />)
    const observer = IntersectionObserverStub.instances[0]!
    view.rerender(<CodeBlock code={'const start = 1\nconst grown = 2'} lang="ts" streaming {...markdownLabels.code} />)
    expect(block.querySelector('pre.shiki')).toBeNull()
    act(() => { observer.intersect(block, true) })
    await waitFor(() => { expect(block.querySelector('pre.shiki')?.textContent).toBe('const start = 1\nconst grown = 2') })
    view.rerender(<CodeBlock code="plain" lang="cobol" streaming {...markdownLabels.code} />)
    expect(block.querySelector('pre.shiki')).toBeNull()
    view.rerender(<CodeBlock code="const restored = 3" lang="ts" streaming {...markdownLabels.code} />)
    expect(block.querySelector('pre.shiki')?.textContent).toBe('const restored = 3')
    expect(IntersectionObserverStub.instances).toHaveLength(1)
  })

  it('ignores a queued entry after unmount and observes a fresh root', async () => {
    const first = render(<CodeBlock code="const first = 1" lang="ts" {...markdownLabels.code} />)
    const oldBlock = first.container.querySelector('.md-code-block')!
    const previous = IntersectionObserverStub.instances[0]!
    first.unmount()
    const next = render(<CodeBlock code="const next = 2" lang="ts" {...markdownLabels.code} />)
    const nextBlock = next.container.querySelector('.md-code-block')!
    const current = IntersectionObserverStub.instances[1]!
    act(() => { previous.intersect(oldBlock, true) })
    expect(nextBlock.querySelector('pre.shiki')).toBeNull()
    expect(current.observed.has(nextBlock)).toBe(true)
    act(() => { current.intersect(nextBlock, true) })
    await waitFor(() => { expect(nextBlock.querySelector('pre.shiki')?.textContent).toBe('const next = 2') })
  })

  it('keeps a read card plain until that card intersects', async () => {
    const view = render(
      <ReadBlock
        label="data.json"
        lang="json"
        lines={[{ number: 1, text: '{"ready":true}' }]}
        totalLines={1}
        labels={readBlockLabels}
      />,
    )
    const block = view.container.querySelector('[data-read]')!
    expect(block.querySelectorAll('[class^="_content_"] span')).toHaveLength(0)
    const observer = IntersectionObserverStub.instances[0]!

    act(() => { observer.intersect(block, true) })
    await waitFor(() => {
      expect(block.querySelectorAll('[class^="_content_"] span[style]').length).toBeGreaterThan(1)
    })
  })
})
