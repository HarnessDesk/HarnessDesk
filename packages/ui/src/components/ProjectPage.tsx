import { useEffect, useState } from 'react'

import type { AgentEntry, GoalId, GoalView } from '@harnessdesk/protocol'

import { agentName, ceilingWords, projectName } from '../lib/agents'
import { shortPath } from '../lib/paths'
import { useShell } from '../panels/views'
import { useSnapshot, useStore } from '../state/context'
import { FolderIcon } from './Icons'
import { MemoryCitation } from './MemoryCitation'
import { ProjectChecks } from './ProjectChecks'
import { ProjectFlows } from './ProjectFlows'
import { ProjectProvenance } from './ProjectProvenance'
import {
  BackLink,
  Button,
  Chip,
  DetailHead,
  DetailMark,
  NativeSelect,
  Note,
  Row,
  RowButton,
  RowValue,
  Rows,
  SectionHead,
} from '../design'

/**
 * Workspaces › a project: what belongs to one project rather than to this
 * Mac or to the app.
 *
 * It starts with the project's own Agents — the ones in its checkout,
 * committed with its code, which come first in this project over yours and
 * the ones that ship — and is where the project's checks, flows, triggers and
 * provenance will live as they arrive. It is read for the project it is
 * about, open or not; only the open project's Agents are ways into their
 * pages, because the Agents window holds the open project's roster.
 */
export const ProjectPage = ({ root, onBack }: { readonly root: string; readonly onBack: () => void }) => {
  const store = useStore()
  const shell = useShell()
  const snapshot = useSnapshot()
  const [agents, setAgents] = useState<readonly AgentEntry[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  // Explicit page use, never a startup read: nothing here is fetched until a
  // person presses "Project memory" — the plain path (a project nobody has
  // ever cited into) never pays for a host round trip it never asked for.
  const [memoryOpen, setMemoryOpen] = useState(false)
  const [openGoals, setOpenGoals] = useState<readonly GoalView[] | null>(null)
  const [citeInto, setCiteInto] = useState('')
  const listed = snapshot.workspaces.find((one) => one.path === root) ?? null
  const current = snapshot.workspace?.path === root
  const name = listed ? (projectName(listed) ?? listed.name) : (root.split('/').filter(Boolean).at(-1) ?? root)

  useEffect(() => {
    let live = true
    setProblem(null)
    store.agentsIn(root).then(
      (list) => {
        if (live) setAgents(list.filter((one) => one.origin === 'project'))
      },
      (error: unknown) => {
        if (live) setProblem(error instanceof Error ? error.message : 'Its Agents could not be read.')
      },
    )
    return () => {
      live = false
    }
    // The roster moving under any of its roots (`agent/changed`) is a reason to read again.
  }, [store, root, snapshot.agents])

  useEffect(() => {
    if (!memoryOpen) return
    let live = true
    store.transport.request('goal/list', { root }).then(
      (views: readonly GoalView[]) => { if (live) setOpenGoals(views.filter((one) => one.goal.state === 'open')) },
      () => { if (live) setOpenGoals([]) },
    )
    return () => { live = false }
  }, [store, root, memoryOpen])

  // Where the host reads them: the top of the checkout, which the first one found names exactly.
  const folder = agents?.[0]
    ? agents[0].path.split('/').slice(0, -2).join('/')
    : `${listed?.repo && !listed.repo.worktree ? listed.repo.root : root}/.harnessdesk/agents`

  return (
    <>
      <BackLink to="Workspaces" onClick={onBack} />
      <DetailHead
        mark={
          <DetailMark>
            <FolderIcon size={22} />
          </DetailMark>
        }
        name={
          <>
            <span className="shrink-0">{name}</span>
            <span className="min-w-0 truncate text-(length:--hd-text-sm) font-normal text-(--hd-muted-foreground)">
              {shortPath(root, snapshot.home)}
            </span>
          </>
        }
        actions={
          current ? (
            <Chip state="ready" label="Current" />
          ) : (
            <>
              <Button variant="outline" onClick={() => void store.openWorkspace(root)}>
                Open
              </Button>
              {listed && (
                <Button
                  variant="ghost"
                  title="Drop it from the list. The folder is untouched."
                  onClick={() => {
                    void store.forgetWorkspace(root)
                    onBack()
                  }}
                >
                  Forget
                </Button>
              )}
            </>
          )
        }
      />

      <section aria-label="Agents">
        <SectionHead name="Agents" />
        <Note>
          {`Its own, read from ${shortPath(folder, snapshot.home)} and committed with its code. In this project they come first, over yours and the ones that ship.`}
        </Note>
        <Rows>
          {problem && <Row title={problem} />}
          {!problem && agents === null && <Row title="Reading…" />}
          {agents?.length === 0 && (
            <Row
              title="No Agents of its own"
              desc="Save one from a conversation with Save as an Agent…, or copy one here with Customize… on its page."
            />
          )}
          {agents?.map((entry) => {
            const broken = entry.problems.find((one) => one.level === 'error')
            const words = {
              title: agentName(entry),
              ...(entry.definition?.description
                ? { desc: entry.definition.description }
                : broken
                  ? { desc: `${broken.at} — ${broken.text}` }
                  : {}),
              control: entry.definition ? (
                <RowValue>{ceilingWords(entry.definition.ceiling)}</RowValue>
              ) : (
                <Chip state="broken" label="Will not parse" />
              ),
            }
            return current ? (
              <RowButton key={entry.id} {...words} onClick={() => shell.openAgents(entry.id)} />
            ) : (
              <Row key={entry.id} {...words} />
            )
          })}
        </Rows>
        {!current && agents && agents.length > 0 && (
          <Note>Open this project to start its Agents, or to see each one’s page.</Note>
        )}
      </section>
      <ProjectFlows root={root} current={current} />
      <ProjectChecks root={root} />
      <ProjectProvenance root={root} />
      {memoryOpen ? (
        <section aria-label="Memory">
          <SectionHead name="Memory" />
          {openGoals && openGoals.length > 0 && (
            <NativeSelect
              aria-label="Cite into"
              value={citeInto}
              onChange={(event) => setCiteInto(event.target.value)}
            >
              <option value="">Browse only — choose a Goal to cite into</option>
              {openGoals.map((one) => <option key={one.goal.id} value={one.goal.id}>{`Cite into: ${one.goal.sentence}`}</option>)}
            </NativeSelect>
          )}
          <MemoryCitation root={root} goal={(citeInto || null) as GoalId | null} />
        </section>
      ) : (
        <Rows>
          <RowButton
            title="Project memory"
            desc="Committed notes a Goal can cite."
            onClick={() => setMemoryOpen(true)}
          />
        </Rows>
      )}
    </>
  )
}
