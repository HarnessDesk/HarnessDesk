/** A conversation started without a project: its own folder, under Chats. Placeholders only. */
import { runtimeId, sessionId, sessionKey, turnId, itemId, type Session, type SessionSummary } from '@harnessdesk/protocol'
import { only } from '../src/state/layout'
import { previewStore, runtime } from '../src/preview/harness'
import type { AppStore } from '../src/state/store'

const ROOT = '/demo/chats'
const ASK = 'What makes a retry budget safe for a payment call?'
const ANSWER = [
  'Three things keep it safe.',
  '',
  '1. **Retry only what is idempotent.** Send an idempotency key with the payment, so a repeated request cannot charge twice.',
  '2. **Bound it.** Three attempts with exponential backoff and jitter, and a total deadline the caller can see.',
  '3. **Give up out loud.** When the budget runs out, return a clear failure the order page can show, instead of retrying forever.',
  '',
  'If you want, start a project from this chat and I can sketch the client.',
].join('\n')

/** What the composer's pickers offer: a model list under the placeholder account, and its effort levels. */
const MODELS = [['gpt-5.6-sol', 'GPT-5.6 Sol'], ['gpt-5.6-luna', 'GPT-5.6 Luna'], ['gpt-5.5', 'GPT-5.5'], ['gpt-5.4-mini', 'GPT-5.4 mini']] as const
const EFFORTS = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high']] as const
const OPTIONS = [
  { id: 'model', type: 'select', label: 'Model', category: 'model', currentValue: 'gpt-5.6-sol', choices: MODELS.map(([value, label]) => ({ value, label })) },
  { id: 'reasoning_effort', type: 'select', label: 'Reasoning effort', category: 'thought_level', currentValue: 'medium', choices: EFFORTS.map(([value, label]) => ({ value, label })) },
]

const summary = (id: string, cwd: string, title: string, updatedAt: number): SessionSummary => ({
  id: sessionId(id), runtime: runtimeId('codex'), cwd, title, preview: title, createdAt: updatedAt - 60_000, updatedAt,
  status: { type: 'notLoaded' }, archived: false, git: null, repo: null,
})

export const chatsStore = (): AppStore => {
  const now = Date.now()
  const info = runtime('codex', 'Codex')
  const history = [
    summary('chat', `${ROOT}/2026-10-17-retry`, 'Retry budgets for payments', now - 2 * 60_000),
    summary('chat-2', `${ROOT}/2026-10-16-regex`, 'Explain a date regex', now - 26 * 60 * 60_000),
    summary('chat-3', `${ROOT}/2026-10-15-names`, 'Name the release checklist', now - 50 * 60 * 60_000),
  ]
  const store = previewStore({
    status: 'open', theme: 'system', runtimes: [info], activeRuntime: info.id,
    health: { state: 'ready' }, healthByRuntime: { [info.id]: { state: 'ready' } },
    workspace: null, workspaces: [], worktrees: [], activeSessionKey: null, sessions: new Map(), history,
    historyIdentity: history, teams: new Map(), goals: new Map(), draftOptions: [], tasks: new Map(),
    approvals: [], inbox: [], usage: [], chatsFolder: ROOT, chatsFolderRoots: [ROOT],
  } as never)
  store.agentCatalog = async () => []
  store.queue = async () => true
  const chat = { ...history[0]!, status: { type: 'idle' }, itemsLoaded: true, options: OPTIONS, turns: [{ id: turnId('chat-turn'), status: 'completed',
    startedAt: now - 3 * 60_000, completedAt: now - 2 * 60_000, items: [
      { id: itemId('question'), type: 'userMessage', content: [{ type: 'text', text: ASK }] },
      { id: itemId('answer'), type: 'assistantMessage', text: ANSWER },
    ] }] } as unknown as Session
  const key = sessionKey(chat.runtime, chat.id)
  const workbench = store.getSnapshot().workbench
  const main = only(workbench.main, { kind: 'conversation', session: key })
  store.patch({ sessions: new Map([[key, chat]]), activeSessionKey: key, layout: main, sidebarCollapsed: true, sidebarFloating: false,
    workbench: { ...workbench, main, navigation: { ...workbench.navigation,
      current: { kind: 'work', view: { kind: 'conversation', session: key } } } } } as never)
  store.notice = () => {}
  return store
}
