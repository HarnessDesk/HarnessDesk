import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AccountStatus, ConfigOption, ModelInfo, RuntimeObservations, SkillInfo } from '@harnessdesk/protocol'

export interface RuntimeStartCost {
  readonly readyMs: number
  /** null until the first models answer is known. */
  readonly modelsMs: number | null
}
export interface CachedRuntime extends RuntimeObservations { readonly start?: RuntimeStartCost }

/** Copy display vocabulary explicitly: arbitrary adapter fields never reach disk. */
const accountDisplay = (account: AccountStatus): AccountStatus => ({
  accounts: account.accounts.map(entry => ({
    kind: entry.kind, label: entry.label,
    ...(entry.planType !== undefined ? { planType: entry.planType } : {}),
    ...(entry.anonymous !== undefined ? { anonymous: entry.anonymous } : {}),
  })),
  signInMethods: [],
})
const modelsDisplay = (models: readonly ModelInfo[]): readonly ModelInfo[] => models.map(entry => ({
  id: entry.id, displayName: entry.displayName, supportsImages: entry.supportsImages,
  reasoningLevels: entry.reasoningLevels.map(level => ({ id: level.id, label: level.label })),
  ...(entry.description !== undefined ? { description: entry.description } : {}),
  ...(entry.isDefault !== undefined ? { isDefault: entry.isDefault } : {}),
  ...(entry.hidden !== undefined ? { hidden: entry.hidden } : {}),
  ...(entry.reasoningLevelsShared !== undefined ? { reasoningLevelsShared: entry.reasoningLevelsShared } : {}),
  ...(entry.thinking !== undefined ? { thinking: entry.thinking } : {}),
}))
const optionsDisplay = (options: readonly ConfigOption[]): readonly ConfigOption[] => options.map(entry => ({
  id: entry.id, label: entry.label, type: entry.type, currentValue: entry.currentValue,
  ...(entry.description !== undefined ? { description: entry.description } : {}),
  ...(entry.category !== undefined ? { category: entry.category } : {}),
  ...(entry.disabled !== undefined ? { disabled: entry.disabled } : {}),
  ...(entry.modelStatus !== undefined ? { modelStatus: entry.modelStatus } : {}),
  ...(entry.confirm !== undefined ? { confirm: { title: entry.confirm.title, body: entry.confirm.body, action: entry.confirm.action, ...(entry.confirm.learnMore ? { learnMore: entry.confirm.learnMore } : {}) } } : {}),
  ...(entry.type === 'select' ? { choices: entry.choices.map(choice => ({ value: choice.value, label: choice.label,
    ...(choice.description !== undefined ? { description: choice.description } : {}),
    ...(choice.disabled !== undefined ? { disabled: choice.disabled } : {}),
    ...(choice.risk !== undefined ? { risk: choice.risk } : {}),
    ...(choice.group !== undefined ? { group: choice.group } : {}),
  })) } : {}),
}) as ConfigOption)
const commandsDisplay = (commands: readonly SkillInfo[]): readonly SkillInfo[] => commands.map(entry => ({
  name: entry.name, description: entry.description, enabled: entry.enabled, toggleable: entry.toggleable,
  ...(entry.path !== undefined ? { path: entry.path } : {}),
  ...(entry.scope !== undefined ? { scope: entry.scope } : {}),
  ...(entry.displayName !== undefined ? { displayName: entry.displayName } : {}),
  ...(entry.shortDescription !== undefined ? { shortDescription: entry.shortDescription } : {}),
  ...(entry.iconUrl !== undefined ? { iconUrl: entry.iconUrl } : {}),
  ...(entry.brandColor !== undefined ? { brandColor: entry.brandColor } : {}),
}))
const display = (entry: CachedRuntime): CachedRuntime => ({
  ...(entry.models ? { models: modelsDisplay(entry.models) } : {}),
  ...(entry.options ? { options: optionsDisplay(entry.options) } : {}),
  ...(entry.sessionOptions ? { sessionOptions: optionsDisplay(entry.sessionOptions) } : {}),
  ...(entry.commands ? { commands: commandsDisplay(entry.commands) } : {}),
  ...(entry.account ? { account: accountDisplay(entry.account) } : {}),
  ...(entry.info ? { info: { version: entry.info.version, capabilities: Object.fromEntries(Object.entries(entry.info.capabilities).filter(([, value]) => typeof value === 'boolean')) as typeof entry.info.capabilities } } : {}),
  ...(entry.start ? { start: { readyMs: entry.start.readyMs, modelsMs: entry.start.modelsMs } } : {}),
})

/** Advisory observations, separate from conversation storage, with one atomic write queue. */
export class RuntimeCache {
  readonly #runtimes = new Map<string, CachedRuntime>()
  #writes: Promise<void> = Promise.resolve()
  constructor(readonly path: string, private readonly log: (error: unknown) => void) {}

  async load(): Promise<void> {
    try {
      const file = JSON.parse(await readFile(this.path, 'utf8')) as { version: number; runtimes: Record<string, CachedRuntime> }
      if (file.version !== 1 || !file.runtimes || typeof file.runtimes !== 'object') throw new Error('Unknown runtime cache format.')
      for (const [id, entry] of Object.entries(file.runtimes)) {
        try {
          if (entry.start && (!Number.isFinite(entry.start.readyMs) || entry.start.readyMs < 0 ||
            entry.start.modelsMs !== null && (!Number.isFinite(entry.start.modelsMs) || entry.start.modelsMs < 0))) throw new Error('Invalid start cost.')
          this.#runtimes.set(id, display(entry))
        } catch (error) { this.log(error) }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.log(error)
    }
  }
  get(runtime: string): CachedRuntime { return this.#runtimes.get(runtime) ?? {} }
  update(runtime: string, patch: CachedRuntime): void {
    const entry = display({ ...this.get(runtime), ...patch })
    if (JSON.stringify(entry) === JSON.stringify(this.get(runtime))) return
    this.#runtimes.set(runtime, entry)
    const text = JSON.stringify({ version: 1, runtimes: Object.fromEntries(this.#runtimes) }) + '\n'
    this.#writes = this.#writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, text, { mode: 0o600 })
        await rename(temporary, this.path)
      } finally { await rm(temporary, { force: true }) }
    }).catch(error => this.log(error))
  }
  async flush(): Promise<void> { await this.#writes }
}
