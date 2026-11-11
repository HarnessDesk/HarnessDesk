/**
 * The command table as MCP tools.
 *
 * `harnessdesk mcp` serves the same commands the command line runs, one tool
 * per command, generated here from `COMMANDS` so that the two can never say
 * different things. A tool call becomes a command line (`toArgv`), which
 * holds every argument to its schema's type and bounds first: a client need
 * not validate what it sends, so a wait given as the string "7200" is refused
 * here rather than read as a number past the cap. The command line's own
 * parser then validates the line as it would a person's.
 *
 * What a tool leaves out is decided here, once:
 * - the flags every command takes (`--home`, `--json`, `--trace-wire`): the
 *   server fixes the home, always asks for JSON and traces on its own;
 * - `--yes`: the tool call is the confirmation, and the MCP client shows its
 *   own approval prompt;
 * - `--unattended`: never offered. A start from an MCP client is attended, so
 *   a ceiling a seat cannot hold asks the person rather than being raised;
 * - `--watch` and `--until`: streams with no end, which a tool call cannot be.
 */
import { FLAG_KEYS } from './cli.js'
import type { ArgumentDoc, OptionDoc } from './reference.js'

/** The parts of a command the tools are made from: what `script/cli-doc.mjs` reads too. */
export interface CommandLike {
  readonly name: string
  readonly tier: string
  readonly methods: readonly string[]
  readonly flags: readonly string[]
  readonly usage: string
  readonly description: string
  readonly arguments: readonly ArgumentDoc[]
  readonly options: readonly OptionDoc[]
  readonly json: string
}

export interface JsonSchemaObject {
  readonly type: 'object'
  readonly properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly required: readonly string[]
  readonly additionalProperties: false
}

export interface McpTool {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly tier: string
  readonly inputSchema: JsonSchemaObject
  /** The command it runs, as `COMMANDS` names it. */
  readonly command: string
  /** The command line for a call's arguments, without `--json` or `--home`. */
  readonly toArgv: (input: Readonly<Record<string, unknown>>) => string[]
}

/** A tool call whose arguments cannot become a command line. It is answered as a usage error. */
export class ToolInputError extends Error {}

/** Commands with no tool, and why. A command added to `COMMANDS` needs a tool or a line here. */
export const MCP_EXCLUDED: Readonly<Record<string, string>> = {
  watch: 'streams forever; use run_wait or status',
}

/** `run_wait` without a timeout waits this many seconds, and never more than the cap: most clients cut off a tool call that never ends. */
export const MCP_RUN_WAIT_DEFAULT = 600
export const MCP_RUN_WAIT_MAX = 3600

/** Flags no tool offers. */
const DROPPED = new Set(['home', 'json', 'traceWire', 'yes', 'unattended', 'watch', 'until'])
const LISTS = new Set(['input', 'seat'])
const FILES = new Set(['briefFile', 'contextFile'])

interface Slot { readonly key: string; readonly spelling?: string; readonly switch: boolean; readonly required: boolean; readonly value?: string }

/** Reads a usage line: its positional `<tokens>` in order, and each flag with whether it takes a value and whether it is required. */
function slotsOf(command: CommandLike): Slot[] {
  const rest = command.usage.slice(command.name.length)
  const tokens = rest.match(/\[|\]|\||<[a-z]+>|--[a-z-]+|[^\s[\]|]+/g) ?? []
  const slots: Slot[] = []
  let depth = 0
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token === '[') { depth++; continue }
    if (token === ']') { depth--; continue }
    const positional = /^<([a-z]+)>$/.exec(token)
    if (positional) { slots.push({ key: positional[1]!, switch: false, required: depth === 0 }); continue }
    if (!token.startsWith('--')) continue
    const key = FLAG_KEYS[token]
    if (!key) throw new Error(`${command.name}: usage names ${token}, which the parser does not know`)
    const next = tokens[i + 1]
    const value = next && !/^(\[|\]|\||<.*>|--.*)$/.test(next) ? next : undefined
    if (value !== undefined) i++
    slots.push({ key, spelling: token, switch: value === undefined, required: depth === 0, value })
  }
  return slots
}

