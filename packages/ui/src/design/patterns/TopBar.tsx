/**
 * The fixed toolbar shared by every destination.
 *
 * More is conditional on the current page, view and fold: without an action
 * row there is no button and no empty menu. The shell recomputes it from the
 * current slots, so moving to a page with actions brings the door back.
 */
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type ComponentProps } from 'react'
import { FRAME } from '../frame'
import { Bar } from '../ui/bar'
import { Button } from '../ui/button'
import { Text } from './Settings'
import { hasMenuContent, Menu, MenuItem } from './Menu'
import { Popover } from './Popover'
import { ArrowRightIcon, MoreIcon, CaretIcon } from '../../components/Icons'
import styles from './TopBar.module.css'

export interface TopBarAction {
  readonly label: string
  readonly icon?: ReactNode
  readonly disabled?: string | false
  readonly run: () => void
}
export interface TopBarTab {
  readonly value: string
  readonly label: string
  readonly count?: number
  readonly disabled?: string | false
  readonly run: () => void
}
export interface TopBarProps {
  readonly lead?: ReactNode
  readonly parent?: { readonly label: string; readonly run: () => void }
  readonly parents?: readonly { readonly label: string; readonly run: () => void }[]
  readonly mark?: ReactNode
  readonly place: ReactNode
  /** The subject's own verbs: the title becomes a menu button with a ⌄. */
  readonly placeMenu?: (close: () => void) => ReactNode
  /** The whole name on hover, when `place` is a shortened one. */
  readonly placeTitle?: string
  readonly state?: ReactNode
  readonly tabs?: readonly TopBarTab[]
  readonly tab?: string
  readonly inspectFirst?: boolean
  readonly verb?: TopBarAction
  readonly view?: { readonly label?: string; readonly disabled?: string | false; readonly narrowed?: boolean; readonly content: (close: () => void) => ReactNode }
  readonly tools?: ReactNode
  /** Crowded bars keep the subject and a small lead; the same actions move into More. */
  readonly compact?: { readonly lead?: ReactNode; readonly more: (close: () => void) => ReactNode }
  /** Standing panel width; closed and floating panels reserve no column. */
  readonly rightColumnWidth?: number | string
  readonly more: (close: () => void, compact?: boolean) => ReactNode
  /** The surface has a working folder and can open its terminal. */
  readonly terminal?: boolean
  readonly extraMore?: readonly TopBarAction[]
  readonly corner?: boolean
}

/** Compatibility actions stay reachable while each screen moves its choices into its body. */
const moreRows = (props: TopBarProps, compact = false) => (close: () => void) => <>
  {props.verb && <MenuItem icon={props.verb.icon ?? <ArrowRightIcon />} label={props.verb.label}
    disabled={props.verb.disabled} onSelect={() => { props.verb?.run(); close() }} />}
  {(props.parents ?? (props.parent ? [props.parent] : [])).map((one, index) => <MenuItem key={`${index}:${one.label}`}
    icon={<ArrowRightIcon />} label={one.label} onSelect={() => { one.run(); close() }} />)}
  {props.more(close, compact)}
  {props.extraMore?.map(one => <MenuItem key={one.label} icon={one.icon ?? <ArrowRightIcon />} label={one.label}
    disabled={one.disabled} onSelect={() => { one.run(); close() }} />)}
</>

