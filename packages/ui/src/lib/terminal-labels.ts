import type { TerminalView } from '../state/layout'
import { shortPath } from './paths'

/** A shell tab is named for its folder, with a stable ordinal for duplicates. */
export const terminalName = (view: TerminalView, occurrence = 1): string => {
  const folder = view.cwd.split('/').filter(Boolean).at(-1) ?? 'Terminal'
  return occurrence > 1 ? `${folder} ${occurrence}` : folder
}

/** Home-shortened path text for a tab or action tooltip, clipped from its middle. */
export const terminalPathTitle = (path: string, home: string): string => {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path
  const visible = shortPath(trimmed || '/', home)
  const maxLength = 32
  if (visible.length <= maxLength) return visible

  const prefix = visible.startsWith('~/') ? '~/' : visible.startsWith('/') ? '/' : ''
  const folder = visible.split('/').filter(Boolean).at(-1) ?? visible
  const shortened = `${prefix}…/${folder}`
  if (shortened.length <= maxLength) return shortened

  const charactersToKeep = maxLength - 1
  const leading = Math.ceil(charactersToKeep / 2)
  const trailing = charactersToKeep - leading
  return `${visible.slice(0, leading)}…${visible.slice(-trailing)}`
}
