import type { ReactNode } from 'react'

import styles from './ComposerTrack.module.css'

export type ComposerTrackName =
  | 'add'
  | 'work-in'
  | 'agent'
  | 'permissions'
  | 'mode'
  | 'extension'
  | 'more'
  | 'context'
  | 'model'
  | 'send'

const wideTrackClass: Record<ComposerTrackName, string> = {
  add: styles.trackAdd!,
  'work-in': styles.trackWorkIn!,
  agent: styles.trackAgent!,
  permissions: styles.trackPermissions!,
  mode: styles.trackMode!,
  extension: styles.trackExtension!,
  more: styles.trackMore!,
  context: styles.trackContext!,
  model: styles.trackModel!,
  send: styles.trackSend!,
}

const foldedTrackClass: Partial<Record<ComposerTrackName, string>> = {
  'work-in': styles.trackWorkInFolded!,
  agent: styles.trackAgentFolded!,
  permissions: styles.trackPermissionsFolded!,
  mode: styles.trackModeFolded!,
  more: styles.trackMoreFolded!,
  model: styles.trackModelFolded!,
}

const tightTrackClass: Partial<Record<ComposerTrackName, string>> = {
  'work-in': styles.trackWorkInTight!,
  agent: styles.trackAgentTight!,
  permissions: styles.trackPermissionsTight!,
  mode: styles.trackModeTight!,
  more: styles.trackMoreTight!,
  model: styles.trackModelTight!,
}

/**
 * A token-sized position in the composer toolbar. Drafts keep their folder
 * picker here, beside worktree choices, on the row's common centre line.
 * No folder choice adds a row or changes the text well's height; folder
 * names may shorten, and their full paths stay in titles.
 */
export const ComposerTrack = ({
  name,
  folded = false,
  tight = false,
  contentSized = false,
  shrinkable = false,
  children,
}: {
  name: ComposerTrackName
  folded?: boolean
  tight?: boolean
  contentSized?: boolean
  shrinkable?: boolean
  children?: ReactNode
}) => (
  <div
    data-slot="composer-track"
    data-composer-track={name}
    data-folded={folded || undefined}
    data-tight={tight || undefined}
    className={`${styles.track} ${wideTrackClass[name]} ${folded ? foldedTrackClass[name] ?? '' : ''} ${tight ? tightTrackClass[name] ?? '' : ''} ${contentSized ? styles.trackContentSized ?? '' : ''} ${shrinkable ? styles.trackShrinkable ?? '' : ''}`}
    style={name === 'context' ? { width: `var(--hd-composer-track-context-${tight ? 'tight' : folded ? 'folded' : 'wide'})` } : undefined}
  >
    {children}
  </div>
)
