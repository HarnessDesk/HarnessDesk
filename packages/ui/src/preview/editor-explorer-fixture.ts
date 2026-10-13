import type { HostMethodName, HostParams, SessionKey } from '@harnessdesk/protocol'
import type { AppStore } from '../state/store'

/** Synthetic worktree with a conversation below the Git root; never a real desk. */
export const installExplorerFixture = (store: AppStore, scene: string) => {
  const snapshot = store.getSnapshot(), session = snapshot.activeSessionKey!
  const root = '/work/storefront-branch/src', gitRoot = '/work/storefront-branch'
  const retained = snapshot.sessions.get(session)!
  Object.assign(snapshot, { sessions: new Map(snapshot.sessions).set(session, { ...retained, cwd: root }),
    workspace: { ...snapshot.workspace!, path: '/work/storefront', name: 'storefront' } })
  const calls: { method: string; params: unknown }[] = []
  const request = store.transport.request.bind(store.transport)
  const listings: Readonly<Record<string, readonly { name: string; kind: 'file' | 'directory' }[]>> = {
    [root]: [{ name: 'app', kind: 'directory' }, { name: 'newdir', kind: 'directory' }, { name: 'README.md', kind: 'file' }, { name: 'unchanged.ts', kind: 'file' }],
    [`${root}/app`]: [{ name: 'checkout.ts', kind: 'file' }, { name: 'new.ts', kind: 'file' }],
    [`${root}/newdir`]: [{ name: 'draft.md', kind: 'file' }],
  }
  store.transport.request = (async (method: HostMethodName, params: HostParams<HostMethodName>) => {
    if (method === 'workspace/browse' && (params as HostParams<'workspace/browse'>).mode === 'entries') {
      const p = params as { root: string; path?: string }, path = p.path ?? p.root
      calls.push({ method, params })
      return { path, parent: path === p.root ? null : p.root, entries: (listings[path] ?? []).map(entry => ({ ...entry, path: `${path}/${entry.name}` })) }
    }
    if (method === 'git/status') {
      calls.push({ method, params })
      if (scene === 'plain') return null
      return { root: gitRoot, branch: 'feature/checkout', ahead: 0, behind: 0, files: [
        { path: 'src/app/checkout.ts', status: 'modified', staged: false },
        { path: 'src/app/checkout.ts', status: 'modified', staged: true },
        { path: 'src/app/new.ts', status: 'added', staged: false },
        { path: 'src/gone.ts', status: 'deleted', staged: false },
        { path: 'src/newdir/', status: 'untracked', staged: false },
        { path: 'outside.ts', status: 'modified', staged: false },
      ] }
    }
    if (method === 'workspace/files') {
      calls.push({ method, params })
      const p = params as HostParams<'workspace/files'>
      return ['README.md', 'app/checkout.ts', 'app/new.ts'].filter(path => path.toLowerCase().includes(p.query.toLowerCase()))
        .map(path => ({ path: `${root}/${path}`, relativePath: path, kind: 'file', score: 1 }))
    }
    return request(method, params as never)
  }) as typeof store.transport.request
  return { calls, session: session as SessionKey }
}
