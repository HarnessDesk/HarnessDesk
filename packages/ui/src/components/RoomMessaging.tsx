import { createContext } from 'react'
import { ComposerChip } from '../design'

/** Room state shown by a tile's own composer, without changing its draft or send. */
export const RoomMessagesHeld = createContext(false)

/** One status chip for the room composer and its single visible tile. */
export const HoldingMessagesChip = () => <ComposerChip title="Agents cannot message each other. Change Board-only in Send to.">Board-only</ComposerChip>
