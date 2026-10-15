import { useAnimationControls, type LegacyAnimationControls } from 'motion/react'
import { useEffect, useRef, type ReactNode } from 'react'

import type { GlyphProps } from './glyph'

/**
 * When a glyph moves.
 *
 * An icon is a few pixels wide; asking the pointer to find the icon itself
 * makes the motion a trick for people who happen to hover it. What a person is
 * reaching for is the control it sits in, so the glyph plays while the pointer
 * is over the nearest button, link, menu item or tab that holds it — and rests
 * when the pointer leaves. A glyph with no such control around it never moves:
 * motion on something that cannot be clicked reads as a promise.
 *
 * There is one listener pair for the whole document, not one per icon. A
 * transcript can hold hundreds of glyphs and a pointer moving across it should
 * cost the same as one moving across a page of text.
 */

const HOST = [
  'button:not(:disabled):not([aria-disabled="true"])',
  'a[href]',
  '[role="menuitem"]:not([aria-disabled="true"])',
  '[role="tab"]',
  '[role="option"]:not([aria-disabled="true"])',
  'summary',
  '[data-icon-host]',
].join(',')

const GLYPH = 'svg[data-glyph="animated"]'

const registry = new WeakMap<Element, LegacyAnimationControls>()
let current: Element | null = null
let wired = false

const play = (host: Element, variant: 'animate' | 'normal') => {
  for (const svg of host.querySelectorAll(GLYPH)) registry.get(svg)?.start(variant)
}

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

const enter = (next: Element | null) => {
  if (next === current) return
  if (current) play(current, 'normal')
  current = next
  if (next && !reduced()) play(next, 'animate')
}

const wire = () => {
  if (wired || typeof document === 'undefined') return
  wired = true
  document.addEventListener('mouseover', (event) => enter((event.target as Element | null)?.closest?.(HOST) ?? null), { passive: true })
  // Leaving the window sends no `mouseover` to anything, so a glyph would keep playing.
  document.addEventListener('mouseout', (event) => { if (!event.relatedTarget) enter(null) }, { passive: true })
}

/** A glyph that can be told to move, registered with the document's one listener. */
export const Animated = ({ draw: Draw, ...props }: Omit<GlyphProps, 'controls' | 'ref'> & { readonly draw: (props: GlyphProps) => ReactNode }) => {
  const controls = useAnimationControls()
  const ref = useRef<SVGSVGElement>(null)
  useEffect(() => {
    const svg = ref.current
    if (!svg) return
    wire()
    registry.set(svg, controls)
    return () => { registry.delete(svg) }
  }, [controls])
  return <Draw {...props} controls={controls} ref={ref} data-glyph="animated" />
}
