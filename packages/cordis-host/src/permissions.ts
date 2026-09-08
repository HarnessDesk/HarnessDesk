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
 * Host matching supports a single leading wildcard label (`*.example.com`),
 * which covers the common case without inviting the ambiguity of full globs.
 */
export const hostAllowed = (allowed: readonly string[], host: string): boolean => {
  const target = normaliseHost(host)
  return allowed.some((pattern) => {
    const candidate = normaliseHost(pattern)
    if (candidate === '*') return true
    if (candidate.startsWith('*.')) {
      const suffix = candidate.slice(1)
      return target.endsWith(suffix) && target.length > suffix.length
    }
    return candidate === target
  })
}

/**
 * Contains a path to a root.
 *
 * Resolution happens before comparison so `..` cannot walk out, and the
 * separator check stops `/work` from matching `/workspace`.
 */
export const pathWithin = (root: string, path: string): boolean => {
  const base = root.endsWith('/') ? root : `${root}/`
  return path === root || path.startsWith(base)
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
    let host: string
    try {
      host = new URL(url).host
    } catch {
      throw new PermissionDenied('network', `not a valid URL: ${url.slice(0, 80)}`)
    }
    if (!hostAllowed(this.permissions.network.hosts, host)) {
      throw new PermissionDenied('network', `${host} is not in this plugin's allowed hosts`)
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
