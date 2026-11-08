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
/** I/O belongs to the caller. The resolver reads alias.<verb> through real git. */
export type GitAliasResolver = (verb: string, globals: readonly string[]) => string | null | undefined
/** Built-ins win over aliases, just as they do in git. Cache only that command
 * inventory; aliases are checkout-local and must be read at each invocation. */
export function gitAliasResolver(read: (args: readonly string[]) => string | undefined): GitAliasResolver {
  let builtins: Set<string> | undefined
  return (verb, globals) => {
    builtins ??= new Set((read(['--list-cmds=builtins,others']) ?? '').split(/\s+/))
    if (builtins.has(verb)) return null
    return read([...globals, 'config', '--get', `alias.${verb}`])
  }
}
const globalValues = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source'])
const globalFlags = new Set(['-p', '-P', '--paginate', '--no-pager', '--bare', '--no-replace-objects', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-optional-locks', '--no-lazy-fetch', '--no-advice', '--no-refresh', '--no-auto-gc'])
/** Consume values before looking for a verb or a help word. Unknown options
 * cannot be native reads: git would reject them before running any verb. */
export function parseGitWrite(binary: string, argv: readonly string[], alias?: GitAliasResolver, depth = 0): GitWrite | null {
  const name = binary.split(/[\\/]/).at(-1)
  if (name === 'git') {
    let index = 0, overrides = false
    const globals: string[] = []
    while (argv[index]?.startsWith('-')) {
      const option = argv[index++]!
      globals.push(option)
      if (['--help', '-h', '--version', '-v', '--html-path', '--man-path', '--info-path'].includes(option)) return null
      if (globalValues.has(option)) { globals.push(argv[index++] ?? ''); overrides = true }
      else if (/^-(?:C|c).+/.test(option) || /^--(?:git-dir|work-tree|namespace|super-prefix|config-env|attr-source)=/.test(option)) overrides = true
      // --exec-path has an optional value only in the = form. Without it git
      // prints the path and exits, even when more words follow.
      else if (option === '--exec-path' || option.startsWith('--list-cmds=')) return null
      else if (!globalFlags.has(option) && !option.startsWith('--exec-path=')) return refuse('Unsupported Git global option.')
    }
    const verb = argv[index]
    if (!verb) return null
    if (verb !== 'push') {
      if (['send-pack', 'http-push'].includes(verb) || ['subtree', 'lfs'].includes(verb) && argv[index + 1] === 'push') return refuse('This Git transport cannot be translated safely.')
      const inline = globals.flatMap((arg, i) => arg === '-c' ? [globals[i + 1] ?? ''] : arg.startsWith('-c') ? [arg.slice(2)] : [])
        .findLast(value => value.startsWith(`alias.${verb}=`))?.slice(`alias.${verb}=`.length)
      const resolved = alias?.(verb, globals)
      const expansion = resolved === undefined ? inline : resolved
      if (expansion == null) return null
      if (expansion.trimStart().startsWith('!') || depth >= 8) return refuse('A shell Git alias cannot be translated safely.')
      const words = shellWords(expansion)
      if (!words || words.complex) return refuse('The Git alias cannot be translated safely.')
      const expanded = parseGitWrite('git', [...words.tokens, ...argv.slice(index + 1)], alias, depth + 1)
      return expanded && overrides ? refuse('Git global options cannot be translated safely.') : expanded
    }
    const positional: string[] = []; let upstream = false, force = false, unsupported: string | undefined, options = true
    for (let i = index + 1; i < argv.length; i++) {
      const arg = argv[i]!, flag = arg.split('=')[0]!
      if (options && arg === '--') { options = false; continue }
      if (options && ['-o', '--push-option', '--repo', '--receive-pack', '--exec'].includes(flag)) {
        if (!arg.includes('=')) i++
        unsupported = arg; continue
      }
      if (options && /^-o.+/.test(arg)) { unsupported = arg; continue }
      if (options && ['--dry-run', '-n', '--help', '-h'].includes(arg)) return null
      if (options && (arg === '-u' || arg === '--set-upstream')) upstream = true
      else if (options && ['-f', '--force', '--force-with-lease'].includes(arg)) force = true
      else if (options && arg.startsWith('-')) unsupported = arg
      else positional.push(arg)
    }
    if (overrides) return refuse('Git global options cannot be translated safely.')
    if (unsupported) return refuse(`Unsupported push option ${unsupported}.`)
    if (positional.length > 2) return refuse('Multiple push refspecs cannot be translated safely.')
    const [remote, refspec] = positional
    if (remote && remote !== 'origin') return refuse('Only the project origin can be sent through the gateway.')
    const parts = refspec?.split(':') ?? []
    if (parts.length > 2 || parts.some(part => !part || /[*?~^\s]/.test(part)) || parts.some(part => part.startsWith('refs/') && !part.startsWith('refs/heads/'))) return refuse('Only a single branch push can be translated.')
    const source = parts[0], branch = (parts[1] ?? (source === 'HEAD' ? undefined : source))?.replace(/^refs\/heads\//, '')
    return { kind: 'push', ...(remote ? { remote } : {}), ...(source ? { source } : {}), ...(branch ? { branch } : {}), upstream, force }
  }
  if (name !== 'gh') return null
  const valueFlags = new Set(['--subject', '-t', '--title', '-b', '--body', '-F', '--body-file', '-R', '--repo', '-B', '--base', '--match-head-commit', '-X', '--method', '-p', '--preview', '-f', '--raw-field', '--field', '--input', '-H', '--header', '--hostname', '--jq', '-q', '--template', '--author', '--assignee', '--reviewer', '--label', '--milestone', '--project'])
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--') break
    if (valueFlags.has(arg)) { i++; continue }
    if (arg === '-h' || arg === '--help') return null
  }
  if (argv[0] === 'api') return argv.some(arg => arg.startsWith('-f') || arg.startsWith('-F') || /^(?:--field|--raw-field|--input)(?:=|$)/.test(arg)) || argv.some((arg, i) => (arg === '-X' || arg === '--method') && argv[i + 1]?.toUpperCase() !== 'GET' || /^(?:-X|--method=)(?!GET$).+/.test(arg)) ? refuse('Forge API writes cannot be translated safely.') : null
  if (!['pr', 'issue', 'release', 'repo', 'search', 'auth', 'version', 'help', 'status', 'browse', 'run', 'workflow', 'extension', 'label', 'project', 'cache', 'codespace', 'gist', 'gpg-key', 'ssh-key', 'ruleset'].includes(argv[0] ?? '')) return refuse('An unresolved forge alias cannot be translated safely.')
  const groupIndex = argv.findIndex(arg => arg === 'pr' || arg === 'issue')
  const group = argv[groupIndex], verb = argv[groupIndex + 1]
  if (!(group === 'pr' && ['create', 'edit', 'merge', 'comment', 'review'].includes(verb ?? '') || group === 'issue' && verb === 'comment')) {
    return ['view', 'list', 'status', 'diff', 'checks'].includes(argv[1] ?? '') || ['version', 'help', 'status', 'search', 'browse'].includes(argv[0] ?? '') ? null : refuse('This forge mutation cannot be translated safely.')
  }
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
    else if (verb === 'review' && ['--approve', '--request-changes', '--comment', '-a', '-r', '-c'].includes(arg)) args['event'] = ({ '-a': 'approve', '-r': 'request-changes', '-c': 'comment' } as Record<string, string>)[arg] ?? arg.slice(2)
    else if (!arg.startsWith('-') && verb !== 'create' && args['number'] === undefined && /^[1-9]\d*$/.test(arg)) args['number'] = Number(arg)
    else return refuseForge(`Unsupported forge argument ${arg}.`)
  }
  return { kind: 'forge', tool, args, ...(bodyFile ? { bodyFile } : {}), ...(fill ? { fill } : {}) }
}
/** Parse argv without evaluating substitutions. Shell wrappers are recursively
 * unwrapped; a simple leading cd is allowed only for recognition (never exec). */
export function parseGitCommand(command: string, depth = 0, alias?: GitAliasResolver): GitWrite | null { return commandWrite(command, depth, alias).write }
/** Display uses precisely the same wrapper recognition as steering. */
export function unwrapGitCommand(command: string, depth = 0): string {
  if (depth > 8) return command
  const words = shellWords(command), script = words && !words.complex && shellScript(words.tokens)
  if (typeof script === 'string') return unwrapGitCommand(script, depth + 1)
  return depth > 0 && words && !words.complex ? words.tokens.map(word => /^[A-Za-z0-9_./:@%+=,-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`).join(' ') : command
}
/** Leading directory changes are interpreted only as paths by the host. */
export function gitCommandDirectories(command: string): readonly string[] {
  const text = unwrapGitCommand(command), cd = /^\s*cd\s+('[^']*'|"[^"$`]*"|[^\s;&|]+)\s*&&\s*([\s\S]+)$/.exec(text)
  if (!cd) return []
  const path = shellWords(cd[1]!)?.tokens[0]
  return path === undefined ? [] : [path, ...gitCommandDirectories(cd[2]!)]
}
/** Observation alone may inspect one concrete command with harmless output
 * redirects / echo suffixes. This never authorizes translating a compound. */
export function parseCompletedGitCommand(command: string, alias?: GitAliasResolver): GitWrite | null {
  const text = unwrapGitCommand(command)
  const simple = text.replace(/\s+&&\s+echo(?:\s+[^;&|<>$`()\n]*)?$/, '').replace(/\s+2>\s*&1\s*$/, '')
  return parseGitCommand(simple, 0, alias)
}
function shellScript(tokens: readonly string[]): string | undefined {
  if (!/^(?:.*\/)?(?:ba|z|k|da|fi)?sh$/.test(tokens[0] ?? '')) return undefined
  for (let i = 1; i < tokens.length; i++) {
    const flag = tokens[i]!
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(flag)) return tokens[i + 1]
    if (!/^-[a-zA-Z]+$/.test(flag) && !['--login', '--noprofile', '--norc', '--posix'].includes(flag)) return undefined
  }
  return undefined
}
/** The executable inside shell wrappers, rather than the shell's own path. */
export function gitCommandUsesAbsoluteBinary(command: string): boolean { return /^(?:\/|[A-Za-z]:[\\/])/.test(commandWrite(command, 0).binary ?? '') }
function shellWords(command: string): { tokens: string[]; complex: boolean } | null {
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
  return quote || escaped ? null : { tokens, complex }
}
function commandWrite(command: string, depth: number, alias?: GitAliasResolver): { write: GitWrite | null; binary?: string } {
  if (depth > 8) return { write: refuse('Too many shell wrappers.') }
  const cd = /^\s*cd\s+(?:'[^']*'|"[^"$`]*"|[^\s;&|]+)\s*&&\s*([\s\S]+)$/.exec(command)
  if (cd) return commandWrite(cd[1]!, depth + 1, alias)
  const words = shellWords(command)
  if (!words) return { write: /\b(?:git|gh)\b.*\b(?:push|send-pack|create|edit|merge|comment|review)\b/.test(command) ? refuse('The shell script cannot be translated safely.') : null }
  const { tokens, complex } = words, script = !complex && shellScript(tokens)
  if (typeof script === 'string') return commandWrite(script, depth + 1, alias)
  if (/^(?:.*\/)?(?:ba|z|k|da|fi)?sh$/.test(tokens[0] ?? '') && /\b(?:git|gh)\b.*\b(?:push|send-pack|create|edit|merge|comment|review)\b/.test(command)) return { write: refuse('The shell script cannot be translated safely.') }
  // Prose mentioning git is not an invocation. Environment prefixes and
  // compound invocations are refused, rather than silently passed through.
  if (['echo', 'printf', 'man'].includes(tokens[0] ?? '')) return { write: null }
  for (let i = 0; i < tokens.length; i++) {
    const parsed = parseGitWrite(tokens[i]!, tokens.slice(i + 1), alias)
    if (parsed) return { write: complex || i !== 0 ? refuse('Compound shell commands cannot be translated safely.', parsed.kind === 'push' ? undefined : parsed.tool) : parsed, binary: tokens[i] }
  }
  return { write: null }
}

/** Durable text must never retain URL userinfo or a pasted body. */
export const redactGitCommand = (command: string): string => command
  .replace(/(https?:\/\/)[^\s/'"]+@/g, '$1[redacted]@')
  .replace(/((?:--body|-b)(?:=|\s+))(?:'[^']*'|"[^"\n]*"|\S+)/g, '$1[body omitted]')
