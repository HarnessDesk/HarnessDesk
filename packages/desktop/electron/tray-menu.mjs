// A neutral runtime with no observed meter contributes no useful menu row.
// Unknown/new readiness facts stay visible unless they are one of these
// existing, explicitly quiet states; attention must not disappear by default.
// The renderer uses READINESS_LABEL in packages/ui/src/lib/readiness.ts.
const quietDetails = new Set(['Ready', 'Not added', 'Not checked yet'])
const hasReading = agent => typeof agent.left === 'number' && Number.isFinite(agent.left)
const quiet = agent => !agent.needsSignIn && !hasReading(agent) && quietDetails.has(agent.detail)
const withIcon = (item, image) => image ? { ...item, icon: image } : item

/**
 * Six native choices, regardless of the runtime roster. The renderer owns the
 * facts; this only puts readings and account actions in their own menu level.
 * Native images and side effects are supplied by the Electron shell.
 */
export const trayMenuTemplate = (summary, { actions, iconFor, agentIcon }) => {
  const agents = summary.agents
  const unreported = agents.filter(quiet).length
  const usage = agents.filter(agent => !quiet(agent)).map(agent => withIcon({
    label: agent.needsSignIn ? `${agent.name} — Sign in…` : `${agent.name} — ${agent.detail}`,
    click: () => agent.needsSignIn ? actions.signIn(agent.id) : actions.openUsage(agent.id),
  }, agentIcon(agent)))
  if (unreported) usage.push({ label: `No usage reported for ${unreported} runtime${unreported === 1 ? '' : 's'}`, enabled: false })
  if (usage.length === 0) usage.push({ label: 'No usage reported yet', enabled: false })
  usage.push(
    { type: 'separator' },
    withIcon({ label: 'Open Dashboard…', click: () => actions.openUsage() }, iconFor('menu/usage.png')),
  )
  return [
    withIcon({ label: 'Open HarnessDesk', click: actions.show }, iconFor('menu/show.png')),
    withIcon({ label: 'New Session', click: actions.newSession }, iconFor('menu/new-session.png')),
    withIcon({ label: 'Open Folder…', click: actions.openFolder }, iconFor('menu/open-folder.png')),
    { type: 'separator' },
    withIcon({ label: 'Usage', submenu: usage }, iconFor('menu/usage.png')),
    { type: 'separator' },
    withIcon({ label: 'Settings…', click: actions.settings }, iconFor('menu/settings.png')),
    withIcon({ label: 'Quit HarnessDesk', click: actions.quit }, iconFor('menu/quit.png')),
  ]
}
