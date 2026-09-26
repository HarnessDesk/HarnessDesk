import { cva } from 'class-variance-authority'
import { forwardRef, useEffect, useRef, type ComponentProps, type RefObject } from 'react'

/**
 * The inline and bottom inset a scrolling pane's own reading column keeps —
 * lined up with whatever gutter its own scrollbar reserves, and clear of a
 * floating composer where one sits over it.
 *
 * Four screens each drew this by hand: the transcript's own scroll box and
 * the strip of bars above its composer (both in `Conversation.tsx`), the
 * room's own stream (`TeamRoomPane.tsx`), the sidebar's rail row
 * (`SessionTree.tsx`), and a background-jobs strip nested inside the
 * transcript's own bars (`SessionBars.tsx`). None of the four is the same
 * pixel value — the transcript reserves its own scrollbar's width on top of
 * 24px, the room relies on `scrollbar-gutter` instead and stays flat, the
 * rail is the sidebar's own indent, and the jobs strip is smaller still — so
 * `inset` names each shape rather than forcing one number on every screen
 * that carries a version of it. `clearComposer` is the transcript's alone:
 * only its composer floats over the column rather than sitting in flow.
 */

type PaneColumnInset = 'transcript' | 'bars' | 'stream' | 'rail' | 'jobs'

/** Each inset's own inline (left/right) padding. Never a screen's prop — the
 *  point of naming the shape is that no caller spells out a pixel value. */
const INLINE: Record<PaneColumnInset, string> = {
  // The transcript's own scrollbar sits inside this padding rather than
  // beside it (`scrollbar-gutter: stable both-edges`), so the reading column
  // stays off the pane by 24px plus that gutter's own width — otherwise it
  // would centre 4px off the composer below, which does not scroll and so
  // reserves no gutter of its own.
  transcript: 'calc(var(--hd-space-6) + var(--hd-scrollbar-width, 8px))',
  bars: 'calc(var(--hd-space-6) + var(--hd-scrollbar-width, 8px))',
  // The room takes the same 24px flat: its own scrollbar gutter is reserved
  // by the same CSS property, but nothing below the stream needs the extra
  // compensation the transcript's floating composer does.
  stream: 'var(--hd-space-6)',
  rail: 'var(--rail)',
  jobs: 'var(--hd-space-3)',
}

/** Each inset's own static top-and-bottom padding — `0` unless named here.
 *  The transcript's own vertical inset is never static (`clearComposer`,
 *  below, is the only one that carries a runtime-measured height). */
const VERTICAL: Partial<Record<PaneColumnInset, string>> = {
  // The room's composer sits in flow below the stream rather than floating
  // over it, so this is the whole of its own top-and-bottom air — no
  // measured height to clear.
  stream: 'var(--hd-space-2)',
}

export interface PaneColumnProps extends ComponentProps<'div'> {
  inset: PaneColumnInset
  /**
   * The transcript's own composer floats over the column rather than sitting
   * in flow below it, so the column's bottom must clear its measured height
   * (`--composer-h`, set by `useComposerHeightVar` below) plus a notice
   * banner's own inset above (`--hd-notice-inset`). Meaningful only for
   * `inset="transcript"`; every other inset keeps whatever static vertical
   * padding `VERTICAL` above gives it, or none.
   */
  clearComposer?: boolean
}

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
 * The one inset `PaneColumn` itself cannot carry: the sidebar's row hands its
 * inline padding to `SessionHoverCard`'s own `className`, which is the hover
 * trigger's own surface — wrapping it in another element would move the
 * trigger's edge rather than merely its padding. A class name composed here,
 * the same way `Chip`'s tone reads from `softTone({ tone })`, so the rail's
 * own inset stays this file's the day it changes rather than a literal a
 * screen repeats.
 */
export const paneColumnInsetClassName = cva('', {
  variants: {
    inset: {
      transcript: 'px-[calc(var(--hd-space-6)+var(--hd-scrollbar-width,8px))]',
      bars: 'px-[calc(var(--hd-space-6)+var(--hd-scrollbar-width,8px))]',
      stream: 'px-(--hd-space-6)',
      rail: 'px-(--rail)',
      jobs: 'px-(--hd-space-3)',
    },
  },
})

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
