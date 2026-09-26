import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'

import type { Turn } from '@harnessdesk/protocol'

import { Tick, Tooltip, TooltipContent } from '../design'
import { buildMarks, railFit, shouldRenderMap, type RailFit } from '../lib/conversation-map'
import styles from './ConversationMap.module.css'

/**
 * The transcript, seen from the side.
 *
 * A stack of dashes down the left edge, one for each thing said, packed as
 * densely as a ruler rather than given each a target of its own — a chip-sized
 * hit box per mark read as a column of buttons rather than one surface, and at
 * a real transcript's length it pushed the pitch past what a ruler can read as
 * one thing. So the rail itself is the one target: the pointer picks whichever
 * mark it is nearest (`push`, below, is the same falloff a dock uses), and a
 * click goes there. The dashes are decoration on top of that, drawn by
 * `--near` and nothing else.
 *
 * Keyboard reaches the same marks a different way, because there is no
 * per-mark element left to tab to: the rail is one stop, Up and Down move a
 * virtual position along it (`keyboardIndex`), and what is "current" is said
 * with `aria-activedescendant` rather than real DOM focus. Losing that
 * position — Escape, Tab away, the transcript changing under it — falls back
 * to whatever the pointer is doing, which is usually nothing.
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
  const markNodes = useRef<(HTMLElement | null)[]>([])
  const [pointer, setPointer] = useState<number | null>(null)
  const [overflows, setOverflows] = useState(false)
  const [fit, setFit] = useState<RailFit>(null)
  /* The one mark a preview follows while the keyboard is driving: `null` when
     it is not, so the pointer takes over the instant Escape, a blur or the
     transcript itself lets go of it. */
  const [keyboardIndex, setKeyboardIndex] = useState<number | null>(null)
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

  // A keyboard position naming a mark that is gone — the transcript moved
  // under it, or shrank past it — is worse than none: a stale index would
  // resolve to whatever now sits there instead. Same for the rail leaving the
  // page entirely.
  useEffect(() => {
    if (keyboardIndex !== null && keyboardIndex >= marks.length) setKeyboardIndex(null)
  }, [marks.length, keyboardIndex])
  useEffect(() => {
    if (!drawn) setKeyboardIndex(null)
  }, [drawn])

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

  const markCentre = (index: number): number => {
    const node = rail.current?.children[index] as HTMLElement | undefined
    return node ? node.offsetTop + node.offsetHeight / 2 : -RADIUS * 2
  }

  /* Every mark's push, read once so the one nearest the pointer can be told
     from the rest of them — reading it separately for each mark used to let a
     pointer resting between two of them put both over the SNAP threshold at
     once, and each opened its own preview. Only the peak may open one.
     While the keyboard holds a position, it simply IS the peak: the same
     `--near` the pointer would have driven, so a dash under keyboard focus
     grows exactly the way one under the pointer does. */
  const nears = marks.map((_, index) => (keyboardIndex === null ? push(markCentre(index)) : index === keyboardIndex ? 1 : 0))
  let nearestPointer: number | null = null
  if (keyboardIndex === null) {
    for (const [index, value] of nears.entries()) {
      if (value > SNAP / RADIUS && (nearestPointer === null || value > (nears[nearestPointer] ?? 0))) nearestPointer = index
    }
  }
  const openIndex = keyboardIndex ?? nearestPointer

  /* Whichever mark sits closest to a given point on the rail, for a click —
     unlike the preview, going somewhere is not gated by SNAP: the rail is the
     whole target, so every point on it belongs to its nearest mark. */
  const closestTo = (position: number): number | null => {
    let best: number | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    marks.forEach((_, index) => {
      const distance = Math.abs(markCentre(index) - position)
      if (distance < bestDistance) {
        bestDistance = distance
        best = index
      }
    })
    return best
  }

  const goToIndex = (index: number | null) => {
    const mark = index === null ? undefined : marks[index]
    if (mark) goTo(mark.turn, mark.kind)
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
      // One stop for the whole rail; Up/Down move the position below rather
      // than moving real focus, so a transcript of any length still costs the
      // rest of the page exactly one Tab.
      tabIndex={0}
      aria-activedescendant={openIndex !== null ? `conversation-map-mark-${openIndex}` : undefined}
      onPointerMove={(event) => {
        const box = event.currentTarget.getBoundingClientRect()
        setPointer(event.clientY - box.top)
      }}
      onPointerLeave={() => setPointer(null)}
      onClick={(event) => {
        const box = event.currentTarget.getBoundingClientRect()
        goToIndex(closestTo(event.clientY - box.top))
      }}
      onFocus={(event) => {
        // A click focuses the rail too, and a click is the pointer's to
        // answer — only a focus a screen reader or Tab actually produced
        // should hand the preview to the keyboard.
        if (!event.currentTarget.matches(':focus-visible')) return
        setKeyboardIndex((was) => was ?? nearestPointer ?? 0)
      }}
      onBlur={() => setKeyboardIndex(null)}
      onKeyDown={(event) => {
        if (marks.length === 0) return
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const delta = event.key === 'ArrowDown' ? 1 : -1
          setKeyboardIndex((was) => {
            const base = was ?? nearestPointer ?? (delta > 0 ? -1 : marks.length)
            return Math.min(marks.length - 1, Math.max(0, base + delta))
          })
        } else if (event.key === 'Enter' && keyboardIndex !== null) {
          goToIndex(keyboardIndex)
        } else if (event.key === 'Escape') {
          setKeyboardIndex(null)
        }
      }}
    >
      {marks.map((mark, index) => (
        <div
          key={`${mark.turn}-${mark.kind}-${index}`}
          ref={(node) => {
            markNodes.current[index] = node
          }}
          id={`conversation-map-mark-${index}`}
          role="option"
          aria-label={mark.preview}
          aria-selected={openIndex === index}
          className={styles.mark}
          data-kind={mark.kind}
          data-current={openIndex === index ? '' : undefined}
          style={{ '--near': nears[index] ?? 0 } as React.CSSProperties}
        >
          {/* What was asked stands out from what came back: a strong
              stroke for the prompt, a quiet one for the answer. */}
          <Tick emphasis={mark.kind === 'prompt' ? 'strong' : 'quiet'} className={styles.dash} />
        </div>
      ))}
      {/* One card for the whole rail, anchored to whichever mark is active —
          not one per mark — so only one can ever be open and closing never
          overlaps opening the next. */}
      <Tooltip open={openIndex !== null}>
        <TooltipContent
          side="right"
          align="center"
          anchor={openIndex !== null ? (markNodes.current[openIndex] ?? undefined) : undefined}
          className={styles.preview}
        >
          <span className={styles.previewText}>{openIndex !== null ? marks[openIndex]?.preview : ''}</span>
        </TooltipContent>
      </Tooltip>
    </nav>
  )
}
