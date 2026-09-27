/**
 * Select scenes from one rig take.
 *
 * The context rig adds three seats and their newest conversations. It is only
 * safe for the context-panel photographs: a normal `--all` must remain the
 * established twelve-seat desk. Keeping that choice outside `shoot.mjs`
 * makes the boundary cheap to exercise without launching Electron.
 */
export const selectScenes = ({ all, context, names, requested }) => {
  if (!all) return requested
  return context ? names.filter((name) => name.startsWith('ring-')) : names
}
