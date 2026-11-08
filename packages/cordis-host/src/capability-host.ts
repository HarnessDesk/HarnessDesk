import { pluginInstanceId, type PluginPermissions } from '@harnessdesk/protocol'

import { ANDROID_METHODS, AndroidDevices, type AndroidMethod } from './android.js'
import {
  fsExists,
  fsList,
  fsRead,
  fsWrite,
  httpFetch,
  shellRun,
  type CapabilityRequest,
  type HttpRequestInit,
  type ShellHost,
  type ShellOptions,
} from './capabilities.js'
import { HostRuntime, type RegisteredPlugin, type WorkspaceState } from './runtime.js'
import { inShellWorkspace } from './shell-workspace.js'
import { ContributionStore } from './store.js'

/**
 * The invocation a capability call belongs to, as the parent minted it: the
 * checkout the host admitted for it. A call with none is background work and
 * runs in the open workspace, as background work in the host always has.
 */
export interface CapabilityLease {
  readonly root?: string
  readonly enterCheckout: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const malformed = (): Error => new Error('That is not a capability request a plugin can make.')

const optionalString = (value: unknown): string | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw malformed()
  return value
}

const optionalNumber = (value: unknown): number | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw malformed()
  return value
}

const httpInit = (value: unknown): HttpRequestInit => {
  if (value === undefined) return {}
  if (!isRecord(value)) throw malformed()
  const headers = value['headers']
  if (headers !== undefined && (!isRecord(headers) || Object.values(headers).some((one) => typeof one !== 'string'))) throw malformed()
  const method = optionalString(value['method'])
  const body = optionalString(value['body'])
  const timeoutMs = optionalNumber(value['timeoutMs'])
  return {
    ...(method === undefined ? {} : { method }),
    ...(headers === undefined ? {} : { headers: headers as Record<string, string> }),
    ...(body === undefined ? {} : { body }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }
}

const shellOptions = (value: unknown): ShellOptions => {
  if (value === undefined) return {}
  if (!isRecord(value)) throw malformed()
  const cwd = optionalString(value['cwd'])
  const timeoutMs = optionalNumber(value['timeoutMs'])
  return { ...(cwd === undefined ? {} : { cwd }), ...(timeoutMs === undefined ? {} : { timeoutMs }) }
}

/**
 * One request from a plugin's process, read as nothing more than it claims:
 * every field is checked here, because the process that sent it runs code
 * the host does not trust.
 */
export const readCapabilityRequest = (value: unknown): CapabilityRequest => {
  if (!isRecord(value)) throw malformed()
  switch (value['kind']) {
    case 'fs': {
      const method = value['method']
      const path = optionalString(value['path'])
      if (method === 'write') {
        if (path === undefined || typeof value['content'] !== 'string') throw malformed()
        return { kind: 'fs', method, path, content: value['content'] }
      }
      if (method !== 'read' && method !== 'list' && method !== 'exists') throw malformed()
      if (path === undefined && method !== 'list') throw malformed()
      return { kind: 'fs', method, ...(path === undefined ? {} : { path }) }
    }
    case 'http': {
      if (typeof value['url'] !== 'string') throw malformed()
      return { kind: 'http', url: value['url'], init: httpInit(value['init']) }
    }
    case 'shell': {
      if (typeof value['command'] !== 'string') throw malformed()
      const args = value['args'] ?? []
      if (!Array.isArray(args) || args.some((one) => typeof one !== 'string')) throw malformed()
      return { kind: 'shell', command: value['command'], args: args as string[], options: shellOptions(value['options']) }
    }
    case 'android': {
      const method = value['method']
      const args = value['args'] ?? []
      if (typeof method !== 'string' || !(ANDROID_METHODS as readonly string[]).includes(method)) throw malformed()
      if (!Array.isArray(args) || args.length > 3) throw malformed()
      // JSON has no `undefined`: an argument left out in the middle arrives as null.
      return { kind: 'android', method, args: args.map((one: unknown) => (one === null ? undefined : one)) }
    }
    default:
      throw malformed()
  }
}

/**
 * A plugin's own reach, served by the parent for the plugin's process.
 *
 * The process runs under the Node permission model with no disk, network or
 * programs of its own (docs/plugin-isolation.md), so `ctx.fs`, `ctx.http`,
 * `ctx.shell` and `ctx.android` arrive here. Each call is checked against
 * the permissions the person agreed to — the host's record, never what the
 * process says — and runs in the checkout of the invocation it belongs to,
 * exactly as the same call made in the host would.
 */
export class PluginCapabilityHost {
  readonly #runtime = new HostRuntime(new ContributionStore())
  readonly #owner: RegisteredPlugin
  readonly #devices: AndroidDevices

  constructor(
    pluginId: string,
    permissions: PluginPermissions,
    private readonly shellHost: () => ShellHost = () => ({}),
  ) {
    this.#owner = this.#runtime.register(pluginInstanceId(`${pluginId}#installed`), permissions).entry
    this.#devices = new AndroidDevices(() => this.#owner.gate.assertAndroid())
  }

  setWorkspace(state: WorkspaceState): void {
    this.#runtime.setWorkspace(state)
  }

  serve(raw: unknown, lease: CapabilityLease | undefined): Promise<unknown> {
    const request = readCapabilityRequest(raw)
    const root = lease?.root
    return this.#runtime.withContextWorkspace(root, () => inShellWorkspace(root, () => this.#run(request)), lease?.enterCheckout ?? false)
  }

  async #run(request: CapabilityRequest): Promise<unknown> {
    const runtime = this.#runtime
    const owner = this.#owner
    switch (request.kind) {
      case 'fs':
        switch (request.method) {
          case 'read': return fsRead(runtime, owner, request.path!)
          case 'write': return fsWrite(runtime, owner, request.path, request.content)
          case 'list': return fsList(runtime, owner, request.path)
          case 'exists': return fsExists(runtime, owner, request.path!)
        }
        break
      case 'http':
        return httpFetch(owner, request.url, request.init)
      case 'shell':
        return shellRun(runtime, owner, request.command, request.args, request.options, this.shellHost())
      case 'android': {
        const verb = this.#devices[request.method as AndroidMethod] as (...args: unknown[]) => Promise<unknown>
        return verb.apply(this.#devices, [...request.args])
      }
    }
    throw malformed()
  }
}
