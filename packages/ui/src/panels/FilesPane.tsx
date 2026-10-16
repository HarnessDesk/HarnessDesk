import { splitSessionKey } from '@harnessdesk/protocol'
import { Explorer, ExplorerFolder } from '../editor'
import { LeftColumnEmpty } from '../design'
import { useSnapshot, useStore } from '../state/context'
import { findPane } from '../state/layout'

/** Files use the same scoped tree as Editor; selecting a file keeps Chat in main. */
export const FilesPane = () => {
  const store = useStore(), snapshot = useSnapshot()
  const subject = store.workSubject()
  const view = findPane(snapshot.layout, snapshot.layout.focused)?.view
  const session = view?.kind === 'conversation' ? view.session : null
  const metadata = session ? snapshot.sessions.get(session) : undefined
  const root = metadata?.cwd ?? (view?.kind === 'room' ? snapshot.goals.get(view.room)?.goal.root : null)
    ?? (view?.kind === 'conversation' && view.session === null ? snapshot.workspace?.path : null)
  const runtime = metadata?.runtime ?? (session ? splitSessionKey(session).runtime : snapshot.activeRuntime)
  if (!subject || !root || !runtime) return <LeftColumnEmpty>This work's folder is not available yet.</LeftColumnEmpty>
  const open = (path: string) => store.showViewIn('right', { kind: 'file', path, runtime })
  return session ? <Explorer session={session} onOpen={open} />
    : <ExplorerFolder key={`${subject}:${runtime}:${root}`} subject={subject} root={root} runtime={runtime} onOpen={open} />
}
