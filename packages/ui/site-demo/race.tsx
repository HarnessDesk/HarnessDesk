import { useEffect } from 'react'
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

type Guest = Window & { build?: (level: number) => void }

export const RaceScene = ({ store, motion }: { store: ReturnType<typeof raceStore>; motion?: 'reduce' }) => {
  useEffect(() => {
    const built = new WeakMap<Window, number>()
    let stage: RaceStage | null = null
    const started = performance.now()
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
      const at = ((performance.now() - started) / 1000) % LOOP
      apply([...TIMELINE].reverse().find(([from]) => from <= at) ?? TIMELINE[0]!)
    }
    tick()
    const timer = window.setInterval(tick, 200)
    return () => window.clearInterval(timer)
  }, [store, motion])
  return <div data-race className="h-full bg-background text-foreground"><RaceFrame store={store} /></div>
}
