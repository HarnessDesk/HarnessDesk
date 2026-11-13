import { useEffect, useRef, useState } from 'react'
import type { McpTestResult, McpTestTarget, RuntimeId } from '@harnessdesk/protocol'

import { useSnapshot, useStore } from '../state/context'
import { Button, Chip, CodeText, ConfirmDialog, Dialog, DescLines, InlineParts, Text } from '../design'
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
  busy: 'Busy',
  error: 'Not tested',
}

/** Reuse the existing lookup failure while naming the specific missing prerequisite. */
const failureWord = (failure: Exclude<Answer, { ok: true } | { reason: 'confirm' }>): string =>
  failure.reason === 'notFound' && /^Environment variable [A-Za-z_][A-Za-z0-9_]* is not set\./.test(failure.detail)
    ? 'Variable not set' : FAILURE_WORD[failure.reason]

/** The same result word and tone in a list row, detail, and reading sheet. */
export const McpTestResultChip = ({ answer, compact = false }: { answer: Answer | null; compact?: boolean }) => {
  if (!answer || (!answer.ok && answer.reason === 'confirm')) return null
  if (answer.ok) return <Chip tone="success" size="sm"
    title={[`${answer.tools} ${answer.tools === 1 ? 'tool' : 'tools'}`, [answer.serverName, answer.serverVersion].filter(Boolean).join(' '), `answered in ${answer.ms} ms`].filter(Boolean).join(' · ')}>
    {compact ? 'Connected' : `Connected · ${answer.tools} ${answer.tools === 1 ? 'tool' : 'tools'}`}
  </Chip>
  return <Chip tone={answer.reason === 'busy' ? 'neutral' : answer.reason === 'needsSignIn' ? 'warning' : 'danger'} size="sm"
    title={sanitizeText(answer.detail)}>{failureWord(answer)}</Chip>
}

