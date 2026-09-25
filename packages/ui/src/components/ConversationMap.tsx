import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'

import type { Turn } from '@harnessdesk/protocol'

import { Button, ChartTip, Tick } from '../design'
import { buildMarks, railFit, shouldRenderMap, type RailFit } from '../lib/conversation-map'
import styles from './ConversationMap.module.css'

/**
 * The transcript, seen from the side.
 *
 * A stack of dashes down the left edge, one for each thing said. Moving along
 * it magnifies the dashes near the pointer the way a dock does, the nearest
 * one offers its first words, and pressing it goes there.
 *
 * Two things are worth knowing before changing any of it.
 *
 * **A dash grows sideways only.** Magnifying its height would move every dash
 * below it, so the mark under the pointer would slide out from under the
 * pointer — the same fault a row has when its contents re-flow on hover, and
 * worse here because the whole point of the rail is that a place stays put
 * while you look for it.
 *
 * **The falloff is a cosine, not a step.** A linear ramp reads as a bar chart
 * following the mouse; the cosine is what makes a run of dashes read as one
 * surface being pushed. `RADIUS` is how far the push reaches; how far a dash
 * travels at the peak is the stylesheet's, since it is a width.
 */

/** How far along the rail a dash still feels the pointer. */
const RADIUS = 46
/** How near the pointer has to be for a dash to offer its words. */
const SNAP = 24

export const ConversationMap = ({
  turns,
  scroll,
}: {
  readonly turns: readonly Turn[]
  /** The transcript's scroller — the thing this is a picture of. */
  readonly scroll: RefObject<HTMLDivElement | null>
}) => {
  const marks = useMemo(() => buildMarks(turns), [turns])
  const rail = useRef<HTMLElement>(null)
  const [pointer, setPointer] = useState<number | null>(null)
  const [overflows, setOverflows] = useState(false)
  const [fit, setFit] = useState<RailFit>(null)
  const drawn = shouldRenderMap({ marks: marks.length, overflows }) && fit !== null
  const shownRef = useRef(false)
  shownRef.current = fit !== null

  /* Whether there is anything to navigate, asked of the scroller rather than
     of the turn count: a short transcript of long answers overflows and a long
     one of one-word replies may not. And how much of the gutter the rail may
     use, asked of the same scroller: where its reading column starts, in the
     pane's own spacing tokens (see `railFit`). */
  useEffect(() => {
    const node = scroll.current
    if (!node) return
    const scrolled = () => setOverflows(node.scrollHeight - node.clientHeight > 1)
    /* The gutter only moves when the scroller's size does, so it is measured
       by the observer and never on a scroll. */
    const resized = () => {
      scrolled()
      const edge = node.getBoundingClientRect().left
      const column = [...node.querySelectorAll<HTMLElement>('[data-part] > *')]
        .map((one) => one.getBoundingClientRect())
        .filter((box) => box.width > 0)
      if (column.length === 0) return
      const tokens = getComputedStyle(node)
      const px = (name: string): number => Number.parseFloat(tokens.getPropertyValue(name)) || 0
      // Where a mark draws its dash, read off one that is drawn: its padding
      // and its hairline, rather than a sum of what they ought to be. Until
      // one is, `railFit` guesses the same sum from the tokens.
      const tick = rail.current?.querySelector('[data-slot="tick"]')
      const mark = tick?.parentElement
      const next = railFit({
        gutter: Math.min(...column.map((box) => box.left)) - edge,
        gap: px('--hd-space-1'),
        step: px('--hd-space-2'),
        stroke: px('--hd-space-3'),
        hairline: px('--hd-border-width'),
        shown: shownRef.current,
        ...(tick && mark ? { inset: tick.getBoundingClientRect().left - mark.getBoundingClientRect().left } : {}),
      })
      setFit((was) => (JSON.stringify(was) === JSON.stringify(next) ? was : next))
    }
    resized()
    const observer = new ResizeObserver(resized)
    observer.observe(node)
    node.addEventListener('scroll', scrolled, { passive: true })
    return () => {
      observer.disconnect()
      node.removeEventListener('scroll', scrolled)
    }
    // Measured again once the rail is drawn, so the inset is the drawn one.
  }, [scroll, marks.length, drawn])

  /* The half of the turn the mark previewed, not the turn around it: a dash
     showing the answer that lands on the prompt has taken the reader somewhere
     they did not ask to go. The turn itself is the fallback, for a transcript
     whose halves are not marked. */
  const goTo = useCallback(
    (turn: string, part: 'prompt' | 'answer') => {
      const id = CSS.escape(turn)
      const target =
        scroll.current?.querySelector(`[data-turn="${id}"][data-part="${part}"]`) ??
        scroll.current?.querySelector(`[data-turn="${id}"]`)
      target?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    },
    [scroll],
  )

  if (!drawn || fit === null) return null

  /* The dock falloff. `near` is 1 under the pointer and 0 at the edge of its
     reach; cosine rather than the raw distance so the run reads as a surface
     being pushed rather than a chart of distances. */
  const push = (centre: number): number => {
    if (pointer === null) return 0
    const away = Math.abs(centre - pointer)
    if (away >= RADIUS) return 0
    return (Math.cos((away / RADIUS) * Math.PI) + 1) / 2
  }

  return (
    <nav
      ref={rail}
      className={styles.rail}
      data-fit={fit.fit}
      /* The push, and in a tight pane the longest a dash may be, as measured
         against the column: custom properties only the dash's width reads. */
      style={{ '--reach': `${fit.reach}px`, ...(fit.cap === null ? {} : { '--cap': `${fit.cap}px` }) } as React.CSSProperties}
      aria-label="Jump to a message"
      onPointerMove={(event) => {
        const box = event.currentTarget.getBoundingClientRect()
        setPointer(event.clientY - box.top)
      }}
      onPointerLeave={() => setPointer(null)}
    >
      {marks.map((mark, index) => {
        /* Its own middle, in the rail's coordinates. Read from the element so
           the arithmetic cannot drift from the layout; the rail is short
           enough that this costs nothing a person can feel. */
        const node = rail.current?.children[index] as HTMLElement | undefined
        const centre = node ? node.offsetTop + node.offsetHeight / 2 : -RADIUS * 2
        const near = push(centre)
        return (
          <Button
            key={`${mark.turn}-${mark.kind}-${index}`}
            type="button"
            variant="ghost"
            size="chip"
            className={styles.mark}
            data-kind={mark.kind}
            style={{ '--near': near } as React.CSSProperties}
            aria-label={mark.preview}
            onClick={() => goTo(mark.turn, mark.kind)}
          >
            {/* The dash is the drawing; the control around it is the target,
                because two pixels is not something anybody can hit. */}
            {/* What was asked stands out from what came back: a strong
                stroke for the prompt, a quiet one for the answer. */}
            <Tick emphasis={mark.kind === 'prompt' ? 'strong' : 'quiet'} className={styles.dash} />
            {near > SNAP / RADIUS && (
              <ChartTip as="span" className={styles.preview}>{mark.preview}</ChartTip>
            )}
          </Button>
        )
      })}
    </nav>
  )
}