function propertyOf(command: CommandLike, slot: Slot): Record<string, unknown> {
  const described = slot.spelling
    ? command.options.find(option => option.flag === slot.spelling)?.description
    : command.arguments.find(argument => argument.name === slot.key)?.description
  const description = described === undefined ? {} : { description: described }
  if (!slot.spelling) {
    // A value given by position must not read as a flag.
    return slot.key === 'card'
      ? { type: 'string', pattern: '^[0-9]+$', ...description }
      : { type: 'string', minLength: 1, maxLength: 4096, pattern: '^[^-]', ...description }
  }
  if (slot.switch) return { type: 'boolean', ...description }
  if (LISTS.has(slot.key)) return { type: 'array', items: { type: 'string', pattern: '^[^=]+=.+$' }, maxItems: 32, ...description }
  if (slot.key === 'timeout') return { type: 'integer', minimum: 1, maximum: MCP_RUN_WAIT_MAX, description: `${described ?? ''} From an MCP client: ${MCP_RUN_WAIT_DEFAULT} seconds when left out, and at most ${MCP_RUN_WAIT_MAX}.`.trim() }
  if (slot.key === 'kind') return { type: 'string', enum: ['skill', 'mcp'], ...description }
  if (FILES.has(slot.key)) return { type: 'string', minLength: 1, not: { const: '-' }, ...description }
  return { type: 'string', minLength: 1, maxLength: 4096, ...description }
}

/**
 * One argument, held to its property's schema before it becomes command-line
 * text: the type, an enum, and a number's bounds. A client is not obliged to
 * check what it sends, so this is the gate, not the schema.
 */
function textOf(key: string, schema: Record<string, unknown>, value: unknown): string {
  if (schema['type'] === 'integer') {
    const minimum = schema['minimum'] as number, maximum = schema['maximum'] as number
    if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
      throw new ToolInputError(key === 'timeout'
        ? `timeout is a whole number of seconds from ${minimum} to ${maximum}; call run_wait again to keep waiting`
        : `${key} is a whole number from ${minimum} to ${maximum}`)
    }
    return String(value)
  }
  if (typeof value !== 'string') throw new ToolInputError(`${key} is a string`)
  const allowed = schema['enum'] as readonly string[] | undefined
  if (allowed && !allowed.includes(value)) throw new ToolInputError(`${key} is one of ${allowed.join(', ')}`)
  return value
}

function toolOf(command: CommandLike): McpTool {
  const slots = slotsOf(command).filter(slot => !DROPPED.has(slot.key))
  const positional = slots.filter(slot => !slot.spelling)
  const flags = slots.filter(slot => slot.spelling)
  for (const one of positional) {
    if (flags.some(flag => flag.key === one.key)) throw new Error(`${command.name}: <${one.key}> and --${one.key} would be the same property`)
  }
  const properties: Record<string, Record<string, unknown>> = {}
  for (const slot of slots) properties[slot.key] = propertyOf(command, slot)
  const required = slots.filter(slot => slot.required).map(slot => slot.key)
  const confirms = command.flags.includes('yes')
  const starts = command.tier === 'run' && command.methods.includes('flow/start-goal')
  const description = [
    command.description,
    `Returns: ${command.json}`,
    `Tier: ${command.tier}.${starts ? ' Starting work must be allowed in HarnessDesk Settings › Permissions › MCP clients; refused otherwise.' : ''}`,
  ].join('\n\n')
  const name = command.name.replace(/ /g, '_')
  return {
    name,
    title: command.usage,
    description,
    tier: command.tier,
    command: command.name,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    toArgv: input => {
      const argv = command.name.split(' ')
      for (const key of Object.keys(input)) if (!Object.hasOwn(properties, key)) throw new ToolInputError(`${name} takes no ${key}`)
      for (const slot of positional) {
        const raw = input[slot.key]
        if (raw === undefined || raw === null) continue
        const value = textOf(slot.key, properties[slot.key]!, raw)
        if (value.startsWith('-')) throw new ToolInputError(`${slot.key} cannot start with -`)
        argv.push(value)
      }
      for (const slot of flags) {
        const value = input[slot.key]
        if (value === undefined || value === null) continue
        if (slot.switch) {
          if (typeof value !== 'boolean') throw new ToolInputError(`${slot.key} is true or false`)
          if (value) argv.push(slot.spelling!)
          continue
        }
        if (LISTS.has(slot.key)) {
          if (!Array.isArray(value) || value.length > 32) throw new ToolInputError(`${slot.key} is a list of at most 32 strings`)
          for (const one of value) argv.push(slot.spelling!, textOf(slot.key, { type: 'string' }, one))
          continue
        }
        argv.push(slot.spelling!, textOf(slot.key, properties[slot.key]!, value))
      }
      if (confirms) argv.push('--yes')
      return argv
    },
  }
}

/** One tool for every command but those `MCP_EXCLUDED` names, in the table's order. */
export function toolsOf(commands: readonly CommandLike[]): readonly McpTool[] {
  return commands.filter(command => !Object.hasOwn(MCP_EXCLUDED, command.name)).map(toolOf)
}