/** A command line as a person would type it: arguments with spaces or quotes are quoted. */
export const commandLine = (command: string, args: readonly string[]): string =>
  [command, ...args].map(part => /^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`).join(' ')

/**
 * Characters a confirmation must not draw as they are: controls (line breaks
 * and tabs included — none belongs in a command line, a URL or a variable),
 * soft hyphens, marks that reorder text (U+202A–U+202E, U+2066–U+2069,
 * U+200E, U+200F, U+061C) and characters that draw nothing (U+200B–U+200D,
 * U+2060–U+2064, U+FEFF and the like). Each is shown as its code point.
 */
const UNSHOWN = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb]/g

/** The most of one value a confirmation draws; the rest is counted, not drawn. */
const SHOWN_LIMIT = { line: 2_000, value: 400, names: 1_000 } as const

/**
 * One value as a confirmation draws it: every character it would not draw
 * as itself written as `⟨U+202E⟩`, sanitised, and cut at `limit` with the
 * count of what was cut.
 */
export const shownValue = (value: string, limit: number): { text: string; cut: number; marked: boolean } => {
  let marked = false
  const spelled = value.replace(UNSHOWN, char => {
    marked = true
    return `⟨U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}⟩`
  })
  const text = sanitizeText(spelled)
  return text.length <= limit ? { text, cut: 0, marked } : { text: `${text.slice(0, limit)}…`, cut: text.length - limit, marked }
}

/** What a confirmation draws of a target, every value through `shownValue`, and what that left out or spelled. */
const shownTarget = (target: McpTestTarget, cwd: string, home: string | undefined) => {
  const parts: ReturnType<typeof shownValue>[] = []
  const show = (value: string, limit: number): string => {
    const shown = shownValue(value, limit)
    parts.push(shown)
    return shown.text
  }
  const plate = show(target.transport === 'stdio' ? commandLine(target.command, target.args) : target.url, SHOWN_LIMIT.line)
  const launch = target.transport === 'stdio'
    ? target.launchEnv.map(({ name, value }) => `${show(name, SHOWN_LIMIT.value)}=${show(value, SHOWN_LIMIT.value)}`).join('\n')
    : ''
  const names = show((target.transport === 'stdio' ? target.envNames : target.headerNames).join(', '), SHOWN_LIMIT.names)
  // Read every name in full: this is the consent inventory, not a capped preview.
  const reads = (target.readEnvNames ?? []).map(name => shownValue(name, Number.POSITIVE_INFINITY).text).join(', ')
  const folder = show(shortPath(cwd, home), SHOWN_LIMIT.value)
  const cut = parts.reduce((sum, part) => sum + part.cut, 0)
  const notes = [
    cut > 0 ? `${cut.toLocaleString('en-US')} more ${cut === 1 ? 'character is' : 'characters are'} not shown.` : '',
    parts.some(part => part.marked) ? 'A ⟨U+…⟩ is a character that draws nothing or changes the order of the text around it.' : '',
  ].filter(Boolean).join(' ')
  return { plate, launch, names, reads, folder, notes }
}

/**
 * Test connection for one declared MCP server — one copy, in one file.
 *
 * Runs only when its button is clicked. A server the project's own file
 * declares shows exactly what it would run (`ConfirmDialog`) before it runs;
 * the host decides that, not this component, by answering `confirm`. The
 * result stays on the row as a chip; a failure adds its reason, the one line
 * that varies, and the server's own output folds away beneath it.
 */
export const McpConnectionTest = ({ name, path, cwd, readBy, home, compact = false }: {
  /** List action: result on the same line, failure reason in a dialog, no second line. */
  compact?: boolean
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
  const [readingFailure, setReadingFailure] = useState(false)
  const [answer, setAnswer] = useState<Answer | null>(null)
  const [asking, setAsking] = useState<{ target: McpTestTarget; digest: string } | null>(null)
  const inFlight = useRef(false)
  const live = useRef(true)
  // Re-armed on every mount: StrictMode mounts, cleans up and mounts again.
  useEffect(() => {
    live.current = true
    return () => { live.current = false }
  }, [])

  const run = async (confirmed?: string) => {
    if (inFlight.current) return
    inFlight.current = true
    setRunning(true); setAsking(null); setReadingFailure(false)
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
      inFlight.current = false
      if (live.current) setRunning(false)
    }
  }

  // Sign-in is the agent's: offered only where an agent that reads this copy has its own.
  const signIn = snapshot.runtimes.filter(runtime => readBy.includes(runtime.id) && runtime.capabilities.mcp)
  const failure = answer && !answer.ok && answer.reason !== 'confirm' ? answer : null
  const detail = failure ? sanitizeText(failure.detail) : null
  const stderr = failure && 'stderr' in failure && failure.stderr ? sanitizeText(failure.stderr) : null
  const shown = asking ? shownTarget(asking.target, asking.target.transport === 'stdio' ? asking.target.cwd : '', home) : null

  const content = <>
    <InlineParts data-mcp-test="" onClick={event => event.stopPropagation()}>
      <Button variant={compact ? 'ghost' : 'outline'} size="xs" disabled={running} onClick={() => void run()}
        title={`${compact ? `${sanitizeText(shortPath(path, home))}: ` : ''}Start this server from its declaration, ask it for its tools, then stop it`}>
        {running ? 'Testing…' : compact ? 'Test' : 'Test connection'}
      </Button>
      {compact && failure ? <Button variant="ghost" size="content-min" onClick={() => setReadingFailure(true)}
        title="Read the connection test failure"><McpTestResultChip answer={answer} compact /></Button>
        : <McpTestResultChip answer={answer} compact={compact} />}
      {!compact && failure?.reason === 'needsSignIn' && signIn.map(runtime => <Button key={runtime.id} variant="ghost" size="xs"
        title={`Sign in through ${runtime.presentation.name}`} onClick={() => void store.mcpLogin(name, runtime.id)}>
        {signIn.length === 1 ? 'Sign in' : `Sign in · ${runtime.presentation.name}`}
      </Button>)}
    </InlineParts>
    {!compact && detail && <Text role="meta" tone={failure?.reason === 'needsSignIn' ? 'warning' : undefined}>
      {failure?.reason === 'needsSignIn' && signIn.length === 0 ? `${detail} Its agent signs in to it, not this page.` : detail}
    </Text>}
    {!compact && stderr && <details>
      <Text as="summary" role="meta">Server output</Text>
      <CodeText as="pre" block ground="muted" wrap>{stderr}</CodeText>
    </details>}
    {compact && readingFailure && failure && <span onClick={event => event.stopPropagation()}><Dialog
      title={failureWord(failure)} onClose={() => setReadingFailure(false)}
      description={sanitizeText(name)}>
      <Text as="p" role="meta">{detail}{failure.reason === 'needsSignIn' && signIn.length === 0 ? ' Its agent signs in to it, not this page.' : ''}</Text>
      {failure.reason === 'needsSignIn' && signIn.map(runtime => <Button key={runtime.id} variant="ghost" size="xs"
        title={`Sign in through ${runtime.presentation.name}`} onClick={() => void store.mcpLogin(name, runtime.id)}>
        {signIn.length === 1 ? 'Sign in' : `Sign in · ${runtime.presentation.name}`}
      </Button>)}
      {stderr && <CodeText as="pre" block ground="muted" wrap>{stderr}</CodeText>}
    </Dialog></span>}
    {asking && shown && <span onClick={event => event.stopPropagation()}><ConfirmDialog
      title={asking.target.transport === 'stdio' ? 'Run this project’s server?' : 'Connect to this project’s server?'}
      confirmLabel={asking.target.transport === 'stdio' ? 'Run test' : 'Connect'}
      cancelLabel="Cancel"
      onConfirm={() => void run(asking.digest)}
      onCancel={() => setAsking(null)}
    >
      <Text as="p">
        {sanitizeText(shortPath(path, home))} comes with the project, so whoever wrote the repository chose what it {asking.target.transport === 'stdio' ? 'runs' : 'connects to'}.
        {asking.target.transport === 'stdio' ? ` The test runs this in ${shown.folder}, then stops it:` : ' The test sends its first two requests here, then disconnects:'}
      </Text>
      <CodeText as="pre" block ground="muted" wrap>{shown.plate}</CodeText>
      {shown.launch && <Text as="p" role="meta">With these variables, which change what starts and what it loads first:</Text>}
      {shown.launch && <CodeText as="pre" block ground="muted" wrap>{shown.launch}</CodeText>}
      {shown.names && <Text as="p" role="meta">
        {asking.target.transport === 'stdio' ? (shown.launch ? 'And its other variables: ' : 'With its variables: ') : 'With its headers: '}
        {shown.names}
      </Text>}
      {shown.reads && <Text as="p" role="meta">Reads from this desk: {shown.reads}</Text>}
      {shown.notes && <Text as="p" role="meta" tone="warning">{shown.notes}</Text>}
    </ConfirmDialog></span>}
  </>
  return compact ? content : <DescLines>{content}</DescLines>
}
