import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

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
    const name = bracketed ? ipv6(bracketed[1]!) : null
    return name ? { name, port: bracketed?.[2] ?? null } : null
  }
  const parts = host.split(':')
  if (parts.length === 1) return host === '' ? null : { name: host, port: null }
  if (parts.length === 2) {
    const [name, port] = parts as [string, string]
    return name !== '' && /^\d+$/.test(port) ? { name, port } : null
  }
  // More than one colon is an IPv6 address written without its brackets.
  const name = /^[0-9a-f:.]+$/.test(host) ? ipv6(`[${host}]`) : null
  return name ? { name, port: null } : null
}

/**
 * An IPv6 address as a URL writes it, `[::1]` for `[0:0:0:0:0:0:0:1]`, or null
 * for one that is not an address. A URL compresses the address, and a pattern
 * written out in full never matched it (review, round 2).
 */
const ipv6 = (bracketed: string): string | null => {
  try {
    return new URL(`http://${bracketed}/`).hostname
  } catch {
    return null
  }
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
 * One path as the disk really spells it, or null where the disk will not say.
 *
 * `realpathSync.native` is asked first because it is the only one of the two
 * that applies `..` *after* following a link, which is the order the kernel
 * uses. With `link -> /etc`, `link/../passwd` is `/passwd`; Node's JS
 * implementation begins by collapsing the string, so it answers as though the
 * `..` applied to the link's lexical parent and never looks at where the link
 * actually goes. Measured both ways on this checkout before choosing.
 *
 * The JS one is kept as a fallback rather than dropped because `.native` is
 * documented to need `/proc` mounted when Node is linked against musl. Losing
 * it there should cost the ordering of `..`, which no caller here can even
 * produce — every one of them resolves before calling — and not cost the
 * following of links, which is the whole point.
 *
 * **Every native failure falls through to the fallback, `ENOENT` included.**
 * This used to return on that code, reading it as "absent for both, so never pay
 * for the second ask" — but `ENOENT` is precisely what musl without `/proc`
 * reports for a path that is plainly there: `uv_fs_realpath` opens the path and
 * reads its name back through `/proc/self/fd`, so the missing thing it names is
 * `/proc`, not the path. Returning on it made the fallback unreachable in the
 * one environment it exists for. `canonical` then saw `null` at every level,
 * climbed to its lexical bailout, and containment was a string comparison
 * again — a symlink out of the workspace reading as inside it, which is #110
 * itself. An absent path is asked about twice now, and the second ask is what it
 * costs: measured here, ~11µs for `.native` to fail and ~15µs more for the JS
 * one to fail behind it, so a write guard on a path four levels below an
 * existing directory goes from 65µs to 128µs. A path that exists is untouched at
 * ~16µs, because the first ask answers it. That is the price of the answer being
 * right on a machine this code cannot detect it is running on.
 */
const resolved = (path: string): string | null => {
  try {
    return realpathSync.native(path)
  } catch {
    try {
      return realpathSync(path)
    } catch {
      return null
    }
  }
}

/**
 * A path as the filesystem sees it: symlinks followed, and any part that does
 * not exist yet carried along unchanged.
 *
 * `resolve` on its own is a *lexical* answer — it rewrites the string and never
 * asks the disk — so a symlink inside the root read as inside it (#110). Asking
 * the disk means touching it, and this runs inside synchronous guards, so two
 * properties are load-bearing and neither is free:
 *
 * - **It stays synchronous**, because the guards are. Measured here,
 *   `realpathSync` on a path whose parent exists costs ~8µs, and every caller
 *   of the gate is about to do a real filesystem operation on the same path —
 *   `ctx.fs.read` reads it, `ctx.fs.write` writes it — so the check costs the
 *   same order as the operation it guards rather than adding a new kind of work.
 * - **It answers for a path that does not exist yet**, which is exactly what a
 *   write guard is asked about. The walk stops at the nearest ancestor that
 *   does exist and re-attaches the missing tail: if that ancestor is inside the
 *   root then anything created below it is too, and a component that does not
 *   exist cannot be a symlink.
 *
 * A path that cannot be resolved at all — a parent no one may read, a link that
 * loops — walks up to the filesystem root and falls back to the lexical answer.
 * That is what this returned before and is no weaker than it: a directory the
 * host cannot traverse is one the plugin cannot traverse either.
 */
const canonical = (path: string): string => {
  /* `resolve` only to make a relative path absolute, and deliberately not on an
     absolute one: it would collapse `..` before any link were followed, which is
     the very reordering `resolved` exists to avoid. */
  let walk = isAbsolute(path) ? path : resolve(path)
  const missing: string[] = []
  for (;;) {
    const real = resolved(walk)
    if (real !== null) return join(real, ...missing.reverse())
    const up = dirname(walk)
    // The root resolves on any sane filesystem; this is the belt to that brace.
    if (up === walk) return resolve(path)
    /* `basename`, not arithmetic on the parent's length: `dirname('/work')` is
       `'/'`, which already ends in a separator, and the slice would take the
       first letter of the name with it. */
    missing.push(basename(walk))
    walk = up
  }
}

/**
 * Contains a path to a root, as the filesystem sees it.
 *
 * Both sides are canonicalised before comparison — `..` collapsed *and*
 * symlinks followed — so neither a `..` nor a link inside the root can walk out
 * of it, and the separator check stops `/work` from matching `/workspace`.
 */
export const pathWithin = (root: string, path: string): boolean => {
  /* Resolution is the half that was missing, and it is the half that matters:
     `/work/../etc/passwd` carries the prefix `/work/` and is not in `/work`.
     A string test cannot see that, because the escape is spelled *inside* the
     prefix it is being tested against — and it cannot see a symlink at all.
     `/work/link` pointing at `/etc` is spelled entirely inside `/work` and is
     not inside `/work` (#110), which no amount of string arithmetic can tell;
     only the filesystem knows, so both sides are asked of it. */
  const base = canonical(root)
  const target = canonical(path)
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

  assertForge(): void {
    if (!this.permissions.forge) {
      throw new PermissionDenied('forge', 'this plugin cannot sign for a conversation or record what it published')
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
