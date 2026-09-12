import type { PluginPermissions } from './capability.js'

/**
 * What a permission set lets a plugin do, as sentences a person can judge.
 *
 * One function, two surfaces, and for a while two implementations. The consent
 * dialog asks someone to approve a grant; the Plugins page tells them what they
 * approved. Each wrote its own sentences, and the page's copy had drifted in
 * two directions at once (#288). It had no wildcard case, so a plugin that had
 * asked to reach *anything* was described as `Reach *` — which reads as a
 * hostname with a typo rather than as the whole internet. And it knew nothing
 * of the browser, simulator, Android, editor or secret grants, so three
 * built-ins that ship with this app — Browser, Android, iOS Simulator, each
 * declaring exactly one of those and nothing else — rendered as "Nothing
 * beyond reading what the agent sends it" while holding some of the strongest
 * permissions the host issues.
 *
 * It lives in the protocol because that is the only package both callers may
 * import. `script/check-layering.mjs` forbids the renderer from reaching the
 * extension plane at all, so the host's copy was never available to the page
 * that needed it, and a second copy was the only way to render the list there.
 *
 * Phrased as capabilities a person can judge, not as the field names they
 * happen to be stored under. Order is the cost of the grant, roughly
 * descending, and it is the same order on both surfaces because it is the
 * same list.
 */
export const describePermissions = (permissions: PluginPermissions): string[] => {
  const out: string[] = []
  // Widened when the browser service grew past click-and-look: a plugin that
  // may drive a page may also read what it logged, what it fetched, and what
  // the DevTools protocol will tell it. Consent has to say so.
  if (permissions.browser) {
    out.push('Open and control a browser on this machine, and read its pages, console and network activity')
  }
  if (permissions.ios) out.push('Control the iOS Simulator on this machine')
  if (permissions.android) out.push('Control Android devices and emulators (adb)')
  // The editor grant is a surface, not a write — and the line says exactly
  // that, because "edit files" beside "Change files in the open project"
  // would read as the same grant twice and teach people to skim both.
  if (permissions.editor) {
    out.push('Open files in the editor and mark them up')
  }
  // Messaging is the half a person would want to know about; the board is
  // state. One line that says both, in the order of what it can cost.
  if (permissions.team) {
    out.push('Message your other conversations, and share their task board')
  }
  // What the grant adds is the desk's part — the seat and the record — not
  // the reach, which is the shell's and gh's; the sentence names the part.
  if (permissions.forge) {
    out.push('Sign pull requests and reviews for the conversation, and put what it published in the transcript')
  }
  if (permissions.workspace.read) out.push('Read files in the open project')
  if (permissions.workspace.write) out.push('Change files in the open project')
  if (permissions.shell) out.push('Run programs on this machine')
  if (permissions.network.hosts.length > 0) {
    out.push(
      permissions.network.hosts.includes('*')
        ? 'Reach any host on the network'
        : `Reach ${permissions.network.hosts.join(', ')}`,
    )
  }
  if (permissions.agents.invoke) out.push('Start and drive agents')
  if (permissions.ui.contribute) out.push('Add panels to the interface')
  for (const secret of permissions.secrets) out.push(`Read the stored secret "${secret}"`)
  return out.length > 0 ? out : ['Nothing beyond running in the plugin host']
}
