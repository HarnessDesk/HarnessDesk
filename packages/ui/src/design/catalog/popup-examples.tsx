import { Button, InfoCard, Menu, MenuItem, MenuLabel, MenuNote, MenuSeparator, MiddleTruncate, Popover } from '../index'
import { CopyIcon, FolderOpenIcon, UndoIcon } from '../../components/Icons'
export const MenuExample = ({ icons = 'all' }: { icons?: 'all' | 'none' }) => <Popover title="Frame menu" label="Frame menu" icons={icons}>
  {close => <Menu close={close}>
    <MenuLabel>Storefront workspace</MenuLabel>
    <MenuItem icon={<FolderOpenIcon size={16} />} label="Open workspace" onSelect={close} />
    <MenuItem icon={<CopyIcon size={16} />} label="Copy folder path" hint={<MiddleTruncate>/workspace/storefront/packages/catalogue</MiddleTruncate>} onSelect={close} />
    <MenuSeparator />
    <MenuItem icon={<UndoIcon size={16} />} label="Undo the last turn" hint="Files are left as they are." onSelect={close} />
    <MenuItem icon={<CopyIcon size={16} />} label="Keep the checkout" hint={<>Files stay in this folder.<br />History stays in this conversation.</>} onSelect={close} />
    <MenuNote>Workspace actions</MenuNote>
  </Menu>}
</Popover>

import { useState } from 'react'
import { WideMenu } from '../index'
export const WideMenuExample = () => {
  const [query, setQuery] = useState('')
  const names = ['Storefront catalogue search, pagination and checkout diagnostics with complete retry policy', '发布前检查与故障重试说明', 'Inventory repair for the warehouse catalogue']
  return <Popover label="Frame wide menu" title="Frame wide menu" panelWidth="wide" icons="none">{close => <WideMenu close={close} title="Choose a workspace Agent" search={{ label: 'Search Agents', value: query, onChange: setQuery }} items={names.filter(name => name.toLowerCase().includes(query.toLowerCase())).map((name, at) => ({ id: String(at), label: name, hint: at === 1 ? 'Keeps the existing checkout and reports what could not be verified.' : undefined, onSelect: close }))} footer="Three Agents available in this workspace. Long names keep their meaning." />}</Popover>
}

export const MeteredMenuExample = () => <Popover label="Frame metered menu" title="Frame metered menu" panelWidth="wide" icons="none">{close => <WideMenu close={close} title="Other agents" items={[
  { id: 'scout', label: 'Scout — storefront catalogue and checkout diagnostics', meter: { id: 'weekly', name: 'Weekly', percent: 78, countdown: '6h' }, onSelect: close },
  { id: 'reviewer', label: '发布前检查', meter: { id: 'missing', name: 'Weekly', percent: null, countdown: '', note: 'No usage reported' }, onSelect: close },
]} footer="Last read 2 minutes ago" />}</Popover>

export const InfoCardExample = () => <InfoCard trigger={<Button variant="outline">Storefront catalogue review</Button>} title="Storefront catalogue review" rows={[
  { id: 'agent', label: 'Agent', value: '发布前检查' },
  { id: 'branch', label: 'Branch', value: 'feature/storefront-checkout-diagnostics-and-retry-policy', kind: 'path' },
  { id: 'state', label: 'State', value: 'Working', note: '41 seconds into this turn' },
  { id: 'context', label: 'Context', value: '740K left of 1M' },
]} notes={['The next message uses the same checkout.']} />