export const TopBar = (props: TopBarProps) => {
  const rows = moreRows(props)
  const baseMore = hasMenuContent(rows(() => {}))
  const [folded, setFolded] = useState(false)
  const [titleFloor, setTitleFloor] = useState(0)
  const rowRef = useRef<HTMLDivElement>(null)
  const leadRef = useRef<HTMLSpanElement>(null)
  const toolsRef = useRef<HTMLSpanElement>(null)
  const measurementOptions = useRef({ compact: Boolean(props.compact), baseMore })
  const measureContent = useRef<(() => void) | null>(null)
  const hasMore = baseMore || (folded && Boolean(props.compact))
  useLayoutEffect(() => {
    measurementOptions.current = { compact: Boolean(props.compact), baseMore }
    measureContent.current?.()
  })
  useLayoutEffect(() => {
    const row = rowRef.current
    if (!row) return
    const intrinsicWidth = (node: HTMLElement | null): number => {
      if (!node) return 0
      const copy = node.cloneNode(true) as HTMLElement
      copy.removeAttribute('hidden')
      Object.assign(copy.style, { position: 'fixed', visibility: 'hidden', display: 'flex', width: 'max-content', maxWidth: 'none', minWidth: 'max-content', flex: 'none' })
      row.append(copy)
      const width = copy.getBoundingClientRect().width
      copy.remove()
      return width
    }
    const measure = (): void => {
      const { compact, baseMore } = measurementOptions.current
      if (!compact) setFolded(false)
      const width = row.getBoundingClientRect().width
      if (width <= 0) return
      const css = getComputedStyle(row)
      const metric = (name: string, fallback: number) => Number.parseFloat(css.getPropertyValue(name)) || fallback
      const title = row.querySelector<HTMLElement>('[data-topbar-title]')
      const floor = Math.min(intrinsicWidth(title), metric('--hd-bar-title-min', FRAME.bar.titleMin))
      setTitleFloor(floor)
      if (!compact) return
      const lead = intrinsicWidth(leadRef.current)
      const tools = intrinsicWidth(toolsRef.current)
      const state = row.querySelector<HTMLElement>('[data-topbar="state"]')?.getBoundingClientRect().width ?? 0
      const more = baseMore ? row.querySelector<HTMLElement>('[data-topbar="more"]')?.getBoundingClientRect().width ?? FRAME.bar.iconButton : 0
      const gap = metric('--hd-bar-gap', FRAME.bar.gap)
      const toolGap = metric('--hd-bar-tool-gap', FRAME.bar.toolGap)
      const titleCss = title ? getComputedStyle(title) : null
      const margins = (Number.parseFloat(titleCss?.marginLeft ?? '') || 0) + (Number.parseFloat(titleCss?.marginRight ?? '') || 0)
      const minimum = lead + floor + margins + (state ? state + gap : 0) + tools + more + (tools && more ? toolGap : 0) + gap * (lead ? 3 : 2)
      setFolded(minimum > width)
    }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    const observed = new Set<Element>()
    let lastContent: string | null = null
    const syncContent = (): void => {
      const nodes = new Set<Element>([row, leadRef.current, toolsRef.current,
        row.querySelector('[data-topbar-title]'), row.querySelector('[data-topbar="state"]')].filter((node): node is Element => node !== null))
      for (const node of observed) if (!nodes.has(node)) { observer?.unobserve(node); observed.delete(node) }
      for (const node of nodes) if (!observed.has(node)) { observer?.observe(node); observed.add(node) }
      // Parent snapshots create new React nodes and callbacks even when the bar's
      // contents are unchanged. Only committed markup needs an intrinsic measure;
      // resize and font events still measure independently of this content check.
      const { compact, baseMore } = measurementOptions.current
      const content = `${compact}:${baseMore}:${row.innerHTML}`
      if (content === lastContent) return
      lastContent = content
      measure()
    }
    measureContent.current = syncContent
    syncContent()
    window.addEventListener('resize', measure)
    document.fonts?.addEventListener('loadingdone', measure)
    return () => { measureContent.current = null; observer?.disconnect(); window.removeEventListener('resize', measure); document.fonts?.removeEventListener('loadingdone', measure) }
  }, [])
  return <Bar as="header" data-content-inset="frame" corner={props.corner} className={`${styles.bar} hd-drag`}>
    <div ref={rowRef} data-slot="top-bar" data-fold={folded ? '1' : '0'} className={styles.row} style={{ '--topbar-title-floor': `${titleFloor}px` } as CSSProperties}>
      <div data-topbar="lead" className={`${styles.fixed} ${styles.lead}`}>
        {props.compact ? <><span ref={leadRef} data-topbar-full-lead hidden={folded}>{props.lead}</span><span data-topbar-compact-lead hidden={!folded}>{props.compact.lead}</span></> : props.lead}
      </div>
      <div data-topbar="place" className={styles.place}>
        {props.state && <div data-topbar="state" className={styles.fixed}>{props.state}</div>}
        {props.place != null && <div data-topbar-title className={styles.title} title={props.placeTitle}>
          {props.placeMenu ? <Popover title={props.placeTitle} triggerVariant={{ variant: 'ghost', size: 'sm' }} icons="all"
            label={<span data-topbar-place-menu className={styles.placeMenu}><Text role="subject" truncate>{props.place}</Text><CaretIcon /></span>}>
            {close => <Menu close={close}>{props.placeMenu?.(close)}</Menu>}
          </Popover> : <Text role="subject" truncate>{props.place}</Text>}
        </div>}
      </div>
      <div data-topbar="spacer" className={styles.spacer} />
      <div data-topbar="tools" className={styles.fixed}><span ref={toolsRef} data-topbar-full-tools hidden={folded} className={`${styles.fixed} ${styles.toolDoors}`}>{props.tools}</span>
        <div data-topbar="more" className={styles.fixed}>{hasMore && <Popover title="More" label={<MoreIcon />}
          triggerVariant={{ variant: 'ghost', size: 'icon-sm' }} icons="all">
          {close => <Menu close={close}>{folded && props.compact?.more(close)}{moreRows(props, folded)(close)}</Menu>}
        </Popover>}</div>
      </div>
    </div>
  </Bar>
}

/** A fixed tool's 28px door with the drawing's small activity dot. */
export const TopBarToolButton = ({ attention = false, children, ...props }: ComponentProps<typeof Button> & { attention?: boolean }) =>
  <Button {...props} variant="ghost" size="icon-sm" className={styles.toolButton}>{children}
    {attention && <span data-slot="tool-dot" className={styles.dot} aria-hidden="true" />}
  </Button>
