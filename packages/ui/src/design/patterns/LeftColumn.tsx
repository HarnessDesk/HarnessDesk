import { Popover } from './Popover'
import { CaretIcon } from '../../components/Icons'
import { forwardRef, type ComponentProps, type MouseEvent, type ReactNode } from 'react'
import { Bar } from '../ui/bar'
import { Button } from '../ui/button'
import { SidebarMenuButton } from '../ui/sidebar'
import { GroupLabel } from '../ui/group-label'
import { Text } from './Settings'
import { ArrowLeftIcon, ArrowRightIcon, MoreIcon, PlusIcon, SettingsIcon, SidebarIcon } from '../../components/Icons'
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
  <div data-left-row className={styles.row} onContextMenu={props.onContextMenu}>
    <SidebarMenuButton ref={ref} className={styles.button} label={props.label}
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
export const LeftColumnHead = ({ label, controls }: { label: string; controls: ReactNode }) =>
  <div data-left-head className={styles.head}><GroupLabel className={styles.headLabel}><span data-left-group-text>{label}</span></GroupLabel>
    <div className={styles.headControls}>{controls}</div></div>
export const LeftColumnBody = forwardRef<HTMLDivElement, {
  children: ReactNode; onScroll?: ComponentProps<'div'>['onScroll']; hidden?: boolean
}>(({ children, onScroll, hidden }, ref) => <div ref={ref} hidden={hidden} inert={hidden}
  data-region="sidebar-content" className={hidden ? styles.hidden : styles.body} onScroll={onScroll}>{children}</div>)
LeftColumnBody.displayName = 'LeftColumnBody'
export interface LeftColumnTopProps {
  readonly shown: boolean
  readonly back: boolean
  readonly forward: boolean
  readonly toggle: () => void
  readonly goBack: () => void
  readonly goForward: () => void
  readonly notifications: ReactNode
  readonly search: ReactNode
}
export const LeftColumnTop = (props: LeftColumnTopProps) => <div data-left-top className={styles.top}>
  <Bar corner rule="bottom" className="hd-drag">
    <div className={styles.lead}>
      <Button variant="ghost" size="pattern" className={`${styles.topButton} hd-no-drag`}
        aria-label={props.shown ? 'Hide sidebar' : 'Show sidebar'} title={props.shown ? 'Hide the sidebar' : 'Show the sidebar'}
        onClick={props.toggle}><SidebarIcon size={16} /></Button>
      <span data-left-history className={styles.history}>
        <Button variant="ghost" size="pattern" className={`${styles.topButton} hd-no-drag`} disabled={!props.back}
          aria-label="Back" title="Back" onClick={props.goBack}><ArrowLeftIcon size={16} /></Button>
        <Button variant="ghost" size="pattern" className={`${styles.topButton} hd-no-drag`} disabled={!props.forward}
          aria-label="Forward" title="Forward" onClick={props.goForward}><ArrowRightIcon size={16} /></Button>
      </span>
    </div>
    <div className={`${styles.topActions} hd-no-drag`}>{props.notifications}{props.search}</div>
  </Bar>
</div>
export const LeftColumnSeat = ({ menu, settingsOpen, onSettings }: {
  menu: ReactNode; settingsOpen: boolean; onSettings: () => void
}) => <Bar rule="top"><div data-left-seat className={styles.seat}>
  <div className={styles.seatMenu}>{menu}</div>
  <Button variant="ghost" size="pattern" className={styles.topButton} aria-label="Settings" title="Settings"
    aria-pressed={settingsOpen} onClick={onSettings}><SettingsIcon size={16} /></Button>
</div></Bar>
export const LeftColumn = ({ top, head, body, footer }: {
  top: ReactNode; head: ReactNode; body: ReactNode; footer: ReactNode
}) => <div data-left-column className={styles.column}>
  <div data-region="sidebar-header">{top}{head}</div>{body}
  <div data-region="sidebar-footer" className={styles.footer}>{footer}</div>
</div>
