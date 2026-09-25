import { runtimeId, sessionKey, type RuntimeInfo, type Session, type SessionId, type SessionQueue } from '@harnessdesk/protocol'

import type { AppSnapshot, AppStore } from '../state/store'
import { previewStore, runtime } from './harness'
import { previewSession, previewTurns } from './sidebar-fixture'

/**
 * The composer with everything it can hold at once: a model list long enough
 * to fold its tail behind a filter, the effort select, an agent to hand to, a
 * build with a newer one published, three messages waiting, and a sent
 * message that carried two pictures — so the pickers, the update note, the
 * queue and the lightbox can each be opened and looked at in one place.
 */

/** A PNG the transcript will draw: a base64 data URL, painted here rather than checked in. */
const picture = (width: number, height: number, from: string, to: string, label: string): string => {
  if (typeof document === 'undefined') return 'data:image/png;base64,'
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return 'data:image/png;base64,'
  const gradient = context.createLinearGradient(0, 0, width, height)
  gradient.addColorStop(0, from)
  gradient.addColorStop(1, to)
  context.fillStyle = gradient
  context.fillRect(0, 0, width, height)
  context.fillStyle = 'rgba(255, 255, 255, 0.9)'
  context.font = '600 48px -apple-system, system-ui, sans-serif'
  context.fillText(label, 48, height - 56)
  return canvas.toDataURL('image/png')
}

const MODELS = [
  ['gpt-5.6-terra', 'GPT-5.6 Terra'],
  ['gpt-5.5', 'GPT-5.5'],
  ['gpt-5.5-mini', 'GPT-5.5 Mini'],
  ['gpt-5.4', 'GPT-5.4'],
  ['gpt-5.4-mini', 'GPT-5.4 Mini'],
  ['gpt-5.3', 'GPT-5.3'],
  ['gpt-5.3-codex', 'GPT-5.3 Codex'],
  ['gpt-5.2', 'GPT-5.2'],
  ['gpt-5.2-codex', 'GPT-5.2 Codex'],
  ['gpt-5.1', 'GPT-5.1'],
  ['gpt-5.1-codex-max', 'GPT-5.1 Codex Max'],
  ['gpt-5', 'GPT-5'],
  ['o4-mini', 'o4-mini'],
  ['o3', 'o3'],
] as const

const CODEX = runtimeId('codex')
export const COMPOSER_SESSION_KEY = sessionKey(CODEX, 's1' as SessionId)

const composerSession = (): Session => {
  const base = previewSession as unknown as Session & { options: readonly Record<string, unknown>[] }
  const [, effort] = base.options
  const turns = previewTurns as unknown as readonly { readonly items: readonly Record<string, unknown>[] }[]
  const [first, ...rest] = turns
  const withPictures = first
    ? {
        ...first,
        items: first.items.map((entry) =>
          entry['type'] === 'userMessage'
            ? {
                ...entry,
                content: [
                  ...(entry['content'] as readonly unknown[]),
                  { type: 'image', url: picture(1280, 800, '#3b82f6', '#9333ea', 'Worktree list — before'), name: 'worktrees-before.png' },
                  { type: 'image', url: picture(1024, 1024, '#f97316', '#e11d48', 'After'), name: 'worktrees-after.png' },
                ],
              }
            : entry,
        ),
      }
    : null
  return {
    ...base,
    turns: withPictures ? [withPictures, ...rest] : base.turns,
    options: [
      {
        id: 'model',
        type: 'select',
        label: 'Model',
        category: 'model',
        currentValue: 'gpt-5.5',
        choices: MODELS.map(([value, label]) => ({ value, label })),
      },
      effort,
    ],
  } as unknown as Session
}

const QUEUE: SessionQueue = {
  status: 'waiting',
  reason: null,
  messages: [
    { id: 'q1', state: 'queued', queuedAt: Date.now() - 60_000, input: [{ type: 'text', text: 'Then run the worktree tests again and tell me which ones still fail.' }] },
    { id: 'q2', state: 'queued', queuedAt: Date.now() - 40_000, input: [{ type: 'text', text: 'Also check that a detached worktree is still listed after the filter.' }] },
    { id: 'q3', state: 'queued', queuedAt: Date.now() - 20_000, input: [{ type: 'text', text: 'Open a draft pull request when both pass.' }] },
  ],
} as unknown as SessionQueue

/** A store of its own, so nothing here reaches the frames that share the page's. */
export const composerStore = (base: AppSnapshot, paused = false): AppStore => {
  const sessions = new Map(base.sessions)
  sessions.set(COMPOSER_SESSION_KEY, composerSession())
  const codex = {
    ...runtime('codex', 'Codex'),
    version: 'codex-cli 0.154.0',
    catalogCheckedAt: Date.now() - 4 * 60 * 1000,
    update: { version: '0.155.0', command: 'npm i -g @openai/codex@latest' },
  } as unknown as RuntimeInfo
  return previewStore({
    sessions,
    queues: new Map([[COMPOSER_SESSION_KEY, paused ? { ...QUEUE, status: 'paused', reason: 'The turn was stopped.' } : QUEUE]]),
    runtimes: [codex, runtime('claude', 'Claude Code'), runtime('cursor', 'Cursor')],
    activeRuntime: CODEX,
    activeSessionKey: COMPOSER_SESSION_KEY,
  })
}
