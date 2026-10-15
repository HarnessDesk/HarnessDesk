import type { ReactNode } from 'react'
import { Button } from '../ui/button'
import { NativeSelect } from '../ui/native-select'
import { Menu, MenuItem } from './Menu'
import { Popover } from './Popover'
import { Search, Text } from './Settings'
import { CaretIcon } from '../../components/Icons'
import styles from './PageOptions.module.css'
/** Current page choices, search and read actions in the first body block, wrapping within the page. */
export interface PageOption {
  readonly id: string; readonly label: string; readonly value: string
  readonly items: readonly { readonly value: string; readonly label: string; readonly count?: number; readonly disabled?: string | false; readonly title?: string }[]
  readonly change: (value: string) => void
  readonly mode?: 'select' | 'menu'
  /** Keep the selected section's size visible beside its label. */
  readonly showCount?: boolean
}
/** Current choices, search and read actions in the first body block; long menu choices wrap within the page. */
export const PageOptions = ({ choices = [], search, read, action }: {
  readonly choices?: readonly PageOption[]
  readonly search?: { readonly label: string; readonly value: string; readonly change: (value: string) => void }
  readonly read?: ReactNode
  readonly action?: { readonly label: string; readonly icon?: ReactNode; readonly disabled?: boolean | string; readonly run: () => void }
}) => <div data-slot="page-options" className={styles.options}>
  {action && <Button variant="outline" size="sm" aria-label={action.label} disabled={Boolean(action.disabled)} title={typeof action.disabled === 'string' ? action.disabled : undefined} onClick={action.run}>{action.icon}{action.label}</Button>}
  {choices.map(choice => {
    const current = choice.items.find(item => item.value === choice.value)
    return choice.mode === 'menu'
    ? <Popover key={choice.id} title={choice.label} icons="none" label={<><span className={styles.current}>{current?.label ?? choice.value}</span>{choice.showCount && current?.count !== undefined && <Text role="meta">{current.count}</Text>}<CaretIcon /></>}
        triggerVariant={{ variant: 'outline', size: 'wrap' }}>{close => <Menu close={close}>
        {choice.items.map(item => <MenuItem key={item.value} label={item.label} value={item.count}
          title={item.title} selected={item.value === choice.value} disabled={item.disabled}
          onSelect={() => { choice.change(item.value); close() }} />)}
      </Menu>}</Popover>
    : <NativeSelect key={choice.id} aria-label={choice.label} value={choice.value}
        onChange={event => choice.change(event.target.value)}>
        {choice.items.map(item => <option key={item.value} value={item.value} disabled={Boolean(item.disabled)}>
          {item.label}{item.count === undefined ? '' : ` · ${item.count}`}
        </option>)}
      </NativeSelect>
  })}
  {search && <Search label={search.label} placeholder={search.label} value={search.value} onChange={search.change} />}
  {read && <Text role="meta">{read}</Text>}
</div>
