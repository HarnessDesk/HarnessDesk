import type { LucideIcon } from 'lucide-react'
import { useAnimationControls, type LegacyAnimationControls } from 'motion/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'

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
 *
 * And a glyph is not an animation until it has to be. Every icon starts as the
 * plain Lucide drawing — one `<svg>`, nothing to schedule — and is swapped for
 * the animated drawing the first time a pointer reaches its control, at the
 * same size, in the same place. An icon nobody hovers never mounts a motion
 * component, which is what keeps a page of them as cheap as it was.
 */

const HOST = [
  'button',
  'a[href]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="option"]',
  'summary',
  '[data-icon-host]',
].join(',')

const GLYPH = 'svg[data-glyph="animated"]'

/** A glyph is either still drawn plain and able to wake, or live and able to play. */
type Entry = { readonly wake: () => void } | { readonly controls: LegacyAnimationControls }

const registry = new WeakMap<Element, Entry>()
// A host can still be returning to rest after the pointer moves elsewhere.
// Keep live controls iterable so a preference change stops every such motion.
const liveControls = new Set<LegacyAnimationControls>()
let current: Element | null = null
let wired = false
let preference: MediaQueryList | undefined

// Find ownership before checking eligibility: a disabled nested control must
// not fall through to an enabled ancestor, including explicit icon hosts.
const owner = (element: Element) => element.closest(HOST)
const enabled = (host: Element) => !host.matches(':disabled, [aria-disabled="true"]')

const play = (host: Element, variant: 'animate' | 'normal') => {
  for (const svg of host.querySelectorAll(GLYPH)) {
    if (owner(svg) !== host) continue
    const entry = registry.get(svg)
    if (!entry) continue
    if ('controls' in entry) {
      if (reduced()) {
        entry.controls.stop()
        entry.controls.set('normal')
      } else void entry.controls.start(variant)
    }
    else if (variant === 'animate') entry.wake()
  }
}

const reduced = () => preference?.matches ?? false

const enter = (next: Element | null) => {
  if (next === current) return
  if (current) play(current, 'normal')
  current = next
  if (next && !reduced()) play(next, 'animate')
}

const wire = () => {
  if (wired || typeof document === 'undefined') return
  wired = true
  if (typeof matchMedia === 'function') {
    preference = matchMedia('(prefers-reduced-motion: reduce)')
    preference.addEventListener('change', () => {
      if (reduced()) {
        for (const controls of liveControls) {
          controls.stop()
          controls.set('normal')
        }
      } else if (current) play(current, enabled(current) ? 'animate' : 'normal')
    })
  }
  document.addEventListener('mouseover', (event) => {
    const host = (event.target as Element | null)?.closest?.(HOST)
    enter(host && enabled(host) ? host : null)
  }, { passive: true })
  // Leaving the window sends no `mouseover` to anything, so a glyph would keep playing.
  document.addEventListener('mouseout', (event) => { if (!event.relatedTarget) enter(null) }, { passive: true })
}

type Draw = (props: GlyphProps) => ReactNode
type Own = Omit<GlyphProps, 'controls' | 'ref'>
type Props = Own & { readonly draw: Draw; readonly still: LucideIcon }

/** The plain drawing, waiting for a pointer. */
const Idle = ({ still: Still, wake, draw: _draw, ...props }: Own & { readonly still: LucideIcon; readonly draw: Draw; readonly wake: () => void }) => {
  const ref = useRef<SVGSVGElement>(null)
  useEffect(() => {
    const svg = ref.current
    if (!svg) return
    wire()
    registry.set(svg, { wake })
    return () => { registry.delete(svg) }
  }, [wake])
  return <Still {...props} ref={ref} data-glyph="animated" />
}

/** The animated drawing, mounted once a pointer has asked for it. */
const Live = ({ draw: Draw, still: _still, ...props }: Props) => {
  const controls = useAnimationControls()
  const ref = useRef<SVGSVGElement>(null)
  useEffect(() => {
    const svg = ref.current
    if (!svg) return
    wire()
    registry.set(svg, { controls })
    liveControls.add(controls)
    // It was woken by the pointer already over its control, which will not enter it again.
    if (current && owner(svg) === current && enabled(current) && !reduced()) void controls.start('animate')
    return () => { registry.delete(svg); liveControls.delete(controls) }
  }, [controls])
  return <Draw {...props} controls={controls} ref={ref} data-glyph="animated" />
}

export const Animated = (props: Props) => {
  const [live, setLive] = useState(false)
  const wake = useRef(() => setLive(true)).current
  return live ? <Live {...props} /> : <Idle {...props} wake={wake} />
}
