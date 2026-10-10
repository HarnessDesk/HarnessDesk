import { useEffect, useRef, type KeyboardEventHandler, type ReactNode } from 'react'
import { Menu, MenuItem, MenuLabel, MenuSeparator } from './Menu'
import { Search } from './Settings'
import { UsageMeterRow } from './UsageMeterRow'
import type { Tone } from '../ui/tone'
export interface MenuMeterData {
  readonly id: string
  readonly name: string
  readonly label?: string
  readonly percent: number | null
  readonly countdown: string
  readonly countdownTitle?: string
  readonly tone?: Tone
  readonly note?: string
  readonly barless?: boolean
}
export interface WideMenuItem {
  readonly id: string
  readonly label: ReactNode
  readonly icon?: ReactNode
  readonly hint?: ReactNode
  readonly badge?: ReactNode
  readonly title?: string
  readonly selected?: boolean
  readonly trailing?: ReactNode
  readonly disabled?: boolean | string
  readonly danger?: boolean
  readonly keepOpen?: boolean
  readonly meter?: MenuMeterData
  readonly onSelect: () => void
}
export interface MenuSearchProps {
  readonly label: string
  readonly value: string
  readonly onChange: (next: string) => void
  readonly autoFocus?: boolean
  readonly onKeyDown?: KeyboardEventHandler<HTMLInputElement>
}
export const MenuSearch = ({ label, value, onChange, autoFocus = false, onKeyDown }: MenuSearchProps) => {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!autoFocus) return
    // Menu registers and focuses its rows after the input mounts.
    const frame = requestAnimationFrame(() => host.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [autoFocus])
  return <div ref={host} data-menu-search="">
  <Search size="compact" label={label} placeholder={label} value={value} onChange={onChange} autoFocus={autoFocus} onKeyDown={event => {
    if (event.key.length === 1 || ['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) event.stopPropagation()
    onKeyDown?.(event)
  }} />
</div>
}
const reading = (data: MenuMeterData) => <UsageMeterRow popup label={data.label} barless={data.barless} name={data.name} percent={data.percent} countdown={data.countdown} countdownTitle={data.countdownTitle} tone={data.tone} note={data.note} standalone />
export const MenuFacts = ({ rows, usageDetails = false }: { readonly rows: readonly MenuMeterData[]; readonly usageDetails?: boolean }) => <div data-menu-facts="" data-usage-details={usageDetails ? '' : undefined}>{rows.map(row => <div key={row.id} data-menu-fact="">{reading(row)}</div>)}</div>
export const WideMenuRows = ({ items, facts = [] }: { readonly items: readonly WideMenuItem[]; readonly facts?: readonly MenuMeterData[] }) => <>
  {items.map(({ id, meter, ...item }) => <MenuItem key={id} {...item} meter={meter ? reading(meter) : undefined} />)}
  {facts.length > 0 && <MenuFacts rows={facts} />}
</>
export const WideMenu = ({ close, title, search, items, facts, footer }: {
  readonly close: () => void
  readonly title?: string
  readonly search?: MenuSearchProps
  readonly items: readonly WideMenuItem[]
  readonly facts?: readonly MenuMeterData[]
  readonly footer?: ReactNode
}) => <Menu close={close}>
  {search && <MenuSearch {...search} />}
  {title && <MenuLabel>{title}</MenuLabel>}
  <WideMenuRows items={items} facts={facts} />
  {footer != null && <><MenuSeparator /><div data-menu-footer="">{footer}</div></>}
</Menu>
