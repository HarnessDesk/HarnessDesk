import type { MenuIcons } from '../ui/menu-row'
import { Popover } from './Popover'
import { CaretIcon } from '../../components/Icons'
import { forwardRef, type ComponentProps, type MouseEvent, type ReactNode } from 'react'
import { Bar } from '../ui/bar'
import { Button } from '../ui/button'
import { SidebarMenu, SidebarMenuButton } from '../ui/sidebar'
import { GroupLabel } from '../ui/group-label'
import { DisclosureChevron } from '../ui/disclosure-chevron'
import { Text, Search, Chip, NavigationGroupHeader, Segmented } from './Settings'
import { ArrowLeftIcon, ArrowRightIcon, MoreIcon, CrossIcon, PlusIcon, SettingsIcon, SidebarIcon, CommentIcon, EditorIcon, SearchIcon } from '../../components/Icons'
import { switcherTrack, switcherItem } from '../ui/switcher'
import styles from './LeftColumn.module.css'

export type LeftColumnTrail =
  | { readonly kind: 'count'; readonly value: number; readonly label: string }
  | { readonly kind: 'mark'; readonly icon: ReactNode; readonly label: string; readonly prefix?: ReactNode }
export interface LeftColumnAction {
  readonly label: string
  readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void
  readonly expanded?: boolean
  readonly kind?: 'more' | 'new'
}
export interface LeftColumnMenu {
  readonly icons?: MenuIcons
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
  /** Separate leading-gutter disclosure preserves the icon and label columns. */
  readonly disclosure?: { readonly open: boolean; readonly onToggle: () => void }
  readonly nested?: boolean
  readonly trailing?: LeftColumnTrail
  readonly action?: LeftColumnAction
  readonly onClick?: (event: MouseEvent<HTMLButtonElement>) => void
  readonly onDoubleClick?: (event: MouseEvent<HTMLButtonElement>) => void
  readonly tree?: { readonly depth: number; readonly expanded?: boolean; readonly letter?: 'M' | 'A' | 'D' | 'R' | '!' | null }
  readonly onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void
  readonly buttonProps?: Pick<ComponentProps<'button'>, 'aria-label' | 'aria-describedby' | 'onKeyDown' | 'onDragOver' | 'onDrop'>
}
export const LeftColumnRow = forwardRef<HTMLButtonElement, LeftColumnRowProps>((props, ref) =>
  <div data-left-row data-left-prefix={props.trailing?.kind === 'mark' && props.trailing.prefix ? '' : undefined} data-left-nested={props.nested ? '' : undefined} data-left-tree={props.tree ? '' : undefined} data-letter={props.tree?.letter ?? undefined} data-left-project={props.project ? '' : undefined} data-insert={props.insertion} data-current={props.current ? '' : undefined} data-dragging={props.dragging ? '' : undefined} className={styles.row} onContextMenu={props.onContextMenu}>
    <SidebarMenuButton data-draggable={props.project ? '' : undefined} ref={ref} className={styles.button}
      style={props.tree ? { paddingInlineStart: `calc(var(--hd-space-2) + ${props.tree.depth} * var(--hd-space-4))` } : undefined}
      label={props.tree ? <span className={styles.treeLabel}><span className={styles.treeIcon}>{props.icon}</span><span className={styles.treeName}>{props.label}</span></span> : props.expanded === undefined ? props.label : <><span data-left-fold-name className={styles.foldName}>{props.label}</span><DisclosureChevron open={props.expanded} size="xs" className={styles.disclosure} /></>}
      labelEnd={props.trailing?.kind === 'mark' && props.trailing.prefix ? <Text role="meta" numeric data-left-mark-prefix className={styles.markPrefix}>{props.trailing.prefix}</Text> : undefined}
      icon={props.tree ? props.tree.expanded === undefined ? <span aria-hidden="true" /> : <DisclosureChevron open={props.tree.expanded} size="xs" /> : props.expanded === undefined ? props.icon ?? <span aria-hidden="true" /> : undefined} isActive={props.selected}
      title={props.title ?? props.label} disabled={props.disabled}
      aria-current={props.selected ? 'page' : undefined} aria-expanded={props.disclosure?.open ?? (props.tree ? props.tree.expanded : props.expanded)}
      aria-label={props.label} onClick={props.onClick} onDoubleClick={props.onDoubleClick} {...props.buttonProps} />
    {props.disclosure && <Button variant="ghost" size="pattern" className={styles.gutterDisclosure} data-left-disclosure
      tabIndex={-1} aria-label={`${props.disclosure.open ? 'Hide' : 'Show'} the agents in ${props.label}`}
      onClick={event => {
        event.stopPropagation()
        event.currentTarget.parentElement?.querySelector<HTMLButtonElement>('[data-slot="sidebar-menu-button"]')?.focus({ preventScroll: true })
        props.disclosure?.onToggle()
      }}><DisclosureChevron open={props.disclosure.open} size="xs" /></Button>}
    <span data-left-trailing className={styles.trailing}>
      {props.trailing && <span data-left-mark className={styles.mark} role="img" aria-label={props.trailing.label} title={props.trailing.label}>
        {props.trailing.kind === 'count' ? <Text role="meta" numeric>{props.trailing.value}</Text> : props.trailing.icon}
      </span>}
      {props.menu ? <Popover icons={props.menu.icons} title={props.menu.label} label={<CaretIcon size={16} />} panelWidth="wide" drop="down" align="right"
  triggerClassName={styles.menuAction} onOpenChange={props.menu.onOpenChange}>
  {props.menu.content}
</Popover> : props.action && <Button variant="ghost" size="pattern" className={styles.action}
  data-slot="sidebar-menu-action" aria-label={props.action.label} title={props.action.label}
  aria-haspopup={props.action.kind === 'new' ? undefined : 'menu'} aria-expanded={props.action.kind === 'new' ? undefined : props.action.expanded} tabIndex={props.action.kind === 'new' ? 0 : -1}
  onClick={event => { event.stopPropagation(); props.action?.onClick(event) }}>{props.action.kind === 'new' ? <PlusIcon size={16} /> : <MoreIcon size={16} />}</Button>}
    </span>
  </div>)
