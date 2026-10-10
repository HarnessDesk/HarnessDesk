import { Popover } from './Popover'
import { CaretIcon } from '../../components/Icons'
import { forwardRef, type ComponentProps, type MouseEvent, type ReactNode } from 'react'
import { Bar } from '../ui/bar'
import { Button } from '../ui/button'
import { SidebarMenuButton } from '../ui/sidebar'
import { GroupLabel } from '../ui/group-label'
import { Text, Search, Chip, NavigationGroupHeader } from './Settings'
import { ArrowLeftIcon, ArrowRightIcon, MoreIcon, CrossIcon, PlusIcon, SettingsIcon, SidebarIcon } from '../../components/Icons'
import styles from './LeftColumn.module.css'

export type LeftColumnTrail =
  | { readonly kind: 'count'; readonly value: number; readonly label: string }
  | { readonly kind: 'mark'; readonly icon: ReactNode; readonly label: string }
export interface LeftColumnAction {
  readonly label: string
  readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void
  readonly expanded?: boolean
  readonly kind?: 'more' | 'new'
}
export interface LeftColumnMenu {
  readonly label: string
  readonly content: (close: () => void) => ReactNode
  readonly onOpenChange?: (open: boolean) => void
}

export interface LeftColumnRowProps {
  readonly insertion?: 'before' | 'after' | 'into'
  readonly project?: boolean
  readonly current?: boolean
  readonly dragging?: boolean
  readonly menu?: LeftColumnMenu
  readonly label: string
  readonly icon?: ReactNode
  readonly title?: string
  readonly selected?: boolean
  readonly disabled?: boolean
  readonly expanded?: boolean
  readonly trailing?: LeftColumnTrail
  readonly action?: LeftColumnAction
  readonly onClick?: (event: MouseEvent<HTMLButtonElement>) => void
  readonly onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void
  readonly buttonProps?: Pick<ComponentProps<'button'>, 'aria-label' | 'aria-describedby' | 'onKeyDown' | 'onDragOver' | 'onDrop'>
}
export const LeftColumnRow = forwardRef<HTMLButtonElement, LeftColumnRowProps>((props, ref) =>
  <div data-left-row data-left-project={props.project ? '' : undefined} data-insert={props.insertion} data-current={props.current ? '' : undefined} data-dragging={props.dragging ? '' : undefined} className={styles.row} onContextMenu={props.onContextMenu}>
    <SidebarMenuButton data-draggable={props.project ? '' : undefined} ref={ref} className={styles.button} label={props.label}
      icon={props.icon ?? <span aria-hidden="true" />} isActive={props.selected}
      title={props.title ?? props.label} disabled={props.disabled}
      aria-current={props.selected ? 'page' : undefined} aria-expanded={props.expanded}
      aria-label={props.label} onClick={props.onClick} {...props.buttonProps} />
    <span data-left-trailing className={styles.trailing}>
      {props.trailing && <span data-left-mark className={styles.mark} role="img" aria-label={props.trailing.label} title={props.trailing.label}>
        {props.trailing.kind === 'count' ? <Text role="meta" numeric>{props.trailing.value}</Text> : props.trailing.icon}
      </span>}
      {props.menu ? <Popover title={props.menu.label} label={<CaretIcon size={16} />} panelWidth="wide" drop="down" align="right"
  triggerClassName={styles.menuAction} onOpenChange={props.menu.onOpenChange}>
  {props.menu.content}
</Popover> : props.action && <Button variant="ghost" size="pattern" className={styles.action}
  data-slot="sidebar-menu-action" aria-label={props.action.label} title={props.action.label}
  aria-haspopup={props.action.kind === 'new' ? undefined : 'menu'} aria-expanded={props.action.kind === 'new' ? undefined : props.action.expanded} tabIndex={props.action.kind === 'new' ? 0 : -1}
  onClick={event => { event.stopPropagation(); props.action?.onClick(event) }}>{props.action.kind === 'new' ? <PlusIcon size={16} /> : <MoreIcon size={16} />}</Button>}
    </span>
  </div>)
LeftColumnRow.displayName = 'LeftColumnRow'
export const LeftColumnGroup = ({ label, children, heading = true }: { label: string; children: ReactNode; heading?: boolean }) =>
  <section data-left-group className={styles.group} aria-label={label} role="group">
    {heading && <GroupLabel className={styles.label}><span data-left-group-text>{label}</span></GroupLabel>}{children}
  </section>
export const LeftColumnHead = ({ label, controls, search }: {
  label?: string; controls?: ReactNode; search?: ReactNode
}) => <div data-left-head className={search ? styles.head : `${styles.head} ${styles.inset}`}>
  {search ? <div className={styles.headSearch}>{search}</div> : <>
    <GroupLabel className={styles.headLabel}><span data-left-group-text>{label}</span></GroupLabel>
    <div className={styles.headControls}>{controls}</div>
  </>}
</div>
export const LeftColumnBody = forwardRef<HTMLDivElement, {
  children: ReactNode; onScroll?: ComponentProps<'div'>['onScroll']; hidden?: boolean
}>(({ children, onScroll, hidden }, ref) => <div ref={ref} hidden={hidden} inert={hidden}
  data-region="sidebar-content" className={hidden ? styles.hidden : `${styles.body} ${styles.inset}`} onScroll={onScroll}>{children}</div>)
