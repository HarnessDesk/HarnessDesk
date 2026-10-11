import { useId, useLayoutEffect, useRef, useState, type ReactNode, type CSSProperties, type ComponentProps } from 'react'
import { Bar } from '../ui/bar'
import { Button } from '../ui/button'
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs'
import { Text } from './Settings'
import { Tooltip, TooltipTrigger, TooltipContent } from '../ui/tooltip'
import { Menu, MenuItem, MenuSeparator } from './Menu'
import { Popover } from './Popover'
import { ArrowRightIcon, MoreIcon, CaretIcon, SlidersIcon } from '../../components/Icons'
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
  readonly state?: ReactNode
  readonly tabs?: readonly TopBarTab[]
  readonly tab?: string
  readonly inspectFirst?: boolean
  readonly verb?: TopBarAction
  readonly view?: { readonly disabled?: string | false; readonly narrowed?: boolean; readonly content: (close: () => void) => ReactNode }
  readonly tools?: ReactNode
  /** Standing panel width; closed and floating panels reserve no column. */
  readonly rightColumnWidth?: number | string
  readonly more: (close: () => void) => ReactNode
  /** The surface has a working folder and can open its terminal. */
  readonly terminal?: boolean
  readonly extraMore?: readonly TopBarAction[]
  readonly corner?: boolean
}
type Fold = 0 | 1 | 2 | 3
const DestinationTab = ({ tab }: { tab: TopBarTab }) => {
  const reasonId = useId()
  const trigger = <TabsTrigger value={tab.value} data-team-page={tab.value}
    disabled={Boolean(tab.disabled)} title={tab.disabled || undefined} aria-describedby={tab.disabled ? reasonId : undefined}
    className={tab.disabled ? 'aria-disabled:pointer-events-auto' : undefined}
    count={tab.count} onClick={() => { if (!tab.disabled) tab.run() }}>{tab.label}</TabsTrigger>
  return tab.disabled ? <><Tooltip><TooltipTrigger render={trigger} /><TooltipContent>{tab.label} — {tab.disabled}</TooltipContent></Tooltip>
    <span id={reasonId} className="sr-only">{tab.disabled}</span></> : trigger
}

