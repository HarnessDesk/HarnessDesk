import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import type { Account } from '@harnessdesk/protocol'

import type { KnownAgent } from './known-agents.js'

/**
 * Who an agent is signed in as, read from the agent's own files.
 *
 * ACP has no account query, and the agents below have no status command to
 * ask either — so a session that opened was all the desk had to go on, and
 * the account menu said "Signed in" for each of them. Each one does write
 * down how it authenticates, and some write down who as. These readers are
 * that record: read-only, read the way the agent itself reads it, and never
 * a write, a token refresh or a network call.
 *
 * Measured on 2026-09-09 against the vendors' own builds — Gemini CLI
 * 0.59.0, Cline 3.0.61 and the Antigravity ACP server 1.1.1 — not from their
 * documentation. A record a reader does not recognise names nobody, and the
 * adapter keeps saying "Signed in".
 */

export interface IdentityContext {
  /** The row's arguments, for an agent whose folder moves with a flag. */
  readonly args?: readonly string[]
  /** Where the agent is started; a relative folder in its arguments is relative to this. */
  readonly cwd?: string
  /** The environment the agent is started with. Defaults to the host's own. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** The home directory. Tests point it somewhere else. */
  readonly home?: string
}

export type IdentityReader = () => Account | null

/** The reader for the agent a row drives, when the desk knows where that agent writes it down. */
export const identityReaderFor = (
  known: Pick<KnownAgent, 'id'> | undefined,
  context: IdentityContext = {},
): IdentityReader | undefined => {
  switch (known?.id) {
    case 'gemini':
      return () => geminiIdentity(context)
    case 'antigravity-acp':
      return () => antigravityIdentity(context)
    case 'cline':
      return () => clineIdentity(context)
    default:
      return undefined
  }
}

/** An address the agent recorded: the row says who. */
const signedInAs = (email: string): Account => ({ kind: 'agent', label: email, email })

/**
 * A method the agent recorded with no person attached: the row says how.
 * Anonymous in the protocol's sense — the label is not a person, so a
 * surface that names accounts names the agent instead.
 */
const signedInWith = (method: string): Account => ({ kind: 'agent', label: method, anonymous: true })

/**
 * Gemini CLI writes the method to `settings.json` —
 * `security.auth.selectedType`, or `selectedAuthType` at the top level in
 * files older than 0.3 — and, after a Google sign-in, the account to
 * `google_accounts.json` (`active`), the file its own `/about` reads.
 * `GEMINI_CLI_HOME` moves the home the `.gemini` folder sits in. With no
 * method chosen it takes one from the environment, in the order below.
 */
const geminiIdentity = (context: IdentityContext): Account | null => {
  const env = context.env ?? process.env
  const folder = join(nonEmpty(env['GEMINI_CLI_HOME']) ?? context.home ?? homedir(), '.gemini')
  const settings = readJson(join(folder, 'settings.json'))
  const method =
    nonEmpty(at(settings, 'security', 'auth', 'selectedType')) ??
    nonEmpty(at(settings, 'selectedAuthType')) ??
    geminiMethodFromEnv(env)
  switch (method) {
    case 'oauth-personal': {
      const email = nonEmpty(at(readJson(join(folder, 'google_accounts.json')), 'active'))
      return email ? signedInAs(email) : signedInWith('Google account')
    }
    case 'gemini-api-key':
      return signedInWith('Gemini API key')
    case 'vertex-ai':
      return signedInWith('Vertex AI')
    case 'compute-default-credentials':
    case 'cloud-shell':
      return signedInWith('Google Cloud credentials')
    case 'gateway':
      return signedInWith('Gemini gateway')
    default:
      return null
  }
}

/**
 * Gemini CLI's own fallback when no method is chosen — `getAuthTypeFromEnv`
 * in 0.59.0, branch for branch and in its order. `GOOGLE_API_KEY` is not in
 * it, and not by omission: Gemini reads that key only inside a method already
 * chosen (Vertex AI's express mode, or preferred over `GEMINI_API_KEY` once
 * the key method is), and on its own it chooses nothing — so no session opens
 * for there to be anyone to name.
 */