LeftColumnBody.displayName = 'LeftColumnBody'
export interface LeftColumnTopProps {
  readonly shown: boolean
  readonly back: boolean
  readonly forward: boolean
  readonly toggle: () => void
  readonly goBack: () => void
  readonly goForward: () => void
  readonly search: ReactNode
}
export const LeftColumnTop = (props: LeftColumnTopProps) => <div data-left-top className={styles.top}>
  <Bar corner rule="bottom" className="hd-drag">
    <div className={styles.lead}>
      <Button variant="ghost" size="pattern" className={`${styles.topButton} hd-no-drag`}
        aria-label={props.shown ? 'Hide sidebar' : 'Show sidebar'} title={props.shown ? 'Hide the sidebar' : 'Show the sidebar'}
        onClick={props.toggle}><SidebarIcon size={16} /></Button>
      <div className={`${styles.topActions} hd-no-drag`}>{props.search}</div>
      <span data-left-history className={styles.history}>
        <Button variant="ghost" size="pattern" className={`${styles.topButton} hd-no-drag`} disabled={!props.back}
          aria-label="Back" title="Back" onClick={props.goBack}><ArrowLeftIcon size={16} /></Button>
        <Button variant="ghost" size="pattern" className={`${styles.topButton} hd-no-drag`} disabled={!props.forward}
          aria-label="Forward" title="Forward" onClick={props.goForward}><ArrowRightIcon size={16} /></Button>
      </span>
    </div>
  </Bar>
</div>
export const LeftColumnSeat = ({ menu, notifications, settingsOpen, onSettings }: {
  menu: ReactNode; notifications?: ReactNode; settingsOpen: boolean; onSettings: () => void
}) => <Bar rule="top"><div data-left-seat className={styles.seat}>
  <div className={styles.seatMenu}>{menu}</div>
  <div className={`${styles.topActions} hd-no-drag`}>{notifications}</div>
  <Button variant="ghost" size="pattern" className={styles.topButton} aria-label="Settings" title="Settings"
    aria-pressed={settingsOpen} onClick={onSettings}><SettingsIcon size={16} /></Button>
</div></Bar>
export const LeftColumn = ({ top, head, body, footer, active = true }: {
  top: ReactNode; head: ReactNode; body: ReactNode; footer: ReactNode; active?: boolean
}) => <div data-left-column hidden={!active} inert={!active} className={active ? styles.column : styles.hidden}>
  <div data-region="sidebar-header">{top}{head}</div>{body}
  <div data-region="sidebar-footer" className={styles.footer}>{footer}</div>
</div>

export const LeftColumnList = forwardRef<HTMLDivElement, {
  readonly children: ReactNode
  readonly before?: number
  readonly after?: number
  readonly labels?: string
  readonly footer?: ReactNode
}>(({ children, before = 0, after = 0, labels, footer }, ref) => <div ref={ref} data-virtual-project="true"
  data-virtual-labels={labels} className={styles.list}>
  {before > 0 && <div aria-hidden="true" style={{ height: before }} />}
  {children}
  {after > 0 && <div aria-hidden="true" style={{ height: after }} />}
  {footer}
</div>)
LeftColumnList.displayName = 'LeftColumnList'
export const LeftColumnRename = ({ input }: { readonly input: ReactNode }) =>
  <div data-left-rename className={styles.row}>{input}</div>
export const LeftColumnNavigation = ({ children }: { readonly children: ReactNode }) =>
  <nav className={`${styles.navigation} ${styles.inset}`} aria-label="Workspace actions">{children}</nav>
export const LeftColumnProjectsHead = ({ value, onChange, focused, onFocusChange, options, onBrowseFolders }: {
  readonly value: string; readonly onChange: (value: string) => void; readonly focused: boolean
  readonly onFocusChange: (focused: boolean) => void; readonly options: ReactNode; readonly onBrowseFolders: () => void
}) => {
  const filtering = focused || value.length > 0
  return <NavigationGroupHeader data-left-head data-left-projects-head inset="row" filtering={filtering}
    data-filtered={value ? '' : undefined} className={`${styles.head} ${styles.projectsHead} ${styles.inset}`}
    label={<span className={styles.projectsLabel} data-left-group-text>Projects</span>}>
    {value && <span className={styles.filtered}><Chip tone="neutral" label="Filtered" />
      <Button variant="ghost" size="icon-xs" aria-label="Clear list filter" title="Clear list filter"
        onClick={() => onChange('')}><CrossIcon size={16} /></Button></span>}
    <div className={styles.projectFilter}>
      <Search size="compact" icon="filter" placeholder="Filter by title" label="Filter this list" title="Filter this list"
        value={value} onChange={onChange} onFocus={() => onFocusChange(true)} onBlur={() => onFocusChange(false)}
        onKeyDown={event => { if (event.key === 'Escape') {
          if (value) event.preventDefault()
          onChange(''); event.currentTarget.blur()
        } }} />
    </div>
    {options}
    <Button variant="muted" size="icon-xs" edge="end" edgeGlyph={16} aria-label="Open a project folder" title="Open a project folder"
      onClick={onBrowseFolders}><PlusIcon size={16} /></Button>
  </NavigationGroupHeader>
}
export const LeftColumnListOptions = ({ filtered, children }: { filtered: boolean; children: ReactNode }) =>
  <span className={styles.options} data-filtered={filtered ? '' : undefined}>{children}</span>
export const LeftColumnEmpty = ({ children }: { children: ReactNode }) =>
  <div className={styles.label}><Text as="div" role="meta" className={styles.empty}>{children}</Text></div>

export const LeftColumnModeHead = ({ hidden, children }: { hidden: boolean; children: ReactNode }) =>
  <div hidden={hidden} inert={hidden} className={hidden ? styles.hidden : undefined}>{children}</div>
