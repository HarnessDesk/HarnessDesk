import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Separator } from '../ui/separator'
import { Bar } from '../ui/bar'
import { Button } from '../ui/button'
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs'
import { Text } from './Settings'
import { Menu, MenuItem } from './Menu'
import { Popover } from './Popover'
import { MoreIcon, CaretIcon, FilterIcon } from '../../components/Icons'
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
  readonly place: ReactNode
  readonly state?: ReactNode
  readonly tabs?: readonly TopBarTab[]
  readonly tab?: string
  readonly inspectFirst?: boolean
  readonly verb?: TopBarAction
  readonly view?: { readonly disabled?: string | false; readonly narrowed?: boolean; readonly content: (close: () => void) => ReactNode }
  readonly tools?: ReactNode
  readonly more: (close: () => void) => ReactNode
  readonly extraMore?: readonly TopBarAction[]
  readonly corner?: boolean
}
export const TopBar = (props: TopBarProps) => {
  const foldedTab = useRef<HTMLButtonElement | null>(null)
  const restoreTabFocus = useRef(false)
  const previousFold = useRef<0 | 1 | 2>(0)
  const root = useRef<HTMLElement | null>(null)
  const place = useRef<HTMLDivElement | null>(null)
  const [fold, setFold] = useState<0 | 1 | 2>(0)
  const measuredFold = useRef<0 | 1 | 2>(0)
  const measureFrame = useRef(0)
  // Reset on inputs that change intrinsic room. ResizeObserver observes the
  // outer row only: observing the title would feed the fold back into itself.
  useLayoutEffect(() => {
    const node = root.current
    if (!node) return
    const measure = () => {
      if (document.activeElement === foldedTab.current) restoreTabFocus.current = true
      cancelAnimationFrame(measureFrame.current)
      measuredFold.current = 0
      setFold(0)
      const pass = () => {
        const width = place.current?.getBoundingClientRect().width ?? 0
        const titleMin = Number.parseFloat(getComputedStyle(node).getPropertyValue('--hd-bar-title-min'))
        if (width >= titleMin || measuredFold.current === 2) return
        if (measuredFold.current === 1) restoreTabFocus.current = root.current?.contains(document.activeElement) === true
          && (document.activeElement as HTMLElement | null)?.getAttribute('role') === 'tab'
        measuredFold.current = (measuredFold.current + 1) as 1 | 2
        setFold(measuredFold.current)
        measureFrame.current = requestAnimationFrame(pass)
      }
      measureFrame.current = requestAnimationFrame(pass)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(node)
    return () => { observer?.disconnect(); cancelAnimationFrame(measureFrame.current) }
  }, [props.place, props.parent?.label, Boolean(props.view), props.state, props.tab, props.tabs, props.verb?.label, props.verb?.icon, props.lead, props.tools])
  useLayoutEffect(() => {
    if (fold === 2 && previousFold.current !== 2 && restoreTabFocus.current) foldedTab.current?.focus()
    if (fold !== 2 && previousFold.current === 2 && restoreTabFocus.current) {
      root.current?.querySelector<HTMLButtonElement>('[role="tab"][data-active]')?.focus()
      restoreTabFocus.current = false
    }
    previousFold.current = fold
  }, [fold])
  const current = props.tabs?.find(one => one.value === props.tab)
  return <Bar as="header" corner={props.corner} rule="bottom" className={`${styles.bar} hd-drag`}>
    <div data-slot="top-bar" data-fold={fold} className={styles.row} ref={node => { root.current = node }}>
      <div data-topbar="lead" className={styles.fixed}>{props.lead}</div>
      <div data-topbar="place" className={styles.place}>
        {props.parent && <Button variant="link" size="inline-link" onClick={props.parent.run}>{props.parent.label} ›</Button>}
        <div ref={place} data-topbar-title className={styles.title}><Text role="subject" truncate>{props.place}</Text></div>
      </div>
      {fold === 0 && <div data-topbar="state" className={styles.fixed}>{props.state}</div>}
      {props.tabs && <div data-topbar="tabs" className={styles.fixed}>{(fold < 2 ? <Tabs value={props.tab ?? null}>
        <TabsList aria-label="Destination views" variant="line" className={styles.tabs}>
          {props.tabs.map(one => <TabsTrigger key={one.value} value={one.value} data-team-page={one.value}
            disabled={Boolean(one.disabled)} title={one.disabled || undefined} onClick={one.run}>{one.label}
            {one.count !== undefined && <Text role="meta" numeric>{one.count}</Text>}</TabsTrigger>)}
        </TabsList>
      </Tabs> : <Popover title="Destination views" triggerRef={foldedTab} label={<>{current?.label ?? 'Views'}{current?.count !== undefined && <Text role="meta" numeric>{current.count}</Text>}<CaretIcon /></>}>
        {close => <Menu close={close}>{props.tabs?.map(one => <MenuItem key={one.value} label={one.label}
          value={one.count} teamPage={one.value} selected={one.value === props.tab} disabled={one.disabled} onSelect={() => { one.run(); close() }} />)}</Menu>}
      </Popover>)}</div>}
      <div data-topbar="spacer" className={styles.spacer} />
      <div data-topbar="verb" className={styles.fixed}>{props.verb && <Button variant="outline" size="sm"
        title={props.verb.disabled || props.verb.label} aria-label={props.verb.label} disabled={Boolean(props.verb.disabled)} onClick={props.verb.run}>
        {props.verb.icon}{(fold === 0 || !props.verb.icon) && props.verb.label}
      </Button>}</div>
      <div data-topbar="view" className={styles.fixed}>{props.view && <Popover title="View" narrowed={props.view.narrowed} reason={props.view.disabled || undefined} disabled={Boolean(props.view.disabled)}
        triggerVariant={{ variant: 'ghost', size: 'icon-sm' }} label={<FilterIcon />}>
        {close => props.view?.content(close)}
      </Popover>}</div>
      <div data-topbar="tools" className={styles.fixed}>{props.tools && <><Separator decorative orientation="vertical" length="bar" data-slot="bar-divider" />{props.tools}</>}</div>
      <div data-topbar="more" className={styles.fixed}><Popover title="More" label={<MoreIcon />}
        triggerVariant={{ variant: 'ghost', size: 'icon-sm' }}>
        {close => <Menu close={close}>{props.more(close)}{props.extraMore?.map(one => <MenuItem
          key={one.label} label={one.label} disabled={one.disabled} onSelect={() => { one.run(); close() }} />)}</Menu>}
      </Popover></div>
    </div>
  </Bar>
}
