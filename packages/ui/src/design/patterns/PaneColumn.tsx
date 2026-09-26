import { forwardRef, useEffect, useRef, type ComponentProps, type RefObject } from 'react'

/**
 * The inline and bottom inset a scrolling pane's own reading column keeps —
 * lined up with whatever gutter its own scrollbar reserves, and clear of a
 * floating composer where one sits over it.
 *
 * Four screens each drew a version of this by hand. Two of them were never
 * two shapes: the transcript's own scroll box (`Conversation.tsx`) and the
 * room's own stream (`TeamRoomPane.tsx`) are the same role — a reading
 * column in a pane — and both already ask their own scroll box to reserve
 * the gutter physically (`scrollbar-gutter: stable both-edges`), so `reading`
 * is a flat `var(--hd-space-6)`: the browser adds the gutter back, and adding
 * it again in this padding double-counted it, narrowing the transcript 16px
 * against the composer under it below the column's own cap (#1016 review).
 *
 * The other two remain distinct, each for a stated reason:
 * - `bars`: the strip above the transcript's composer is not itself a scroll
 *   box, so nothing gives it the gutter for free — it adds the scrollbar's
 *   own width back explicitly, the one place that math is still correct.
 * - `jobs`: a background-jobs strip nested inside `bars`, at its own smaller
 *   scale (`var(--hd-space-3)`), not the reading column's edge at all.
 *
 * `rail` is the sidebar's own indent (`--hd-rail-inset`, a token this file
 * owns rather than a class string a screen composes around it).
 *
 * `clearComposer` is `reading`'s alone: only a floating composer needs its
 * measured height cleared, and only the transcript's own scroll box floats
 * one — the room's composer sits in flow below its stream.
 */

type ReadingInset = 'reading'
type StaticInset = 'bars' | 'jobs' | 'rail'
export type PaneColumnInset = ReadingInset | StaticInset

/** Each inset's own inline (left/right) padding. Never a screen's prop — the
 *  point of naming the shape is that no caller spells out a pixel value. */
const INLINE: Record<PaneColumnInset, string> = {
  reading: 'var(--hd-space-6)',
  bars: 'calc(var(--hd-space-6) + var(--hd-scrollbar-width, 8px))',
  jobs: 'var(--hd-space-3)',
  rail: 'var(--hd-rail-inset)',
}

/** Each inset's own static top-and-bottom padding — `0` unless named here.
 *  `reading`'s own static value is the room's: a flat breath, top and
 *  bottom. The transcript's own scroll box never takes this branch — it
 *  always sets `clearComposer`, which computes its own vertical pair. */
const VERTICAL: Partial<Record<PaneColumnInset, string>> = {
  reading: 'var(--hd-space-2)',
}

type PaneColumnCommonProps = Omit<ComponentProps<'div'>, 'inset'>

export type PaneColumnProps =
  | (PaneColumnCommonProps & {
      inset: ReadingInset
      /**
       * The transcript's own composer floats over the column rather than
       * sitting in flow below it, so the column's bottom must clear its
       * measured height (`--composer-h`, set by `useComposerHeightVar`
       * below) plus a notice banner's own inset above (`--hd-notice-inset`).
       * Absent (the room's own stream), the column keeps `reading`'s flat
       * vertical air instead.
       */
      clearComposer?: boolean
    })
  | (PaneColumnCommonProps & {
      inset: StaticInset
      /** Meaningless off `reading`: nothing else floats a composer over it. */
      clearComposer?: never
    })

/** `data-slot`/`data-inset` are for a test or a screen's own CSS to read, the
 *  same convention the rest of `design/patterns` stamps. */
export const PaneColumn = forwardRef<HTMLDivElement, PaneColumnProps>(
  ({ inset, clearComposer = false, style, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="pane-column"
      data-inset={inset}
      style={{
        padding: clearComposer
          ? `calc(8px + var(--hd-notice-inset, 0px)) ${INLINE[inset]} calc(var(--composer-h, 150px) + 16px)`
          : `${VERTICAL[inset] ?? '0'} ${INLINE[inset]}`,
        ...style,
      }}
      {...props}
    />
  ),
)
PaneColumn.displayName = 'PaneColumn'

/**
 * The transcript's composer floats over its own scrolling column, so the
 * column's bottom inset has to know how tall the composer currently is —
 * a value only the browser can measure, not a screen can guess.
 *
 * Owned here rather than in the screen: `root` is the ancestor both the
 * measured dock and the column needing its height sit under (`--composer-h`
 * is a CSS custom property, visible to descendants of whichever element
 * carries it, not to a sibling), and `dock` is the element to measure —
 * typically the strip holding the bars and the composer together. A screen
 * wires the two refs to its own markup; the observing and the `setProperty`
 * call are this hook's alone.
 */
export const useComposerHeightVar = (root: RefObject<HTMLElement | null>): RefObject<HTMLDivElement | null> => {
  const dock = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const dockElement = dock.current
    const rootElement = root.current
    if (!dockElement || !rootElement) return
    const apply = (): void => rootElement.style.setProperty('--composer-h', `${dockElement.offsetHeight}px`)
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(dockElement)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return dock
}
