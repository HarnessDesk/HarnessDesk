import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'

import type { Turn } from '@harnessdesk/protocol'

import { Button, ChartTip, Tick } from '../design'
import { buildMarks, shouldRenderMap } from '../lib/conversation-map'
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

  /* Whether there is anything to navigate, asked of the scroller rather than
     of the turn count: a short transcript of long answers overflows and a long
     one of one-word replies may not. */
  useEffect(() => {
    const node = scroll.current
    if (!node) return
    const measure = () => setOverflows(node.scrollHeight - node.clientHeight > 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    node.addEventListener('scroll', measure, { passive: true })
    return () => {
      observer.disconnect()
      node.removeEventListener('scroll', measure)
    }
  }, [scroll, marks.length])

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

  if (!shouldRenderMap({ marks: marks.length, overflows })) return null

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
              <ChartTip className={styles.preview}>{mark.preview}</ChartTip>
            )}
          </Button>
        )
      })}
    </nav>
  )
}
