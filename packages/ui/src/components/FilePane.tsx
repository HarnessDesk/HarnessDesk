import { FileView, type FileViewProps } from '../editor'
import { usePane, useSnapshot } from '../state/context'
import { useMount } from '../panels/mount'

export type FilePaneProps = Pick<FileViewProps, 'view' | 'onViewChange' | 'onPopOut' | 'document' | 'onDocumentChange'>

/** The panel supplies its retained subject; the file surface owns no window actions. */
export const FilePane = (props: FilePaneProps) => {
  const mount = useMount(), pane = usePane(), snapshot = useSnapshot()
  const view = mount?.view
  if (!view || (view.kind !== 'file' && view.kind !== 'preview')) return null
  const owner = snapshot.workbench.toolOwners[mount!.id]
  const held = owner ? snapshot.workbench.frameSubjects[owner]?.view : pane?.view
  const sessionKey = held?.kind === 'conversation' ? held.session : held ? null : pane?.sessionKey
  const session = sessionKey ? snapshot.sessions.get(sessionKey) : null
  const scoped = !!owner || !!sessionKey || held?.kind === 'conversation' || held?.kind === 'room'
  const root = session?.cwd ?? (held?.kind === 'room' ? snapshot.goals.get(held.room)?.goal.root : null) ?? (scoped ? null : snapshot.workspace?.path ?? null)
  const subject = owner ?? (sessionKey ? `session:${sessionKey}` : undefined)
  return <FileView {...props} path={view.path} runtime={view.runtime} root={root} subject={subject} />
}
