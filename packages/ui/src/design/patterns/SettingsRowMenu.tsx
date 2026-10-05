import { TrashIcon } from '../../components/Icons'
import { BoardMenuButton } from '../ui/board'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../ui/dropdown-menu'

/** A Settings record's actions: its name and distinguishing location, with destructive removal. */
export const SettingsRowMenu = ({ name, location, label = 'Remove…', onRemove }: {
  readonly name: string
  readonly location?: string
  readonly label?: 'Remove' | 'Remove…'
  readonly onRemove: () => void
}) => (
  <DropdownMenu>
    <DropdownMenuTrigger render={<BoardMenuButton aria-label={`${name} actions${location ? ` · ${location}` : ''}`} />} />
    <DropdownMenuContent align="end">
      <DropdownMenuItem variant="destructive" onClick={onRemove}><TrashIcon size={14} />{label}</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
)