const geminiMethodFromEnv = (env: Readonly<Record<string, string | undefined>>): string | null => {
  if (env['GOOGLE_GENAI_USE_GCA'] === 'true') return 'oauth-personal'
  if (env['GOOGLE_GENAI_USE_VERTEXAI'] === 'true') return 'vertex-ai'
  if (nonEmpty(env['GOOGLE_GEMINI_BASE_URL'])) return 'gateway'
  if (nonEmpty(env['GEMINI_API_KEY'])) return 'gemini-api-key'
  if (env['CLOUD_SHELL'] === 'true' || env['GEMINI_CLI_USE_COMPUTE_ADC'] === 'true') return 'compute-default-credentials'
  return null
}

/**
 * The Antigravity ACP server records only the method — `auth.type` in its
 * own `settings.json` — and keeps the Google token in the macOS keychain
 * (`acp_token.json` where there is none), beside a refresh token and a
 * project id: never the address. So its row can say how it signed in and
 * not who as; learning that would mean reading the keychain or asking Google
 * with the token, and the desk does neither. `GEMINI_HOME`, when set, is the
 * `.gemini` folder itself.
 */
const antigravityIdentity = (context: IdentityContext): Account | null => {
  const env = context.env ?? process.env
  const folder = nonEmpty(env['GEMINI_HOME']) ?? join(context.home ?? homedir(), '.gemini')
  const method = nonEmpty(at(readJson(join(folder, 'antigravity-acp', 'settings.json')), 'auth', 'type'))
  switch (method) {
    case 'oauth-personal':
      return signedInWith('Google account')
    case 'oauth-business':
      return signedInWith('Gemini Enterprise')
    case 'gemini-api-key':
      return signedInWith('Gemini API key')
    // `vertex-ai` is the server's pre-rebrand spelling, still accepted.
    case 'agent-platform':
    case 'vertex-ai':
      return signedInWith('Agent Platform')
    default:
      return null
  }
}

/**
 * Cline writes every provider it has signed in to into
 * `data/settings/providers.json` and names the one in use
 * (`lastUsedProvider`); signed in to an account, that provider's
 * `auth.metadata.userInfo` carries the address. A provider signed in with a
 * bare key names nobody. `--data-dir` on the row moves the folder; a row
 * that moves only `--config` is not guessed at.
 */
const clineIdentity = (context: IdentityContext): Account | null => {
  const args = context.args ?? []
  const dataDir = flagValue(args, '--data-dir')
  if (dataDir === null && flagValue(args, '--config') !== null) return null
  const home = context.home ?? homedir()
  // A relative folder is relative to where Cline runs: the row's `cwd`, or
  // the desk's own directory, which an agent started without one inherits.
  const folder =
    dataDir === null
      ? join(home, '.cline', 'data')
      : resolve(context.cwd ?? process.cwd(), dataDir.replace(/^~(?=$|\/)/, home))
  const settings = readJson(join(folder, 'settings', 'providers.json'))
  const provider = flagValue(args, '--provider', '-P') ?? nonEmpty(at(settings, 'lastUsedProvider')) ?? 'cline'
  const auth = at(settings, 'providers', provider, 'settings', 'auth')
  const email = nonEmpty(at(auth, 'metadata', 'userInfo', 'email')) ?? nonEmpty(at(auth, 'email'))
  return email ? signedInAs(email) : null
}

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return null
  }
}

/** The value some keys down a parsed file, or undefined where any step is missing. */
const at = (value: unknown, ...keys: readonly string[]): unknown => {
  let here = value
  for (const key of keys) {
    if (typeof here !== 'object' || here === null || Array.isArray(here)) return undefined
    here = (here as Record<string, unknown>)[key]
  }
  return here
}

const nonEmpty = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null

/**
 * The value an option was last given — `--flag value`, `--flag=value`, or a
 * short spelling as `-f value` — or null. The last, and across every spelling
 * of the option, because that is how Cline reads its own arguments: its CLI
 * is built on commander (the binary embeds it), and commander 9.5 keeps the
 * last value of an option given twice and treats `-P` and `--provider` as one
 * option.
 */
const flagValue = (args: readonly string[], ...spellings: readonly string[]): string | null => {
  let value: string | null = null
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    for (const spelling of spellings) {
      if (arg === spelling) value = nonEmpty(args[index + 1])
      else if (spelling.startsWith('--') && arg.startsWith(`${spelling}=`)) value = nonEmpty(arg.slice(spelling.length + 1))
    }
  }
  return value
}
