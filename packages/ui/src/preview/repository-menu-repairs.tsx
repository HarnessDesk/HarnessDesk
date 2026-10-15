import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Button, PaneColumn, Text } from '../design'
import { WorkspaceMenu } from '../components/WorkspaceMenu'
import { StoreProvider } from '../state/context'
import { AppStore } from '../state/store'
import { useTheme } from '../state/theme'
import '../styles/app.css'

const path = '/work/storefront'
const query = new URLSearchParams(location.search)
const store = new AppStore('ws://localhost:0/')
let committed = query.has('committed')
Object.assign(store.getSnapshot(), {
  theme: query.get('theme') === 'dark' ? 'dark' : 'light',
  health: { state: 'ready' },
  workspaces: query.has('alias') ? [{ path: '/work/link', realPath: path, name: 'storefront', lastOpenedAt: 1, git: { branch: 'main', sha: null } }] : [],
})
store.transport.request = (async () => ({ root: path, branch: 'main', headSha: committed ? 'c0ffee1234567890' : null, files: [], ahead: 0, behind: 0 })) as typeof store.transport.request

const Preview = () => {
  useTheme()
  const [open, setOpen] = useState(true)
  return <main className="min-h-screen bg-background text-foreground">
    <PaneColumn inset="reading" page>
      <div className="flex flex-col items-start gap-3">
      <Text role="subject">Storefront project</Text>
      <Button onClick={async () => { committed = true; await store.refreshWorkspaceGit(path) }}>Commit outside the dialog</Button>
      <Button onClick={() => setOpen(true)}>Project actions</Button>
      </div>
    </PaneColumn>
    {open && <WorkspaceMenu group={{ root: path, name: 'storefront', sessions: [], folders: [path], updatedAt: 0 }} current={false} actualRoot={path}
      at={{ x: 40, y: 160 }} onClose={() => setOpen(false)} onNewWorktree={() => {}} />}
  </main>
}
createRoot(document.getElementById('root')!).render(<StoreProvider store={store}><Preview /></StoreProvider>)
