import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * The scrolling tab strip, shared by the terminal dock and the browser pane.
 *
 * Two things keep it legible when there are more tabs than fit: the tab you
 * are looking at is scrolled into view whenever the selection or the strip
 * changes, and whichever edge has tabs behind it fades out. Without the fade
 * a clipped tab reads as a drawing bug rather than as "there is more this
 * way", and the tab you just opened can sit off the end where nothing
 * suggests it exists.
 *
 * Spread `edges` onto the scrolling element as data attributes and hand it
 * `strip` and `measure`; `ToolPanes.module.css` draws the rest.
 */
export const useTabStrip = (activeId: string | undefined, count: number) => {
  const strip = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ start: false, end: false })

  const measure = useCallback(() => {
    const node = strip.current
    if (!node) return
    const max = node.scrollWidth - node.clientWidth
    setEdges((was) => {
      const now = { start: node.scrollLeft > 1, end: node.scrollLeft < max - 1 }
      return was.start === now.start && was.end === now.end ? was : now
    })
  }, [])

  useEffect(() => {
    const node = strip.current
    if (!node) return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [measure])

  useEffect(() => {
    const active = strip.current?.querySelector('[data-active]')
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    measure()
  }, [activeId, count, measure])

  return { strip, edges, measure }
}

/** The `data-more-*` attributes for the scrolling element, from `edges`. */
export const stripEdges = (edges: { start: boolean; end: boolean }): Record<string, string> => ({
  ...(edges.start ? { 'data-more-start': '' } : {}),
  ...(edges.end ? { 'data-more-end': '' } : {}),
})
