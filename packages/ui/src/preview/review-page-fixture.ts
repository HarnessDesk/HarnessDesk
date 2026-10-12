import type { GitStatus, HostMethodName, HostParams } from '@harnessdesk/protocol'
import type { AppStore } from '../state/store'
import { previewStore } from './harness'
import { frameDestinationStore } from './frame-destination-store'
export type ReviewScene = 'tree' | 'empty' | 'not-repository' | 'large'
const TREE_DIFF = [
  'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,2 +1,2 @@', '-old line', '+new line', ' kept',
  '@@ -10,1 +10,2 @@', ' context', '+another',
  'diff --git a/docs/guide.md b/docs/guide.md', '--- a/docs/guide.md', '+++ b/docs/guide.md', '@@ -1 +1,2 @@', ' hi', '+there',
].join('\n')
const STAGED_DIFF = ['diff --git a/ready.txt b/ready.txt', '--- /dev/null', '+++ b/ready.txt', '@@ -0,0 +1 @@', '+ready'].join('\n')
const LARGE_DIFF = ['diff --git a/large.txt b/large.txt', '--- a/large.txt', '+++ b/large.txt', '@@ -1 +1,100 @@', '-old',
  ...Array.from({ length: 100 }, (_, i) => `+synthetic line ${i} with enough text to exercise the quote cap`)].join('\n')
/** Synthetic review reads on the same real navigation store as the page fixtures. */
export const reviewPageStore = (scene: ReviewScene): AppStore => {
  const store = frameDestinationStore(previewStore())
  const delegate = store.transport.request.bind(store.transport)
  const files: GitStatus['files'] = scene === 'empty' ? [] : scene === 'large'
    ? [{ path: 'large.txt', status: 'modified', staged: false }]
    : [{ path: 'src/a.ts', status: 'modified', staged: false }, { path: 'docs/guide.md', status: 'modified', staged: false }, { path: 'ready.txt', status: 'added', staged: true }]
  store.transport.request = (async (method: HostMethodName, params: HostParams<HostMethodName>) => {
    if (method === 'git/status') {
      if (scene === 'not-repository') throw new Error('Synthetic non-repository')
      const root = (params as { root: string }).root
      const status: GitStatus = { root, branch: 'main', ahead: 0, behind: 0, files, concluding: null }
      return status
    }
    if (method === 'git/diff') {
      const staged = (params as { staged?: boolean }).staged === true
      return { diff: scene === 'empty' || scene === 'not-repository' ? '' : staged ? STAGED_DIFF : scene === 'large' ? LARGE_DIFF : TREE_DIFF }
    }
    return delegate(method, params)
  }) as typeof store.transport.request
  return store
}