export const TopBar = (props: TopBarProps) => {
  const foldedTab = useRef<HTMLButtonElement | null>(null)
  const restoreTabFocus = useRef(false)
  const tabFocusOwner = useRef<Element | null>(null)
  const previousFold = useRef<Fold>(0)
  const root = useRef<HTMLElement | null>(null)
  const place = useRef<HTMLDivElement | null>(null)
  const tools = useRef<HTMLDivElement | null>(null)
  const [fold, setFold] = useState<Fold>(0)
  const [settledFold, setSettledFold] = useState<Fold>(0)
  const foldedAnchor = useRef<DOMRect | null>(null)
  const measuredFold = useRef<Fold>(0)
  const [measurement, setMeasurement] = useState(0)
  // Reset on inputs that change intrinsic room. ResizeObserver observes the
  // outer row and externally sized standing tools: observing the title would
  // feed the fold back into itself. A seam drag changes tools without the row.
  useLayoutEffect(() => {
    const node = root.current
    if (!node) return
    const measure = () => {
      const focused = document.activeElement
      const trigger = foldedTab.current
      const popup = document.getElementById(trigger?.getAttribute('aria-controls') ?? '')
      const ownsFocus = trigger !== null && (focused === trigger || popup?.contains(focused) === true)
      restoreTabFocus.current = ownsFocus
      tabFocusOwner.current = ownsFocus ? focused : null
      // A measurement can revisit expanded slots without destroying the open
      // folded menu. Keep its trigger at the actual previous anchor until the
      // new geometry settles; its live menu content/actions keep updating.
      foldedAnchor.current = foldedTab.current?.getBoundingClientRect() ?? null
      measuredFold.current = 0
      setFold(0)
      setMeasurement(value => value + 1)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(node)
    if (props.rightColumnWidth && tools.current) observer?.observe(tools.current)
    return () => { observer?.disconnect() }
  }, [props.place, props.parent?.label, props.parents?.map(one => one.label).join('\0'), props.mark, Boolean(props.view), props.state, props.tab, props.tabs, props.verb?.label, props.verb?.icon, props.lead, props.tools, props.rightColumnWidth])
  useLayoutEffect(() => {
    // Probe every intrinsic stage before paint. RAF-separated renders exposed
    // expanded slots beside the retained menu on live publications. Layout
    // updates finish the same measured folds atomically, retaining menu identity.
    const node = root.current
    if (!node || fold !== measuredFold.current) return
    const title = place.current
    const parent = title?.parentElement
    const siblings = parent ? [...parent.children].filter(child => child !== title) : []
    const gap = Number.parseFloat(getComputedStyle(node).getPropertyValue('--hd-bar-gap')) || 0
    const occupied = siblings.reduce((sum, child) => sum + child.getBoundingClientRect().width, 0) + siblings.length * gap
    const width = title ? Math.min(title.getBoundingClientRect().width,
      (parent?.getBoundingClientRect().width ?? title.getBoundingClientRect().width) - occupied) : 0
    const titleMin = Number.parseFloat(getComputedStyle(node).getPropertyValue('--hd-bar-title-min'))
    if (width >= titleMin || fold === 3 || (fold === 2 && (!props.verb || props.verb.icon))) {
      setSettledFold(fold)
      return
    }
    if (fold === 1 && node.contains(document.activeElement)
      && document.activeElement?.getAttribute('role') === 'tab') {
      restoreTabFocus.current = true
      tabFocusOwner.current = document.activeElement
    }
    measuredFold.current = (fold + 1) as 1 | 2 | 3
    setFold(measuredFold.current)
  }, [fold, measurement])
  useLayoutEffect(() => {
    // Focus may already belong to View, More or another surface while we
    // measured the row. A prior tab's pending restoration has no authority there.
    const owner = tabFocusOwner.current
    const ownsFocus = owner !== null && (document.activeElement === owner
      || (document.activeElement === document.body && !owner.isConnected))
    if (restoreTabFocus.current && ownsFocus) {
      if (settledFold >= 2 && previousFold.current < 2) foldedTab.current?.focus()
      if (settledFold < 2 && previousFold.current >= 2) root.current?.querySelector<HTMLButtonElement>('[role="tab"][data-active]')?.focus()
    }
    restoreTabFocus.current = false
    tabFocusOwner.current = null
    previousFold.current = settledFold
  }, [settledFold])
  const parents = props.parents ?? (props.parent ? [props.parent] : [])
  const shownParents = fold >= 2 ? parents.slice(-1) : parents
  const foldedParents = fold >= 2 ? parents.slice(0, -1) : []
  const current = props.tabs?.find(one => one.value === props.tab)
  return <Bar as="header" data-content-inset="frame" corner={props.corner} className={`${styles.bar} hd-drag`}>
    <div data-slot="top-bar" data-fold={fold} className={styles.row} ref={node => { root.current = node }}>
      <div data-topbar="lead" className={styles.fixed}>{props.lead}</div>
      <div data-topbar="place" className={styles.place}>
        {shownParents.map((one, index) => <Button key={`${index}:${one.label}`} className="hd-no-drag" variant="link" size="inline-link" onClick={one.run}>{one.label} ›</Button>)}
        {props.mark && <span data-topbar-mark className={styles.fixed}>{props.mark}</span>}
        <div ref={place} data-topbar-title className={styles.title}><Text role="subject" truncate>{props.place}</Text></div>
      </div>
      {fold === 0 && <div data-topbar="state" className={styles.fixed}>{props.state}</div>}
      {props.tabs && <div data-topbar="tabs" className={styles.fixed}>{fold < 2 && <Tabs key="expanded" value={props.tab ?? null}>
        <TabsList aria-label="Destination views" className={styles.tabs}>
          {props.tabs.map(one => <DestinationTab key={one.value} tab={one} />)}
        </TabsList>
      </Tabs>}{(fold >= 2 || settledFold >= 2) && <div key="folded" style={fold < 2 && foldedAnchor.current ? {
        position: 'fixed', left: foldedAnchor.current.left, top: foldedAnchor.current.top,
      } : undefined}><Popover title="Destination views" triggerRef={foldedTab} label={<>{current?.label ?? 'Views'}{current?.count !== undefined && <Text role="meta" numeric>{current.count}</Text>}<CaretIcon /></>} icons="none">
        {close => <Menu close={close}>{props.tabs?.map(one => <MenuItem key={one.value} label={one.label}
          value={one.count} teamPage={one.value} selected={one.value === props.tab} disabled={one.disabled} onSelect={() => { one.run(); close() }} />)}</Menu>}
      </Popover></div>}</div>}
      <div data-topbar="spacer" className={styles.spacer} />
      <div data-topbar="verb" className={styles.fixed}>{props.verb && fold < 3 && <Button variant="outline" size="sm"
        title={props.verb.disabled || props.verb.label} aria-label={props.verb.label} disabled={Boolean(props.verb.disabled)} onClick={props.verb.run}>
        {props.verb.icon}{(fold === 0 || !props.verb.icon) && props.verb.label}
      </Button>}</div>
      <div data-topbar="view" className={styles.fixed}>{props.view && <Popover title="View" narrowed={props.view.narrowed} reason={props.view.disabled || undefined} disabled={Boolean(props.view.disabled)}
        triggerVariant={{ variant: 'ghost', size: 'icon-sm' }} label={<SlidersIcon />} icons="none">
        {close => props.view?.content(close)}
      </Popover>}</div>
      <div ref={tools} data-topbar="tools" className={styles.fixed} data-standing={props.rightColumnWidth ? '' : undefined}
        style={props.rightColumnWidth ? { '--topbar-right-column': typeof props.rightColumnWidth === 'number' ? `${props.rightColumnWidth}px` : props.rightColumnWidth } as CSSProperties : undefined}>{props.tools}
      <div data-topbar="more" className={styles.fixed}><Popover title="More" label={<MoreIcon />}
        triggerVariant={{ variant: 'ghost', size: 'icon-sm' }} icons="all">
        {close => <Menu close={close}>{(fold === 3 || settledFold === 3) && props.verb && !props.verb.icon && <>
          <MenuItem icon={<ArrowRightIcon size={16} />} label={props.verb.label} disabled={props.verb.disabled} onSelect={() => { props.verb?.run(); close() }} />
          <MenuSeparator />
        </>}{foldedParents.map((one, index) => <MenuItem key={`${index}:${one.label}`} icon={<ArrowRightIcon size={16} />} label={one.label} onSelect={() => { one.run(); close() }} />)}{props.more(close)}{props.extraMore?.map(one => <MenuItem
          key={one.label} icon={one.icon ?? <ArrowRightIcon size={16} />} label={one.label} disabled={one.disabled} onSelect={() => { one.run(); close() }} />)}</Menu>}
      </Popover></div></div>
    </div>
  </Bar>
}

/** A fixed tool's 28px door with the drawing's small activity dot. */
export const TopBarToolButton = ({ attention = false, children, ...props }: ComponentProps<typeof Button> & { attention?: boolean }) =>
  <Button {...props} variant="ghost" size="icon-sm" className={styles.toolButton}>{children}
    {attention && <span data-slot="tool-dot" className={styles.dot} aria-hidden="true" />}
  </Button>