LeftColumnRow.displayName = 'LeftColumnRow'
export const LeftColumnGroup = forwardRef<HTMLElement, ComponentProps<'section'> & {
  label: string; children: ReactNode; heading?: boolean; disclosureGutter?: boolean
}>(({ label, children, heading = true, disclosureGutter = false, className, ...props }, ref) =>
  <SidebarMenu as="section" ref={ref} data-left-group className={[styles.group, disclosureGutter ? styles.gutter : null, className].filter(Boolean).join(' ')} aria-label={label} role="group" {...props}>
    {heading && <GroupLabel className={styles.label}><span data-left-group-text>{label}</span></GroupLabel>}{children}
  </SidebarMenu>)
LeftColumnGroup.displayName = 'LeftColumnGroup'
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
  readonly settings: boolean
  readonly back: boolean
  readonly forward: boolean
  readonly toggle: () => void
  readonly goBack: () => void
  readonly goForward: () => void
  readonly search: ReactNode
  readonly modeSwitch?: {
    readonly value: 'conversation' | 'editor'
    readonly onChange: (value: 'conversation' | 'editor') => void
    readonly disabled: boolean
    readonly disabledTitle: string
  }
}
/**
 * The column's top controls share the window's edge row and keep the drag
 * region around every control. The row has no separator hairline beneath it;
 * the column's own spacing marks the transition to its brand row. The mode
 * switch takes the reserved right edge and is absent in Settings. Gapless
 * controls preserve full targets beside the native corner at the default
 * width; when history no longer fits, the main bar carries both arrows.
 * Its compact cells use the shared switcher appearance.
 */
export const LeftColumnTop = (props: LeftColumnTopProps) => <div data-left-top className={styles.top}>
  <Bar inset="rail" corner className="hd-drag">
    <div className={styles.lead}>
      <Button variant="ghost" size="pattern" className={`${styles.topButton} hd-no-drag`}
        aria-label={props.shown ? 'Hide sidebar' : 'Show sidebar'} title={props.shown ? 'Hide the sidebar' : 'Show the sidebar'}
        onClick={props.toggle}><SidebarIcon size={16} /></Button>
      {!props.settings && <div className={`${styles.topActions} hd-no-drag`}>{props.search}</div>}
      {!props.settings && <span data-left-history className={styles.history}>
        <Button variant="ghost" size="pattern" className={`${styles.topButton} hd-no-drag`} disabled={!props.back}
          aria-label="Back" title="Back" onClick={props.goBack}><ArrowLeftIcon size={16} /></Button>
        <Button variant="ghost" size="pattern" className={`${styles.topButton} hd-no-drag`} disabled={!props.forward}
          aria-label="Forward" title="Forward" onClick={props.goForward}><ArrowRightIcon size={16} /></Button>
      </span>}
    </div>
    {!props.settings && props.modeSwitch && <div data-mode-switch data-size="mode" role="group" aria-label="Window mode"
      aria-disabled={props.modeSwitch.disabled}
      className={`${switcherTrack} hd-no-drag`}>
      <Button variant="ghost" size="pattern" data-stretched className={switcherItem}
        aria-label="Conversation mode" aria-pressed={props.modeSwitch.value === 'conversation'} aria-keyshortcuts="Meta+G"
        disabled={props.modeSwitch.disabled} title="Conversation mode (⌘G)"
        onClick={() => props.modeSwitch?.onChange('conversation')}><CommentIcon size={14} /></Button>
      <Button variant="ghost" size="pattern" data-stretched className={switcherItem}
        aria-label="Editor mode" aria-pressed={props.modeSwitch.value === 'editor'} aria-keyshortcuts="Meta+G"
        disabled={props.modeSwitch.disabled} title={props.modeSwitch.disabled ? props.modeSwitch.disabledTitle : 'Editor mode (⌘G)'}
        onClick={() => props.modeSwitch?.onChange('editor')}><EditorIcon size={14} /></Button>
    </div>}
  </Bar>
