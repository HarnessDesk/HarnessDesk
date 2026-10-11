import type { AgentCardAction, AgentCardSubject } from './AgentCard'
import { Menu, MenuItem, MenuSeparator, Submenu } from './Menu'
import { Popover } from './Popover'
import { ArrowRightIcon, MoreIcon } from '../../components/Icons'
export const SubjectActionRows = ({ actions = [], choice }: { readonly actions?: readonly AgentCardAction[]; readonly choice?: AgentCardSubject['choice'] }) => <>
  {actions.map(action => <MenuItem key={action.label} icon={<ArrowRightIcon size={16} />} label={action.label} disabled={action.disabled} onSelect={action.onSelect} />)}
  {choice && <><MenuSeparator /><Submenu icon={<ArrowRightIcon size={16} />} label={choice.label}
    value={choice.options.find(option => option.value === choice.value)?.label} icons="none">
    {choice.options.map(option => <MenuItem key={option.value} label={option.label} disabled={option.disabled} selected={choice.value === option.value} keepOpen onSelect={() => choice.onChange(option.value)} />)}
  </Submenu></>}
</>
export const SubjectActionsMenu = ({ label, actions, choice }: { readonly label: string; readonly actions?: readonly AgentCardAction[]; readonly choice?: AgentCardSubject['choice'] }) => !actions?.length && !choice ? null : <Popover title={`${label} actions`} label={<MoreIcon size={16} />} panelWidth="wide" icons="all">
  {close => <Menu close={close}><SubjectActionRows actions={actions} choice={choice} /></Menu>}
</Popover>
