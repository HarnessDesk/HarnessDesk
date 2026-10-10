import { Button, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '../index'
import { Menu, MenuItem, MenuLabel, MenuNote, MenuSeparator, MiddleTruncate, Popover } from '../index'
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

export const DropdownExample = ({ icons = 'none' }: { icons?: 'all' | 'none' }) => <DropdownMenu icons={icons}>
  <DropdownMenuTrigger render={<Button variant="outline">Frame dropdown</Button>} />
  <DropdownMenuContent>
    <DropdownMenuItem label="Copy branch name" icon={<CopyIcon size={16} />} onClick={() => {}} />
    <DropdownMenuItem label="Delete branch…" icon={<CopyIcon size={16} />} hint="The branch is checked out in another worktree." disabled onClick={() => {}} />
  </DropdownMenuContent>
</DropdownMenu>
