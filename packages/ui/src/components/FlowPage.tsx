import { useEffect, useMemo, useState } from 'react'
import type { AuthoringDocument, FlowOrigin } from '@harnessdesk/protocol'
import { ActionError, Note } from '../design'
import { useStore } from '../state/context'
import { FrontDoor } from './FrontDoor'
import { ShapeEditor } from './ShapeEditor'
import { FlowUpdate } from './FlowUpdate'
import { useDestinationActive } from '../panels/destination-page'
import type { FlowPageStart } from '../state/destinations'

export interface FlowPageProps {
  readonly root: string
  readonly id: string | null
  readonly origin?: FlowOrigin
  readonly onBack: () => void
  readonly start?: FlowPageStart
}

/** A catalogue file and an unsaved draft both use the one host-backed editor. */
export const FlowPage = ({ root, id, origin = 'project', onBack, start }: FlowPageProps) => {
  const store = useStore()
  const active = useDestinationActive()
  const [opened, setOpened] = useState(active)
  const context = useMemo(() => start?.context ?? ({ kind: 'project' as const, root }), [root, start?.context])
  const identity = `${root}\0${origin}\0${id ?? ''}\0${JSON.stringify(start ?? null)}`
  const [revision, setRevision] = useState(0)
  const [projectCopy, setProjectCopy] = useState<string | null>(null)
  const readOrigin = projectCopy === identity ? 'project' : origin
  const [updating, setUpdating] = useState(false)
  const [read, setRead] = useState<{ readonly identity: string; readonly revision: number; readonly document: AuthoringDocument } | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [teamDraft, setTeamDraft] = useState<{ readonly identity: string; readonly source: string } | null>(null)
  useEffect(() => {
    if (active) setOpened(true)
    else { setTeamDraft(null); setUpdating(false) }
  }, [active])
  useEffect(() => {
    if (!active || id === null) return
    let live = true
    setProblem(null)
    store.readAuthoring({ kind: 'flow', root, id, origin: readOrigin }).then(
      document => { if (live) setRead({ identity, revision, document }) },
      error => { if (live) setProblem(error instanceof Error ? error.message : 'This Flow could not be read.') },
    )
    return () => { live = false }
  }, [active, store, root, id, readOrigin, identity, revision])
  if (!opened && !active) return null
  if (id !== null && (read?.identity !== identity || read.revision !== revision)) return problem ? <ActionError>{problem}</ActionError> : <Note>Reading Flow…</Note>
  return <>
    <ShapeEditor key={`${identity}:${revision}`} root={root} context={context} goal={start?.goal} presentation="page" document={id === null ? undefined : read?.document} onUpdate={id === null ? undefined : () => setUpdating(true)}
      onClose={onBack} onStarted={execution => store.openGoal(execution.goal)} onStartTeam={source => setTeamDraft({ identity, source })} />
    {active && teamDraft?.identity === identity && <FrontDoor context={context} goal={start?.goal} initial={id === null ? undefined : { id, origin }} initialSource={teamDraft.source} initialTask={start?.task} initialDone={start?.done}
      onClose={() => setTeamDraft(null)} onStarted={execution => { setTeamDraft(null); store.openGoal(execution.goal) }} />}
    {active && updating && id !== null && <FlowUpdate root={root} id={id} mode={readOrigin === 'project' ? 'update' : 'customize'} onClose={() => setUpdating(false)} onApplied={() => { setUpdating(false); setProjectCopy(identity); setRevision(value => value + 1) }} />}
  </>
}
