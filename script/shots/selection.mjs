/**
 * Select scenes from one rig take.
 *
 * The context rig adds three seats and their newest conversations. It is only
 * safe for the context-panel photographs: a normal `--all` must remain the
 * established twelve-seat desk. Keeping that choice outside `shoot.mjs`
 * makes the boundary cheap to exercise without launching Electron.
 */
export const selectScenes = ({ all, context, names, requested }) => {
  const selected = all ? (context ? names.filter((name) => name.startsWith('ring-')) : names) : requested
  if (!context) return selected
  const ordinary = selected.filter((name) => !name.startsWith('ring-'))
  if (ordinary.length > 0) {
    throw new Error(`HD_SHOTS_CONTEXT=1 only permits ring-* scenes; refused: ${ordinary.join(', ')}`)
  }
  return selected
}