</div>
/** A quiet account row closes the column beneath a full-width hairline. */
export const LeftColumnSeat = ({ menu, notifications, settingsOpen, onSettings }: {
  menu: ReactNode; notifications?: ReactNode; settingsOpen: boolean; onSettings: () => void
}) => <Bar inset="rail" size="lg" rule="top" paintedRule><div data-left-seat className={styles.seat}>
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
  <nav className={`${styles.navigation} ${styles.inset} ${styles.gutter}`} aria-label="Workspace actions">{children}</nav>
export const LeftColumnProjectsHead = ({ value, onChange, focused, onFocusChange, options, onBrowseFolders }: {
  readonly value: string; readonly onChange: (value: string) => void; readonly focused: boolean
  readonly onFocusChange: (focused: boolean) => void; readonly options: ReactNode; readonly onBrowseFolders: () => void
}) => {
  const filtering = focused || value.length > 0
  return <NavigationGroupHeader data-left-head data-left-projects-head inset="action" filtering={filtering}
    data-filtered={value ? '' : undefined} className={`${styles.head} ${styles.projectsHead} ${styles.gutter}`}
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
    <Button variant="muted" size="icon-xs" edge="end" aria-label="Open a project folder" title="Open a project folder"
      onClick={onBrowseFolders}><PlusIcon size={16} /></Button>
  </NavigationGroupHeader>
}
export const LeftColumnListOptions = ({ filtered, children }: { filtered: boolean; children: ReactNode }) =>
  <span className={styles.options} data-filtered={filtered ? '' : undefined}>{children}</span>
export const LeftColumnEmpty = ({ children }: { children: ReactNode }) =>
  <div className={styles.label}><Text as="div" role="meta" className={styles.empty}>{children}</Text></div>

export const LeftColumnModeHead = ({ hidden, children }: { hidden: boolean; children: ReactNode }) =>
  <div hidden={hidden} inert={hidden} className={hidden ? styles.hidden : undefined}>{children}</div>

/** Explorer occupies the same column; its header and foot share the row inset. */
export const LeftColumnExplorerHead = ({ name, path, filter, changes, onFilter }: {
  readonly name: string; readonly path: string; readonly filter: 'all' | 'changed'
  readonly changes: number | null; readonly onFilter: (filter: 'all' | 'changed') => void
}) => <div data-explorer-head className={styles.explorerHead}>
  <span className={styles.explorerName} title={path}>{name}</span>
  {changes !== null && <Segmented label="Explorer filter" value={filter} onChange={onFilter}
    options={[{ value: 'all', label: 'All' }, { value: 'changed', label: `Changed ${changes}` }]} />}
</div>
export const LeftColumnExplorerFoot = ({ onClick }: { readonly onClick: () => void }) =>
  <div data-explorer-foot className={styles.explorerFoot}><Button variant="muted" size="sm" className={styles.fileSearch}
    aria-label="Go to file" title="Go to file (⌘P)" aria-keyshortcuts="Meta+P" onClick={onClick}>
    <SearchIcon size={16} /><span>Go to file</span><Text role="meta">⌘P</Text>
  </Button></div>

/** Seat rows indent their leading column while retaining the parent's end rail. */
export const LeftColumnSeats = ({ children }: { readonly children: ReactNode }) =>
  <SidebarMenu nested inset="rail" className={styles.seats}>{children}</SidebarMenu>
