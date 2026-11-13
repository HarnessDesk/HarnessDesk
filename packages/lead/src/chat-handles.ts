import type { LeadPermissionCall } from './permissions.js'

/**
 * Short names for the chats the Lead sees.
 *
 * A model copies a 40-character chat id badly: it mistypes one, swaps two, and pays for every one it reads in a list.
 * The host gives each chat it shows the Lead a handle instead, from the project and the agent or model (`web-opus`,
 * `web-opus-2`), unique on the desk. A handle is given once: it never moves to another chat, and one whose chat is gone
 * is never given again. The journal holds the map, so a restart keeps every handle; each base keeps the last number it
 * gave, so a handle dropped from the bounded map still cannot come back on another chat.
 *
 * A handle is only a name. The host turns it into the chat's id before anything is decided, so every permission and
 * scope check sees the id, and a handle reaches nothing its id could not.
 */
export const LEAD_CHAT_HANDLE = /^[a-z][a-z0-9-]{0,31}$/
/** What a base may be: a lowercase name that does not itself end in a number, so `web-opus` numbered 2 and a base
 * `web-opus-2` can never both exist. */
const BASE = /^[a-z](?:[a-z0-9-]{0,25}[a-z0-9])?$/
export const LEAD_CHAT_HANDLES = Object.freeze({
  /** Handles the map keeps, newest last. An older one drops out and stops resolving; its number is never given again. */
  entries: 512,
  /** Bases the map remembers numbers for. Past it, a chat on a new base gets no handle and is named by its id. */
  bases: 256,
  /** Chats one journal record may name. */
  perRecord: 64,
  /** The highest number a base gives. */
  number: 9999,
})
export interface LeadChatHandleEntry { readonly id: string; readonly handle: string }
export interface LeadChatHandles {
  readonly entries: readonly LeadChatHandleEntry[]
  /** The last number each base gave: the never-recycled guarantee, kept apart from the bounded entries. */
  readonly last: Readonly<Record<string, number>>
}
/** One chat a journal record names: its id, the base and the number it took. */
export interface LeadChatNaming { readonly id: string; readonly base: string; readonly n: number }
export const initialLeadChatHandles = (): LeadChatHandles => ({ entries: [], last: {} })
export const leadChatHandleText = (base: string, n: number): string => n === 1 ? base : `${base}-${n}`
export const leadChatHandleValid = (value: unknown): value is string => typeof value === 'string' && LEAD_CHAT_HANDLE.test(value) && value !== 'lead'
export const leadChatBaseValid = (value: unknown): value is string => typeof value === 'string' && BASE.test(value) && !/-[0-9]+$/.test(value) && value !== 'lead'
/** A chat id: `runtime:session`, as the desk writes it. Anything else the Lead passes is read as a handle. */
export const leadChatIdShaped = (value: string): boolean => { const at = value.indexOf(':'); return at > 0 && at < value.length - 1 }

const words = (value: string): string[] => value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
const slug = (value: string, max: number): string => {
  let out = words(value).join('-').replace(/^[^a-z]+/, '').slice(0, max).replace(/-+$/, '')
  while (/-[0-9]+$/.test(out)) out = out.replace(/-[0-9]+$/, '')
  return out
}
/** Families a model id often opens with: the word after one says which model it is (`claude-opus-4` is `opus`). */
const FAMILY = new Set(['claude', 'gpt', 'gemini', 'grok', 'llama', 'mistral', 'qwen', 'deepseek', 'kimi', 'glm'])
/** The model's own word: its first letter-led word, or the next one after a family word. Versions and dates drop. */
const modelWord = (model: string): string => {
  const named = words(model).filter(word => /^[a-z]/.test(word))
  return (named.length > 1 && FAMILY.has(named[0]!) ? named[1] : named[0]) ?? ''
}
/**
 * The base a chat's handle is built from: the project folder's name, then the model's word, or the agent's id when the
 * desk does not know the model. `web` + `claude-opus-4-5` is `web-opus`. Always a valid base, never `lead`.
 */
export const leadChatHandleBase = (input: { readonly project: string; readonly agent: string; readonly model?: string | null }): string => {
  const folder = input.project.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
  const project = slug(folder, 14) || 'chat'
  const agent = (input.model ? slug(modelWord(input.model), 12) : '') || slug(input.agent, 12) || 'agent'
  const base = `${project}-${agent}`.slice(0, 27).replace(/-+$/, '')
  return leadChatBaseValid(base) ? base : 'chat-agent'
}
export const leadChatHandleOf = (handles: LeadChatHandles, id: string): string | undefined =>
  handles.entries.find(entry => entry.id === id)?.handle
/**
 * Names for the chats not yet named, in order: each takes its base's next number. A chat already named keeps its
 * handle and is left out; so is one whose base is full or new past the base limit. Pure, so the journal's reducer
 * checks a record against the same rule.
 */
