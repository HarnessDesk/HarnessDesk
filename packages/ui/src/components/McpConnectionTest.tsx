import { useEffect, useRef, useState } from 'react'
import type { McpTestResult, McpTestTarget, RuntimeId } from '@harnessdesk/protocol'

import { useSnapshot, useStore } from '../state/context'
import { Button, Chip, CodeText, ConfirmDialog, DescLines, InlineParts, Text } from '../design'
import { sanitizeText } from '../lib/sanitize'
import { shortPath } from '../lib/paths'

type Failure = Extract<McpTestResult, { ok: false }>
type Answer = McpTestResult | { readonly ok: false; readonly reason: 'error'; readonly detail: string; readonly ms: 0 }

/** The chip's word for each answer: a state that fits in one, never a sentence. */
const FAILURE_WORD: Record<Exclude<Failure['reason'], 'confirm'> | 'error', string> = {
  notFound: 'Not found',
  spawnFailed: 'Did not start',
  timeout: 'Timed out',
  needsSignIn: 'Needs sign-in',
  protocol: 'Protocol error',
  httpError: 'HTTP error',
  busy: 'Already testing',
  error: 'Not tested',
}

/** A command line as a person would type it: arguments with spaces or quotes are quoted. */
export const commandLine = (command: string, args: readonly string[]): string =>
  [command, ...args].map(part => /^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`).join(' ')

/**
 * Test connection for one declared MCP server — one copy, in one file.
 *
 * Runs only when its button is clicked. A server the project's own file
 * declares shows exactly what it would run (`ConfirmDialog`) before it runs;
 * the host decides that, not this component, by answering `confirm`. The
 * result stays on the row as a chip; a failure adds its reason, the one line
 * that varies, and the server's own output folds away beneath it.
 */
export const McpConnectionTest = ({ name, path, cwd, readBy, home }: {
  name: string
  path: string
  cwd: string | undefined
  /** The agents that read this copy — whose own sign-in a 401 points to. */
  readBy: readonly RuntimeId[]
  home: string | undefined
}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [running, setRunning] = useState(false)
  const [answer, setAnswer] = useState<Answer | null>(null)
  const [asking, setAsking] = useState<{ target: McpTestTarget; digest: string } | null>(null)
  const live = useRef(true)
  // Re-armed on every mount: StrictMode mounts, cleans up and mounts again.
  useEffect(() => {
    live.current = true
    return () => { live.current = false }
  }, [])

  const run = async (confirmed?: string) => {
    setRunning(true); setAsking(null)
    try {
      const result = await store.transport.request('library/mcp/test', {
        name, path, ...(cwd !== undefined ? { cwd } : {}), ...(confirmed !== undefined ? { confirmed } : {}),
      })
      if (!live.current) return
      if (!result.ok && result.reason === 'confirm') { setAsking({ target: result.target, digest: result.digest }); setAnswer(null) }
      else setAnswer(result)
    } catch (error) {
      if (live.current) setAnswer({ ok: false, reason: 'error', detail: error instanceof Error ? error.message : String(error), ms: 0 })
    } finally {
      if (live.current) setRunning(false)
    }
  }

  // Sign-in is the agent's: offered only where an agent that reads this copy has its own.
  const signIn = snapshot.runtimes.filter(runtime => readBy.includes(runtime.id) && runtime.capabilities.mcp)
  const failure = answer && !answer.ok && answer.reason !== 'confirm' ? answer : null
  const detail = failure ? sanitizeText(failure.detail) : null
  const stderr = failure && 'stderr' in failure && failure.stderr ? sanitizeText(failure.stderr) : null

  return <DescLines>
    <InlineParts data-slot="mcp-test">
      <Button variant="outline" size="xs" disabled={running} onClick={() => void run()}
        title="Start this server from its declaration, ask it for its tools, then stop it">
        {running ? 'Testing…' : 'Test connection'}
      </Button>
      {answer?.ok && <Chip tone="success" size="sm"
        title={[answer.serverName, answer.serverVersion].filter(Boolean).join(' ') + ` · answered in ${answer.ms} ms`}>
        {`Connected · ${answer.tools} ${answer.tools === 1 ? 'tool' : 'tools'}`}
      </Chip>}
      {failure && <Chip tone={failure.reason === 'busy' ? 'neutral' : failure.reason === 'needsSignIn' ? 'warning' : 'danger'} size="sm">
        {FAILURE_WORD[failure.reason]}
      </Chip>}
      {failure?.reason === 'needsSignIn' && signIn.map(runtime => <Button key={runtime.id} variant="ghost" size="xs"
        title={`Sign in through ${runtime.presentation.name}`} onClick={() => void store.mcpLogin(name, runtime.id)}>
        {signIn.length === 1 ? 'Sign in' : `Sign in · ${runtime.presentation.name}`}
      </Button>)}
    </InlineParts>
    {detail && failure?.reason !== 'busy' && <Text role="meta" tone={failure?.reason === 'needsSignIn' ? 'warning' : undefined}>
      {failure?.reason === 'needsSignIn' && signIn.length === 0 ? `${detail} Its agent signs in to it, not this page.` : detail}
    </Text>}
    {stderr && <details>
      <Text as="summary" role="meta">Server output</Text>
      <CodeText as="pre" block ground="muted" wrap>{stderr}</CodeText>
    </details>}
    {asking && <ConfirmDialog
      title={asking.target.transport === 'stdio' ? 'Run this project’s server?' : 'Connect to this project’s server?'}
      confirmLabel={asking.target.transport === 'stdio' ? 'Run test' : 'Connect'}
      onConfirm={() => void run(asking.digest)}
      onCancel={() => setAsking(null)}
    >
      <Text as="p">
        {shortPath(path, home)} comes with the project, so whoever wrote the repository chose what it {asking.target.transport === 'stdio' ? 'runs' : 'connects to'}.
        {asking.target.transport === 'stdio' ? ` The test runs this in ${shortPath(asking.target.cwd, home)}, then stops it:` : ' The test sends its first two requests here, then disconnects:'}
      </Text>
      <CodeText as="pre" block ground="muted" wrap>
        {asking.target.transport === 'stdio' ? commandLine(asking.target.command, asking.target.args) : asking.target.url}
      </CodeText>
      {(asking.target.transport === 'stdio' ? asking.target.envNames : asking.target.headerNames).length > 0 && <Text as="p" role="meta">
        {asking.target.transport === 'stdio' ? 'With its variables: ' : 'With its headers: '}
        {(asking.target.transport === 'stdio' ? asking.target.envNames : asking.target.headerNames).join(', ')}
      </Text>}
    </ConfirmDialog>}
  </DescLines>
}
