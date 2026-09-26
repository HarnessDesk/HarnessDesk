import { runtimeId, type AccountStatus, type RuntimeId, type RuntimeInfo } from '@harnessdesk/protocol'

import type { AppSnapshot } from '../state/store'

/**
 * A sign-in page with every state on it at once.
 *
 * The page's other fixture has three agents, all signed in, which is the one
 * roster the Sign in dialog never needs to help with. This one is the roster
 * a person opens it for: some connected, one at a limit, one that refused a
 * session and said why, one with a key and nothing else, one with a browser
 * flow *and* a key, and a code being typed on another device. Identities are
 * the demo persona and placeholders — this page is photographed.
 */

const agent = (id: string, name: string, tagline: string, over: Record<string, unknown> = {}): RuntimeInfo =>
  ({
    id: runtimeId(id),
    name,
    version: '1.0.0',
    capabilities: { account: true },
    presentation: { name, tagline },
    ...over,
  }) as unknown as RuntimeInfo

const RUNTIMES: readonly RuntimeInfo[] = [
  agent('codex', 'Codex', 'Coding agent that reads, edits and runs code', {
    presentation: { name: 'Codex', tagline: 'Coding agent that reads, edits and runs code', configLocation: '~/.codex' },
  }),
  agent('claude', 'Claude Code', 'Agentic coding in your terminal'),
  agent('cursor', 'Cursor', 'The agent from the Cursor editor'),
  agent('deepseek', 'DeepSeek', 'DeepSeek models in a coding harness'),
  agent('gemini', 'Gemini CLI', 'Open-source agent for the terminal'),
  agent('qwen', 'Qwen Code', 'Coding agent for Qwen models'),
  agent('devin', 'Devin', 'Autonomous software engineer'),
  agent('opencode', 'OpenCode', 'Open-source coding agent'),
]

const oauth = (label: string, planType?: string) => ({ kind: 'oauth', label, email: label, ...(planType ? { planType } : {}) })

const ACCOUNTS: Record<string, AccountStatus> = {
  codex: { accounts: [oauth('shane@harnessdesk.app', 'Pro')], signInMethods: [] },
  claude: { accounts: [oauth('shane@harnessdesk.app', 'Max 20x')], signInMethods: [] },
  cursor: { accounts: [oauth('dev@example.com')], signInMethods: [] },
  deepseek: {
    accounts: [],
    signInMethods: [{
      id: 'key',
      label: 'API key',
      keyLabel: 'DeepSeek API key',
      flow: 'apiKey',
      helpUrl: 'https://platform.deepseek.com/api_keys',
    }],
  },
  gemini: {
    accounts: [],
    signInMethods: [
      { id: 'google', label: 'Sign in with Google', flow: 'browser' },
      { id: 'key', label: 'Gemini API key', keyLabel: 'Gemini API key', flow: 'apiKey', description: 'From Google AI Studio.' },
    ],
  },
  qwen: {
    accounts: [],
    signInMethods: [
      { id: 'acp:openai', label: 'Use OpenAI API key', flow: 'browser', description: 'Requires setting the `OPENAI_API_KEY` environment variable' },
      { id: 'acp:responses', label: 'Use OpenAI Responses API key', flow: 'browser', description: 'Requires setting the `OPENAI_API_KEY` environment variable' },
    ],
    refusal: 'Authentication required: Use Qwen Code CLI to authenticate first.',
  },
  devin: {
    accounts: [],
    signInMethods: [{ id: 'device', label: 'Sign in on another device', flow: 'deviceCode' }],
  },
  opencode: { accounts: [{ kind: 'agent', label: 'Signed in', anonymous: true }], signInMethods: [] },
} as unknown as Record<string, AccountStatus>

export const SIGN_IN_SCENES = ['refused', 'key only', 'browser and key', 'code', 'paste code', 'connected'] as const
export type SignInScene = (typeof SIGN_IN_SCENES)[number]

/** Which agent each scene opens on. */
export const SIGN_IN_SELECTED: Record<SignInScene, RuntimeId> = {
  refused: runtimeId('qwen'),
  'key only': runtimeId('deepseek'),
  'browser and key': runtimeId('gemini'),
  code: runtimeId('devin'),
  'paste code': runtimeId('claude'),
  connected: runtimeId('claude'),
}

/**
 * Claude signing in again, its command having asked for the code a browser
 * page shows when the page cannot hand the result back by itself — the field
 * the desk puts where the command's input would be.
 */
const PASTE_CODE_ACCOUNTS: Record<string, AccountStatus> = {
  ...ACCOUNTS,
  claude: { accounts: [], signInMethods: [{ id: 'cli-browser', label: 'Sign in in your browser', flow: 'browser' }] },
} as unknown as Record<string, AccountStatus>

export const signInSeed = (scene: SignInScene): Partial<AppSnapshot> => ({
  runtimes: RUNTIMES,
  activeRuntime: runtimeId('codex'),
  accountsByRuntime: scene === 'paste code' ? PASTE_CODE_ACCOUNTS : ACCOUNTS,
  healthByRuntime: {},
  credentialProtection: 'macOS Keychain',
  // One lane spent on the first account, so the rail shows the limit tone.
  usage: [{
    runtime: runtimeId('codex'),
    account: 'shane@harnessdesk.app',
    lanes: [{ id: 'weekly', label: 'Weekly', usedPercent: 100, windowMinutes: 10_080, resetsAt: Date.now() + 86_400_000 }],
    reached: { lane: 'weekly' },
  }],
  logins: scene === 'code'
    ? {
        [runtimeId('devin')]: {
          method: 'device',
          start: { type: 'deviceCode', loginId: 'l1', url: 'https://example.com/device', code: 'WDJB-MJHT' },
          outcome: { type: 'pending' },
          awaitingCode: false,
        },
      }
    : scene === 'paste code'
      ? {
          [runtimeId('claude')]: {
            method: 'cli-browser',
            start: { type: 'browser', loginId: 'l2', url: 'https://example.com/oauth/authorize', pasteCode: true },
            outcome: { type: 'pending' },
            awaitingCode: true,
          },
        }
      : {},
} as unknown as Partial<AppSnapshot>)

/**
 * The same roster for Settings › Runtimes, with one agent that did not start
 * as well — so the page's "Needs attention" group holds every kind of
 * attention at once: signed out, at a limit, and unavailable.
 */
export const runtimesSeed = (): Partial<AppSnapshot> => ({
  ...signInSeed('refused'),
  healthByRuntime: {
    [runtimeId('opencode')]: {
      state: 'unavailable',
      reason: 'crashed',
      message: 'OpenCode exited before it was ready.',
      remediation: 'Check that `opencode` runs from a terminal.',
    },
  },
} as unknown as Partial<AppSnapshot>)
