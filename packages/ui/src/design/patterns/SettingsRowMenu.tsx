import { TrashIcon } from '../../components/Icons'
import { BoardMenuButton } from '../ui/board'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu'

/**
 * A Settings record's actions: its name and distinguishing location, its
 * place in an order when the list is one (an agent's accounts, used first to
 * last), and destructive removal. A move that cannot happen — the first row
 * moving up — is drawn and refused rather than missing, so the menu keeps its
 * shape from row to row.
 */
export const SettingsRowMenu = ({ name, location, label = 'Remove…', onRemove, moves }: {
  readonly name: string
  readonly location?: string
  readonly label?: 'Remove' | 'Remove…'
  readonly onRemove?: () => void
  readonly moves?: { readonly up?: () => void; readonly down?: () => void }
}) => (
  <DropdownMenu icons="none">
    <DropdownMenuTrigger render={<BoardMenuButton aria-label={`${name} actions${location ? ` · ${location}` : ''}`} />} />
    <DropdownMenuContent align="end">
      {moves && (
        <>
          <DropdownMenuItem disabled={!moves.up} onClick={moves.up} label="Move up" />
          <DropdownMenuItem disabled={!moves.down} onClick={moves.down} label="Move down" />
        </>
      )}
      {moves && onRemove && <DropdownMenuSeparator />}
      {onRemove && <DropdownMenuItem variant="destructive" onClick={onRemove} label={label} icon={<TrashIcon size={14} />} />}
    </DropdownMenuContent>
  </DropdownMenu>
)
