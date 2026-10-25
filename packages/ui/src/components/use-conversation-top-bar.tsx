import type { TopBarProps } from '../design'
import { useTopBar } from '../panels/top-bar'
import { WindowControls } from './WindowControls'

export const useConversationTopBar = (owner: string, slots: TopBarProps, enabled = true) => useTopBar(owner, { lead: <WindowControls />, ...slots }, enabled)
