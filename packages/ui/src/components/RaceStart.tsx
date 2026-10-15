import { useStore } from '../state/context'
import { FrontDoor } from './FrontDoor'

export interface RaceStartProps {
  readonly root: string
  readonly task: string
  readonly onClose: () => void
}

/** The shortcut opens the ordinary New Team form, using the effective project shape. */
export const RaceStart = ({ root, task, onClose }: RaceStartProps) => {
  const store = useStore()
  return <FrontDoor context={{ kind: 'project', root }} initial={{ id: 'comparison' }} initialTask={task}
    onClose={onClose} onStarted={execution => { store.openGoal(execution.goal); onClose() }} />
}
