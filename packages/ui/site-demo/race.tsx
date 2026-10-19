import { useEffect, useRef } from 'react'
import { RaceFrame, README_RACE_URLS, type raceStore, type RaceStage } from '../src/preview/readme-race'

import { RACE_PAGES } from './race-pages'

/**
 * The website's hero: the README's race, live. Two agents built the same
 * brief; each page is served beside this demo (public/race/), and each tile's
 * Browser shows it under the loopback address its lane served it on.
 */

/* Seconds into the loop: [build level of A, build level of B, stage], as the README's GIF plays it. */
const TIMELINE: ReadonlyArray<readonly [number, number, number, RaceStage]> = [
  [0.0, 1, 1, 0], [1.4, 2, 1, 0], [2.3, 2, 2, 0], [3.4, 3, 2, 1], [4.8, 3, 3, 2], [6.4, 3, 3, 3],
]
const LOOP = 16
const SETTLED = TIMELINE[TIMELINE.length - 1]!

/* Seconds into the loop the pointer arrives at the verdict's Merge button, presses it, and leaves. */
const POINTER = { arrive: 7.0, press: 8.2, leave: 9.8 } as const
const MERGE = /^Merge .+ into main$/

type Guest = Window & { build?: (level: number) => void }

/**
 * A pointer that glides to the verdict's Merge button and presses it: the one
 * step a person takes at the end of a race. It only draws; the button is never
 * clicked, so the picture never changes the scene.
 */
const Pointer = ({ at }: { at: () => number | null }) => {
  const layer = useRef<HTMLDivElement>(null)
  const pointer = useRef<HTMLDivElement>(null)
  const ring = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const el = pointer.current
    if (!el) return
    const aura = el.querySelector('[data-aura]')?.animate?.(
      [{ opacity: 0.5, transform: 'scale(0.96)' }, { opacity: 0.9, transform: 'scale(1.06)' }, { opacity: 0.5, transform: 'scale(0.96)' }],
      { duration: 2800, iterations: Infinity })
    let phase = ''
    let release: number | undefined
    /* Beside the Merge button, in the layer's own coordinates; false while the button is not laid out yet. */
    const place = (offset: number) => {
      const target = [...document.querySelectorAll('button')].find(button => MERGE.test((button.textContent ?? '').trim()))?.getBoundingClientRect()
      const base = layer.current?.getBoundingClientRect()
      if (!target || !base) return false
      el.style.transform = `translate(${target.left - base.left + target.width * 0.62 + offset}px, ${target.top - base.top + target.height * 0.55 + offset * 0.7}px)`
      return true
    }
    let parked = false
    const tick = () => {
      const now = at()
      const next = now === null ? 'hidden' : now < POINTER.arrive ? 'waiting' : now < POINTER.press ? 'moving' : now < POINTER.leave ? 'pressed' : 'hidden'
      if (next === 'moving' || next === 'pressed') place(0)
      else if (!parked) parked = place(150)
      if (next === phase) return
      phase = next
      el.dataset.phase = next
      if (next === 'hidden' || next === 'waiting') { el.style.opacity = '0'; parked = false; return }
      el.style.opacity = '1'
      if (next === 'pressed') {
        el.style.scale = '0.86'
        release = window.setTimeout(() => { el.style.scale = '1' }, 180)
        ring.current?.animate?.([{ opacity: 0.9, transform: 'scale(0.4)' }, { opacity: 0, transform: 'scale(1.4)' }], { duration: 460, easing: 'linear' })
      }
    }
    tick()
    const timer = window.setInterval(tick, 100)
    return () => { window.clearInterval(timer); window.clearTimeout(release); aura?.cancel() }
  }, [at])
  return (
    <div ref={layer} aria-hidden className="pointer-events-none absolute inset-0 z-50 overflow-hidden">
      <div ref={pointer} data-race-pointer data-phase="waiting" className="absolute left-0 top-0 opacity-0" style={{ transition: 'transform 1100ms cubic-bezier(0.32, 0.72, 0.24, 1), opacity 300ms, scale 160ms' }}>
        <span data-aura className="absolute -left-3 -top-3 size-7 rounded-full bg-foreground/30 blur-[5px]" />
        <span ref={ring} className="absolute -left-[18px] -top-[18px] size-9 rounded-full border border-foreground/50 opacity-0" />
        <svg width="18" height="18" viewBox="0 0 18 18" className="relative -ml-px -mt-px drop-shadow"><path d="M2 1.5 15 8l-5.6 1.6L7.6 15z" className="fill-foreground stroke-background" strokeWidth="1.2" strokeLinejoin="round" /></svg>
      </div>
    </div>
  )
}

export const RaceScene = ({ store, motion }: { store: ReturnType<typeof raceStore>; motion?: 'reduce' }) => {
  const started = useRef(performance.now())
  const loopAt = useRef(() => ((performance.now() - started.current) / 1000) % LOOP)
  useEffect(() => {
    const built = new WeakMap<Window, number>()
    let stage: RaceStage | null = null
    const apply = ([, levelA, levelB, next]: readonly [number, number, number, RaceStage]) => {
      for (const frame of document.querySelectorAll('iframe')) {
        const page = frame.getAttribute('src')
        const level = page === RACE_PAGES[README_RACE_URLS['lane-alpha']] ? levelA : page === RACE_PAGES[README_RACE_URLS['lane-beta']] ? levelB : null
        const guest = frame.contentWindow as Guest | null
        if (level === null || !guest?.build || built.get(guest) === level) continue
        guest.build(level)
        built.set(guest, level)
      }
      if (next !== stage) { stage = next; store.stage(next) }
    }
    const tick = () => {
      if (motion === 'reduce') return apply(SETTLED)
      const at = loopAt.current()
      apply([...TIMELINE].reverse().find(([from]) => from <= at) ?? TIMELINE[0]!)
    }
    tick()
    const timer = window.setInterval(tick, 200)
    return () => window.clearInterval(timer)
  }, [store, motion])
  return (
    <div data-race className="relative h-full bg-background text-foreground">
      <RaceFrame store={store} />
      {motion === 'reduce' ? null : <Pointer at={loopAt.current} />}
    </div>
  )
}
