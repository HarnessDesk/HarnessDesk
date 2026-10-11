import type { ReactNode } from 'react'
import { ListRow } from '../ui/list-row'
import { ListRows } from '../ui/list-row'
import { Chip, Text } from './Settings'
import { Menu, MenuItem, MenuToggle, MenuSeparator } from './Menu'
import { Popover } from './Popover'
import { CheckAllIcon, ClockIcon, CommentIcon, MoreIcon, MessageOffIcon, SessionIcon, SideBySideIcon, TrashIcon } from '../../components/Icons'
export interface SeatListRow {
  readonly id: string
  readonly selected?: boolean
  readonly name: string
  readonly mark?: ReactNode
  readonly detail: string
  readonly state: string
  readonly open: () => void
  readonly watch: () => void
  readonly message: () => void
  readonly inbound: 'accept' | 'hold' | 'refuse'
  readonly setInbound: (mode: 'accept' | 'hold' | 'refuse') => void
  readonly remove: () => void
  readonly refusal?: string
  readonly watchRefusal?: string
  readonly messageRefusal?: string
  readonly removeRefusal?: string
  readonly mutationRefusal?: string
}
export const SeatList = ({ rows }: { rows: readonly SeatListRow[] }) => <ListRows>{rows.map(one => <ListRow
  key={one.id} selected={one.selected} interactive={!one.refusal} onClick={event => {
    if (!one.refusal && !(event.target as Element).closest('button')) one.open()
  }} title={<span title={one.refusal}>{one.name}</span>} wrapSubtitle subtitle={<Text role="meta">{one.detail}{one.refusal ? ` · ${one.refusal}` : ''}</Text>} lead={one.mark}
  trail={<><Chip tone="neutral">{one.state}</Chip><Popover title={`Actions for ${one.name}`} label={<MoreIcon />} icons="all">
    {close => <Menu close={close}>
      <MenuItem icon={<SessionIcon size={16} />} label="Open conversation" disabled={one.refusal} onSelect={() => { one.open(); close() }} />
      <MenuItem icon={<SideBySideIcon size={16} />} label="Watch beside" disabled={one.refusal ?? one.watchRefusal} onSelect={() => { one.watch(); close() }} />
      <MenuItem icon={<CommentIcon size={16} />} label="Message" disabled={one.refusal ?? one.messageRefusal} onSelect={() => { one.message(); close() }} />
      <MenuSeparator />
      {(['accept', 'hold', 'refuse'] as const).map(mode => <MenuToggle key={mode}
        icon={mode === 'accept' ? <CheckAllIcon size={16} /> : mode === 'hold' ? <ClockIcon size={16} /> : <MessageOffIcon size={16} />}
        label={{ accept: 'Accept messages', hold: 'Hold messages', refuse: 'Refuse messages' }[mode]}
        checked={one.inbound === mode} disabled={one.refusal ?? one.mutationRefusal} onChange={() => { one.setInbound(mode); close() }} />)}
      <MenuSeparator /><MenuItem icon={<TrashIcon size={16} />} label="Remove from Team" danger disabled={one.refusal ?? one.removeRefusal ?? one.mutationRefusal} onSelect={() => { one.remove(); close() }} />
    </Menu>}
  </Popover></>} />)}</ListRows>
