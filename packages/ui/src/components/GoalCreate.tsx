import { FrontDoor } from './FrontDoor'

/** Compatibility door for a plain Team; creation lives in the shared dialog. */
export interface GoalCreateProps {
  readonly root: string
  readonly onClose: () => void
  readonly task?: string
  readonly done?: string
  readonly onTaskChange?: (value: string) => void
  readonly onDoneChange?: (value: string) => void
  /** @deprecated The shared dialog keeps the Flow picker visible. */
  readonly onChangeShape?: () => void
  readonly projectProblem?: string
  readonly onProjectOpened?: () => void
}

export const GoalCreate = ({ root, onClose, task, done, onTaskChange, onDoneChange, projectProblem, onProjectOpened }: GoalCreateProps) => <FrontDoor
  context={{ kind: 'project', root }} initialPlain initialTask={task} initialDone={done}
  onTaskChange={onTaskChange} onDoneChange={onDoneChange} projectProblem={projectProblem} onProjectOpened={onProjectOpened} onClose={onClose} onStarted={onClose}
/>
