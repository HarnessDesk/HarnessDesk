import type { AgentCardAction, AgentCardSubject } from './AgentCard'
import { Menu, MenuItem, MenuLabel, MenuSeparator } from './Menu'
import { Popover } from './Popover'
import { MoreIcon } from '../../components/Icons'
export const SubjectActionRows = ({ actions = [], choice }: { readonly actions?: readonly AgentCardAction[]; readonly choice?: AgentCardSubject['choice'] }) => <>
  {actions.map(action => <MenuItem key={action.label} label={action.label} disabled={action.disabled} onSelect={action.onSelect} />)}
  {choice && <><MenuSeparator /><MenuLabel>{choice.label}</MenuLabel>{choice.options.map(option => <MenuItem key={option.value} label={option.label} disabled={option.disabled} selected={choice.value === option.value} keepOpen onSelect={() => choice.onChange(option.value)} />)}</>}
</>
export const SubjectActionsMenu = ({ label, actions, choice }: { readonly label: string; readonly actions?: readonly AgentCardAction[]; readonly choice?: AgentCardSubject['choice'] }) => !actions?.length && !choice ? null : <Popover title={`${label} actions`} label={<MoreIcon size={16} />} panelWidth="wide" icons="none">
  {close => <Menu close={close}><SubjectActionRows actions={actions} choice={choice} /></Menu>}
</Popover>
