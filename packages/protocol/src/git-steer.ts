/** Shared by the host, PATH stand-ins and bridges. No shell evaluation or I/O. */
export type GitSteerMode = 'ask' | 'redirect' | 'off'
export type GitWriteProjectMode = 'inherit' | GitSteerMode
export interface GitWritePreferences { readonly steer: GitSteerMode; readonly recordOutside: boolean; readonly projects?: Readonly<Record<string, GitWriteProjectMode>> }
export type GitWrite =
  | { readonly kind: 'push'; readonly remote?: string; readonly source?: string; readonly branch?: string; readonly upstream: boolean; readonly force: boolean }
  | { readonly kind: 'forge'; readonly tool: string; readonly args: Readonly<Record<string, string | number | boolean>>; readonly bodyFile?: string; readonly fill?: boolean }
  | { readonly kind: 'unmappable'; readonly reason: string; readonly tool?: string }
const refuse = (reason: string, tool?: string): GitWrite => ({ kind: 'unmappable', reason: `${reason} Use git_push or the pr_* tools instead.`, ...(tool ? { tool } : {}) })
export function gitWritePreferences(value: unknown): GitWritePreferences {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return { steer: raw['steer'] === 'off' || raw['steer'] === 'redirect' ? raw['steer'] : 'ask', recordOutside: raw['recordOutside'] !== false }
}
export function parseGitWrite(binary: string, argv: readonly string[]): GitWrite | null {
  const name = binary.split(/[\\/]/).at(-1)
  if (name === 'git') {
    const push = argv.indexOf('push')
    if (push < 0 || argv[0] && !argv[0].startsWith('-') && argv[0] !== 'push') return null
    if (push !== 0) return refuse('Git global options cannot be translated safely.')
    const positional: string[] = []; let upstream = false, force = false
    for (const arg of argv.slice(1)) {
      if (arg === '-u' || arg === '--set-upstream') upstream = true
      else if (['-f', '--force', '--force-with-lease'].includes(arg)) force = true
      else if (arg === '--') continue
      else if (arg.startsWith('-')) return refuse(`Unsupported push option ${arg}.`)
      else positional.push(arg)
    }
    if (positional.length > 2) return refuse('Multiple push refspecs cannot be translated safely.')
    const [remote, refspec] = positional
    if (remote && (remote !== 'origin')) return refuse('Only the project origin can be sent through the gateway.')
    const parts = refspec?.split(':') ?? []
    if (parts.length > 2 || parts.some(part => !part || /[*?~^\s]/.test(part)) || parts.some(part => part.startsWith('refs/') && !part.startsWith('refs/heads/'))) return refuse('Only a single branch push can be translated.')
    const source = parts[0], branch = (parts[1] ?? (source === 'HEAD' ? undefined : source))?.replace(/^refs\/heads\//, '')
    return { kind: 'push', ...(remote ? { remote } : {}), ...(source ? { source } : {}), ...(branch ? { branch } : {}), upstream, force }
  }
  if (name !== 'gh') return null
  const groupIndex = argv.findIndex(arg => arg === 'pr' || arg === 'issue')
  const group = argv[groupIndex], verb = argv[groupIndex + 1]
  if (!(group === 'pr' && ['create', 'edit', 'merge', 'comment', 'review'].includes(verb ?? '') || group === 'issue' && verb === 'comment')) return null
  const tool = group === 'issue' ? 'issue_comment' : `pr_${verb === 'edit' ? 'update' : verb}`
  const refuseForge = (reason: string) => refuse(reason, tool)
  if (groupIndex !== 0) return refuseForge('Forge global options cannot be translated safely.')
  const args: Record<string, string | number | boolean> = {}; let bodyFile: string | undefined, fill = false
  const strings: Record<string, string> = { '--title': 'title', '-t': 'title', '--body': 'body', '-b': 'body', '--base': 'base', '-B': 'base', '--match-head-commit': 'head' }
  const allowed: Record<string, readonly string[]> = { create: ['title', 'body', 'base'], edit: ['title', 'body', 'base'], merge: ['body', 'head'], comment: ['body'], review: ['body'] }
  const rest = argv.slice(groupIndex + 2)
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!, equals = arg.indexOf('='), flag = equals < 0 ? arg : arg.slice(0, equals)
    const key = strings[flag]
    if (key || flag === '--body-file' || flag === '-F') {
      const value = equals < 0 ? rest[++i] : arg.slice(equals + 1)
      if (value === undefined) return refuseForge(`Missing value for ${flag}.`)
      if (key) { if (!allowed[verb!]?.includes(key)) return refuseForge(`Unsupported option ${flag}.`); args[key] = value }
      else { if (value === '-') return refuseForge('Reading a body from stdin is not supported.'); bodyFile = value }
    } else if (verb === 'create' && arg === '--draft') args['draft'] = true
    else if (verb === 'create' && arg === '--fill') fill = true
    else if (verb === 'merge' && ['--squash', '--merge', '--rebase'].includes(arg)) args['method'] = arg.slice(2)
    else if (verb === 'review' && ['--approve', '--request-changes', '--comment', '-a', '-r', '-c'].includes(arg)) args['event'] = ({ '-a': 'approve', '-r': 'request_changes', '-c': 'comment' } as Record<string, string>)[arg] ?? arg.slice(2).replace('-', '_')
    else if (!arg.startsWith('-') && verb !== 'create' && args['number'] === undefined && /^[1-9]\d*$/.test(arg)) args['number'] = Number(arg)
    else return refuseForge(`Unsupported forge argument ${arg}.`)
  }
  return { kind: 'forge', tool, args, ...(bodyFile ? { bodyFile } : {}), ...(fill ? { fill } : {}) }
}
/** Conservative shell tokenization: compound commands are detected but never executed by the host. */
export function parseGitCommand(command: string): GitWrite | null {
  const tokens: string[] = []; let word = '', quote = '', escaped = false, complex = false, started = false
  const flush = () => { if (started) tokens.push(word); word = ''; started = false }
  for (const char of command) {
    if (escaped) { word += char; started = true; escaped = false; continue }
    if (char === '\\' && quote !== "'") { escaped = true; started = true; continue }
    if (quote) { if (char === quote) quote = ''; else { word += char; if (quote === '"' && /[$`]/.test(char)) complex = true } continue }
    if (char === "'" || char === '"') { quote = char; started = true; continue }
    if (/\s/.test(char)) { flush(); continue }
    if (/[;&|<>$`()]/.test(char)) { complex = true; flush(); continue }
    word += char; started = true
  }
  flush()
  for (let i = 0; i < tokens.length; i++) {
    const parsed = parseGitWrite(tokens[i]!, tokens.slice(i + 1))
    if (parsed) return complex || quote || escaped || i !== 0 ? refuse('Compound shell commands cannot be translated safely.', parsed.kind === 'push' ? undefined : parsed.tool) : parsed
  }
  return null
}
