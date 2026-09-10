import { resolve, sep } from 'node:path'

import type { PluginPermissions } from '@harnessdesk/protocol'

/**
 * The plugin side of the permission engine.
 *
 * Plugins never receive raw `fs` or `fetch`; they receive handles that consult
 * this first. A plugin therefore cannot widen its own reach at runtime — the
 * only way to gain a capability is for the user to grant it in the manifest.
 */

export class PermissionDenied extends Error {
  constructor(
    readonly capability: string,
    readonly detail: string,
  ) {
    super(`Permission denied: ${capability} — ${detail}`)
    this.name = 'PermissionDenied'
  }
}

const normaliseHost = (value: string): string => value.trim().toLowerCase()

/**
 * A host, and the port written after it if there is one; null for a pattern
 * that is not one. An IPv6 address is bracketed the way a URL writes it, so
 * its own colons are never a port. Anything malformed matches nothing: read
 * loosely, `[::1]evil` and `localhost:` were `[::1]` and `localhost` on every
 * port, wider than anything the manifest said (review, round 1).
 */
const splitHost = (value: string): { readonly name: string; readonly port: string | null } | null => {
  const host = normaliseHost(value)
  if (host.startsWith('[')) {
    const bracketed = /^(\[[0-9a-f:.]+\])(?::(\d+))?$/.exec(host)
    return bracketed ? { name: bracketed[1]!, port: bracketed[2] ?? null } : null
  }
  const parts = host.split(':')
  if (parts.length === 1) return host === '' ? null : { name: host, port: null }
  if (parts.length === 2) {
    const [name, port] = parts as [string, string]
    return name !== '' && /^\d+$/.test(port) ? { name, port } : null
  }
  // More than one colon is an IPv6 address written without its brackets.
  return /^[0-9a-f:.]+$/.test(host) ? { name: `[${host}]`, port: null } : null
}

/** The port a URL leaves out because its scheme implies it. */
const DEFAULT_PORTS: Readonly<Record<string, string>> = { 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443' }

/**
 * Host matching supports a single leading wildcard label (`*.example.com`),
 * which covers the common case without inviting the ambiguity of full globs.
 * A pattern with no port allows every port on its host, and one with a port
 * (`localhost:3000`) allows that port alone.
 */
export const hostAllowed = (allowed: readonly string[], host: string): boolean => {
  const target = splitHost(host)
  if (!target) return false
  return allowed.some((pattern) => {
    const candidate = splitHost(pattern)
    if (!candidate) return false
    if (candidate.port !== null && candidate.port !== target.port) return false
    if (candidate.name === '*') return true
    if (candidate.name.startsWith('*.')) {
      const suffix = candidate.name.slice(1)
      return target.name.endsWith(suffix) && target.name.length > suffix.length
    }
    return candidate.name === target.name
  })
}

/**
 * Contains a path to a root.
 *
 * Resolution happens before comparison so `..` cannot walk out, and the
 * separator check stops `/work` from matching `/workspace`.
 */
export const pathWithin = (root: string, path: string): boolean => {
  /* Resolution is the half that was missing, and it is the half that matters:
     `/work/../etc/passwd` carries the prefix `/work/` and is not in `/work`.
     A string test cannot see that, because the escape is spelled *inside* the
     prefix it is being tested against. */
  const base = resolve(root)
  const target = resolve(path)
  if (target === base) return true
  return target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
}

export class PermissionGate {
  constructor(
    private readonly permissions: PluginPermissions,
    private readonly workspaceRoot: () => string | null,
  ) {}

  assertWorkspaceRead(path: string): void {
    if (!this.permissions.workspace.read) {
      throw new PermissionDenied('workspace.read', 'this plugin cannot read the workspace')
    }
    this.#assertInsideWorkspace(path)
  }

  assertWorkspaceWrite(path: string): void {
    if (!this.permissions.workspace.write) {
      throw new PermissionDenied('workspace.write', 'this plugin cannot write to the workspace')
    }
    this.#assertInsideWorkspace(path)
  }

  assertShell(command: string): void {
    if (!this.permissions.shell) {
      throw new PermissionDenied('shell', `refused to run: ${command.slice(0, 80)}`)
    }
  }

  assertBrowser(): void {
    if (!this.permissions.browser) {
      throw new PermissionDenied('browser', 'this plugin cannot control a browser')
    }
  }

  assertEditor(): void {
    if (!this.permissions.editor) {
      throw new PermissionDenied('editor', 'this plugin cannot open or annotate files in the editor')
    }
  }

  /**
   * Editing a file needs both grants, and the workspace confinement on top.
   *
   * The editor grant opens a surface; it must not become a second road to the
   * disk that skips `workspace.write`. Checked in this order so the message
   * names the grant that is actually missing.
   */
  assertEditorWrite(path: string): void {
    this.assertEditor()
    this.assertWorkspaceWrite(path)
  }

  assertTeam(): void {
    if (!this.permissions.team) {
      throw new PermissionDenied('team', 'this plugin cannot reach the team board or message other conversations')
    }
  }

  assertIos(): void {
    if (!this.permissions.ios) {
      throw new PermissionDenied('ios', 'this plugin cannot control the iOS Simulator')
    }
  }

  assertAndroid(): void {
    if (!this.permissions.android) {
      throw new PermissionDenied('android', 'this plugin cannot control Android devices')
    }
  }

  assertNetwork(url: string): void {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new PermissionDenied('network', `not a valid URL: ${url.slice(0, 80)}`)
    }
    /* `host` carries the port and a manifest names hosts, so `localhost` never
       matched http://localhost:3000 (#21). The port is compared only where a
       pattern names one, and a URL leaves its scheme's own port out, so that
       is put back for the comparison. */
    const port = parsed.port || DEFAULT_PORTS[parsed.protocol] || ''
    if (!hostAllowed(this.permissions.network.hosts, port ? `${parsed.hostname}:${port}` : parsed.hostname)) {
      throw new PermissionDenied('network', `${parsed.host} is not in this plugin's allowed hosts`)
    }
  }

  assertAgentInvoke(): void {
    if (!this.permissions.agents.invoke) {
      throw new PermissionDenied('agents.invoke', 'this plugin cannot invoke agents')
    }
  }

  assertUiContribute(): void {
    if (!this.permissions.ui.contribute) {
      throw new PermissionDenied('ui.contribute', 'this plugin cannot contribute UI')
    }
  }

  assertSecret(name: string): void {
    if (!this.permissions.secrets.includes(name)) {
      throw new PermissionDenied('secrets', `${name} was not granted to this plugin`)
    }
  }

  #assertInsideWorkspace(path: string): void {
    const root = this.workspaceRoot()
    if (!root) {
      throw new PermissionDenied('workspace', 'no workspace is open')
    }
    if (!pathWithin(root, path)) {
      throw new PermissionDenied('workspace', `${path} is outside the open workspace`)
    }
  }
}
