import type { NoticeProps } from '../design'

/** Synthetic Library results shared by the preview wall and Notice board. */
export const libraryNoticeResults: readonly NoticeProps[] = [
  { tone: 'success', title: 'Saved the skill.', actions: [{ label: 'View changes', onSelect: () => {} }] },
  { tone: 'success', title: 'Saved 3 skills.', actions: [{ label: 'View changes', onSelect: () => {} }] },
  { tone: 'danger', title: 'Could not save the skill.', children: 'The Library folder is read-only. Choose a writable folder and try again.', onDismiss: () => {} },
]
