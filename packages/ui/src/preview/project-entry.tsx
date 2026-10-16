/** Synthetic project-entry fixture: no native picker, host, or account data. */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Composer } from '../components/Composer'
import { FrontDoor } from '../components/FrontDoor'
import { Sidebar } from '../components/Sidebar'
import { Button, Dialog, PaneColumn, Row, Text } from '../design'
import { PaneProvider } from '../state/context'
import type { AppSnapshot } from '../state/store'
import { useTheme } from '../state/theme'
import { PREVIEW_GOALS } from './goal-fixture'
import { Mount, previewStore, store } from './harness'
import { teamStartStore } from './frames-team-start'
import '../styles/app.css'

const params = new URLSearchParams(location.search)
const scene = params.get('scene') ?? 'empty'
const seed = store.getSnapshot()
const baseGoal = PREVIEW_GOALS[0]!
const team = { ...baseGoal.board, id: 'project-entry-team', root: '/work/storefront', name: 'Finish checkout retry', members: [], intents: [], channel: [], updatedAt: 1, messaging: true }
const goal = { ...baseGoal, board: team, activity: 'ready-to-wrap' as const, members: [], waitingOn: [],
  goal: { ...baseGoal.goal, id: team.id, root: team.root, cwd: team.root, sentence: team.name, state: 'open' as const } }
const workspace = { path: goal.goal.root, name: 'storefront', lastOpenedAt: 1 }
const target = previewStore({ ...seed, history: [], sessions: new Map(), approvals: [], inbox: [], usage: [],
  workspace: scene === 'finished' ? workspace : null, workspaces: scene === 'finished' ? [workspace] : [],
  worktrees: [], activeSessionKey: null, teams: scene === 'finished' ? new Map([[team.id, team]]) : new Map(),
  goals: scene === 'finished' ? new Map([[goal.goal.id, goal]]) : new Map(), flowExecutions: new Map(),
  foldersGone: params.has('gone') ? new Map([[team.root, 'This project folder no longer exists.']]) : new Map(), tasks: new Map(), queues: new Map(),
  listPrefs: { ...seed.listPrefs, pinned: [], pinnedSessions: [], collapsed: [] },
} satisfies Partial<AppSnapshot>)

const Preview = () => {
  const [picker, setPicker] = useState(false)
  const [wrapped, setWrapped] = useState(false)
  const chooseProject = () => setPicker(true)
  return <Mount with={target}><div className="flex h-screen bg-background text-foreground"><aside className="w-72 shrink-0 h-full">
    <Sidebar onOpenSettings={() => {}} onOpenPlugins={() => {}} onOpenTeams={() => {}} onOpenAgents={() => {}}
      onOpenUsage={() => {}} onBrowseFolders={chooseProject} onSignIn={() => {}} onSearch={() => {}} /></aside>
    <main className="flex min-w-0 flex-1 flex-col justify-end py-6">
      {scene === 'finished' ? <PaneColumn inset="reading"><Row title="Storefront" control={<Button onClick={() => {
        target.patch({ goals: new Map([[goal.goal.id, { ...goal, goal: { ...goal.goal, state: 'wrapped' } }]]) })
        setWrapped(true)
      }} disabled={wrapped}>{wrapped ? 'Wrapped' : 'Wrap Team'}</Button>} /></PaneColumn>
        : <><PaneColumn inset="bars"><Text role="page">Start a conversation</Text></PaneColumn>
          <PaneProvider scope={{ paneId: 'entry', view: { kind: 'conversation', session: null }, sessionKey: null }}><Composer onChooseProject={chooseProject} /></PaneProvider></>}
    </main>
  </div>{picker && <Dialog title="Open a project folder" onClose={() => setPicker(false)}><Text>Choose a project folder.</Text></Dialog>}</Mount>
}
const Shapes = () => {
  const [own] = useState(teamStartStore)
  return <Mount with={own}><div className="min-h-screen bg-background text-foreground"><FrontDoor context={{ kind: 'project', root: '/work/storefront' }} onClose={() => {}} onStarted={() => {}} /></div></Mount>
}
const ThemedPreview = () => {
  useTheme()
  return scene === 'shapes' ? <Shapes /> : <Preview />
}
createRoot(document.getElementById('root')!).render(<Mount with={target}><ThemedPreview /></Mount>)
