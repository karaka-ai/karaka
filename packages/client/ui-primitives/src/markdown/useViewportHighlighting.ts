import { useCallback, useEffect, useState } from 'react'
import type { RefObject } from 'react'
import { supportsHighlighting } from './highlight.ts'

/** One document-wide observer; activated elements leave it permanently. */
class HighlightViewport {
  private observer: IntersectionObserver | undefined
  private readonly activators = new Map<Element, () => void>()

  observe(element: Element, activate: () => void): () => void {
    this.observer ??= new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const current = this.activators.get(entry.target)
        // Queued entries may arrive after a target unmounts.
        if (current === undefined) continue
        this.activators.delete(entry.target)
        this.observer?.unobserve(entry.target)
        current()
      }
      this.releaseEmptyObserver()
    })
    this.activators.set(element, activate)
    this.observer.observe(element)
    return () => {
      this.activators.delete(element)
      this.observer?.unobserve(element)
      this.releaseEmptyObserver()
    }
  }

  private releaseEmptyObserver(): void {
    if (this.activators.size > 0) return
    this.observer?.disconnect()
    this.observer = undefined
  }
}

const highlightViewport = new HighlightViewport()

/**
 * Activate one supported code surface when it first intersects the viewport.
 * Activation lasts for the component lifetime.
 * @param target - Code surface whose plain rendering reserves its geometry.
 * @param lang - Optional language hint.
 * @returns Whether this component may build highlighted output.
 */
export function useViewportHighlighting(
  target: RefObject<Element>,
  lang: string | undefined,
): boolean {
  const supported = supportsHighlighting(lang)
  const [activated, setActivated] = useState(false)
  const activate = useCallback(() => { setActivated(true) }, [])

  useEffect(() => {
    if (activated || !supported) return
    const element = target.current
    /* v8 ignore next -- React attaches the host ref before running effects. */
    if (element === null) return
    return highlightViewport.observe(element, activate)
  }, [activate, activated, supported, target])

  return activated && supported
}
