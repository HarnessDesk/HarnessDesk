import { ContextMenu, LeadAvatar, LeftColumnRow, useContextMenu } from '../design'
import { useStore } from '../state/context'
import { useLeadControls } from './LeadControls'

/** This entry only mounts after the host advertises Lead. The word after the name is its presence; right-click holds the four controls. */
export const LeadSidebarEntry = ({ selected }: { readonly selected: boolean }) => {
  const store = useStore(), controls = useLeadControls(), menu = useContextMenu()
  return <>
    <LeftColumnRow label={controls.label} title="Lead" icon={<LeadAvatar name={controls.name} size="navigation" />} selected={selected}
      trailing={{ kind: 'mark', label: controls.presence.word, prefix: controls.presence.word, icon: null }}
      onContextMenu={menu.open} onClick={() => store.openDestination({ kind: 'lead' })} />
    <ContextMenu at={menu.at} label={`${controls.label} options`} onClose={menu.close} icons="all">{controls.items(menu.close)}</ContextMenu>
    {controls.dialog}
  </>
}
