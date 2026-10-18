import { LeadAvatar, LeftColumnRow } from '../design'
import { useStore } from '../state/context'
import { useLeadName } from './use-lead-name'

/** This entry only mounts after the host advertises Lead. */
export const LeadSidebarEntry = ({ selected }: { readonly selected: boolean }) => {
  const name = useLeadName(), store = useStore()
  return <LeftColumnRow label={name === 'lex' ? 'Lex' : 'Dex'} title="Lead" icon={<LeadAvatar name={name} size="navigation" />} selected={selected} onClick={() => store.openDestination({ kind: 'lead' })} />
}