export const leadChatNamings = (handles: LeadChatHandles, wanted: readonly { readonly id: string; readonly base: string }[]): readonly LeadChatNaming[] => {
  const last = { ...handles.last }, named = new Set(handles.entries.map(entry => entry.id)), out: LeadChatNaming[] = []
  for (const { id, base } of wanted) {
    if (out.length >= LEAD_CHAT_HANDLES.perRecord) break
    if (named.has(id) || !leadChatBaseValid(base) || !leadChatIdShaped(id) || id.length > 300) continue
    if (!Object.hasOwn(last, base) && Object.keys(last).length >= LEAD_CHAT_HANDLES.bases) continue
    const n = (last[base] ?? 0) + 1
    if (n > LEAD_CHAT_HANDLES.number) continue
    last[base] = n; named.add(id); out.push({ id, base, n })
  }
  return out
}
/** The map after a record's namings. Throws when a naming breaks the rule: a chat named twice, a number out of turn. */
export const leadChatHandlesAfter = (handles: LeadChatHandles, namings: readonly LeadChatNaming[]): LeadChatHandles => {
  const last = { ...handles.last }, entries = [...handles.entries]
  for (const { id, base, n } of namings) {
    if (!leadChatBaseValid(base) || !leadChatIdShaped(id) || id.length > 300 || entries.some(entry => entry.id === id) || n !== (last[base] ?? 0) + 1 ||
      n > LEAD_CHAT_HANDLES.number || !Object.hasOwn(last, base) && Object.keys(last).length >= LEAD_CHAT_HANDLES.bases) throw new Error('lead-chat-handle')
    last[base] = n
    entries.push({ id, handle: leadChatHandleText(base, n) })
  }
  return { entries: entries.slice(-LEAD_CHAT_HANDLES.entries), last }
}
/** Checks a stored map: valid entries, unique ids and handles, every handle within its base's last number. */
export const parseLeadChatHandles = (value: unknown): LeadChatHandles => {
  const fail = (): never => { throw new Error('lead-chat-handle') }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== 'entries,last') fail()
  const source = value as { entries: unknown; last: unknown }
  if (!Array.isArray(source.entries) || source.entries.length > LEAD_CHAT_HANDLES.entries) fail()
  if (!source.last || typeof source.last !== 'object' || Array.isArray(source.last)) fail()
  const last = source.last as Record<string, unknown>
  if (Object.keys(last).length > LEAD_CHAT_HANDLES.bases) fail()
  for (const [base, n] of Object.entries(last)) if (!leadChatBaseValid(base) || !Number.isSafeInteger(n) || (n as number) < 1 || (n as number) > LEAD_CHAT_HANDLES.number) fail()
  const entries = (source.entries as unknown[]).map(entry => {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).sort().join() !== 'handle,id') fail()
    const { id, handle } = entry as { id: unknown; handle: unknown }
    if (typeof id !== 'string' || !leadChatIdShaped(id) || id.length > 300 || !leadChatHandleValid(handle)) fail()
    const match = /^(.*?)(?:-([0-9]+))?$/.exec(handle as string)!
    const base = match[2] && Object.hasOwn(last, match[1]!) ? match[1]! : handle as string
    const n = base === handle ? 1 : Number(match[2])
    if (!Object.hasOwn(last, base) || (last[base] as number) < n) fail()
    return { id: id as string, handle: handle as string }
  })
  if (new Set(entries.map(entry => entry.id)).size !== entries.length || new Set(entries.map(entry => entry.handle)).size !== entries.length) fail()
  return { entries, last: { ...last } as Record<string, number> }
}
export class LeadChatUnknownError extends Error {
  readonly wireCode = 'lead-chat-unknown'
  constructor() { super('lead-chat-unknown') }
}
/** The chat a reference names: an id stays itself, a handle becomes its chat's id. A handle nobody holds is refused. */
export const leadChatIdFor = (handles: LeadChatHandles, ref: string): string => {
  if (leadChatIdShaped(ref)) return ref
  const entry = handles.entries.find(one => one.handle === ref)
  if (!entry) throw new LeadChatUnknownError()
  return entry.id
}
const CHAT_REFS: Readonly<Record<string, readonly string[]>> = { 'lead/chat/read': ['id'], 'lead/chat/send': ['id'], 'lead/chat/stop': ['id'], 'lead/chat/start': ['moveFrom'] }
/**
 * The call with every chat it names as an id: what the host authorises and dispatches. The same object when it named
 * none by handle, so a caller can tell a resolved call from an untouched one.
 */
export const resolveLeadChatCall = (call: LeadPermissionCall, handles: LeadChatHandles): LeadPermissionCall => {
  const keys = CHAT_REFS[call.method]
  if (!keys) return call
  const params = call.params as Record<string, unknown>
  let changed: Record<string, unknown> | null = null
  for (const key of keys) {
    const ref = params[key]
    if (typeof ref !== 'string') continue
    const id = leadChatIdFor(handles, ref)
    if (id !== ref) (changed ??= { ...params })[key] = id
  }
  return changed ? { method: call.method, params: changed } as LeadPermissionCall : call
}
/** What the Lead is told for a handle the desk does not hold. Only a handle-shaped reference is echoed back. */
export const leadChatUnknownText = (ref: unknown): string =>
  `Tool failed: no chat ${typeof ref === 'string' && LEAD_CHAT_HANDLE.test(ref) ? `has the handle "${ref}"` : 'has that handle'}. Call chat_list for each chat's handle; never guess one.`
