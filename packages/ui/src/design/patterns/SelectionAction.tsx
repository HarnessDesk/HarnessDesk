import { Button } from '../ui/button'
import { PopoverSurface } from './Popover'

/** A selection keeps focus while its one action floats above the selected text. */
export const SelectionAction = ({ id, rect, onAsk, onDismiss }: {
  readonly id?: string
  readonly rect: DOMRect
  readonly onAsk: () => void
  readonly onDismiss: () => void
}) => <PopoverSurface id={id} rect={rect} onDismiss={onDismiss}>
  <Button variant="ghost" size="sm" onClick={onAsk}>Ask in chat ⌘L</Button>
</PopoverSurface>
