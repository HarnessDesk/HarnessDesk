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
/** Current choices, search and read actions in the first body block. A title
 * uses the page role on the content edge, with the primary choice and verb
 * on the right. Search and secondary choices follow at the page stack gap;
 * long titles and menu choices wrap within the page. */
export const PageOptions = ({ title, choices = [], search, read, action, children }: {
  /** A standalone page names itself in the content column beside its own controls. */
  readonly title?: string
  readonly children?: ReactNode
  readonly choices?: readonly PageOption[]
  readonly search?: { readonly label: string; readonly value: string; readonly change: (value: string) => void }
  readonly read?: ReactNode
  readonly action?: { readonly label: string; readonly icon?: ReactNode; readonly disabled?: boolean | string; readonly run: () => void }
}) => {
  const controls = (items: readonly PageOption[], primary = true, filters = true) => <div data-slot={title ? undefined : 'page-options'} data-page-controls className={styles.options}>
  {primary && action && <Button variant="outline" size="control" aria-label={action.label} disabled={Boolean(action.disabled)} title={typeof action.disabled === 'string' ? action.disabled : undefined} onClick={action.run}>{action.icon}{action.label}</Button>}
  {items.map(choice => {
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
  {filters && search && <Search label={search.label} placeholder={search.label} value={search.value} onChange={search.change} />}
  {filters && read && <Text role="meta">{read}</Text>}
  {primary && children}
</div>
  return title ? <div data-slot="page-options" className={styles.group}>
    <div data-page-head className={styles.head}>
      <Text as="h1" role="page" className={styles.title}>{title}</Text>
      {controls(choices.slice(0, 1), true, false)}
    </div>
    {(choices.length > 1 || search || read) && controls(choices.slice(1), false)}
  </div> : controls(choices)
}
