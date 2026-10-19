import { useEffect } from 'react'

/**
 * The Flows scene builds itself: each card's diagram draws a step, then the
 * rule that reaches the next, until it is whole, holds, and starts over. The
 * production cards are untouched; the loop only marks what is not drawn yet
 * (`data-flow-pending`, which scene.css hides) on the elements those cards
 * already render. Reduced motion never starts it, so the cards stay whole.
 */
const STEP = 0.45
const CARD_STAGGER = 0.22
const HOLD = 3.6
const FADE = 0.5
const REST = 0.6
const TICK_MS = 80

interface Reveal { readonly el: Element; readonly at: number }

/** A card's drawing in the order it reads: a step, the lines that arrive at it, the next step. */
const sequence = (graph: Element, offset: number): Reveal[] => {
  const steps = [...graph.querySelectorAll('[data-step]')]
  const edges = [...graph.querySelectorAll('[data-edge]')]
  const order: Element[] = []
  const placed = new Set<Element>()
  for (const step of steps) {
    order.push(step)
    for (const edge of edges) {
      const target = edge.getAttribute('data-edge')?.split('>')[1]
      if (target === step.getAttribute('data-step') && edge.getAttribute('data-kind') !== 'loop' && !placed.has(edge)) { placed.add(edge); order.splice(order.length - 1, 0, edge) }
    }
  }
  for (const edge of edges) if (!placed.has(edge)) order.push(edge)
  return order.map((el, index) => ({ el, at: offset + index * STEP }))
}

export const useFlowsLoop = (active: boolean) => {
  useEffect(() => {
    if (!active) return
    let start: number | null = null
    let reveals: Reveal[] = []
    let known = 0
    let end = 0
    const tick = () => {
      const graphs = [...document.querySelectorAll('[data-slot="flow-mini-graph"]')].filter(graph => graph.querySelector('[data-step]'))
      if (graphs.length === 0) return
      if (start === null || graphs.length !== known || reveals.some(({ el }) => !el.isConnected)) {
        start ??= performance.now()
        known = graphs.length
        reveals = graphs.flatMap((graph, index) => sequence(graph, Math.min(index, 5) * CARD_STAGGER))
        end = Math.max(...reveals.map(({ at }) => at)) + STEP + HOLD
      }
      const now = ((performance.now() - start) / 1000) % (end + FADE + REST)
      for (const { el, at } of reveals) {
        const hidden = now < at || now >= end
        if (el.hasAttribute('data-flow-pending') !== hidden) el.toggleAttribute('data-flow-pending', hidden)
      }
    }
    tick()
    const timer = window.setInterval(tick, TICK_MS)
    return () => {
      window.clearInterval(timer)
      for (const { el } of reveals) el.removeAttribute('data-flow-pending')
    }
  }, [active])
}
