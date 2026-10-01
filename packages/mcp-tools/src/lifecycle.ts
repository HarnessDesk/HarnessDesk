/**
 * Whether this bridge was orphaned before it could record its parent: the
 * agent that spawned it died first, so the parent it reads at start is
 * already the system's reaper and the parent watch would compare against it
 * forever (`kill(1, 0)` answers EPERM, not ESRCH).
 *
 * macOS only, because only there is pid 1 always launchd. On Linux an agent
 * CLI can itself be pid 1, as a container's entrypoint, and a bridge it
 * spawned is then working, not orphaned. There, stdin's end and a later
 * reparenting are what end it.
 */
export const orphanedAtStart = (ppid: number, platform: NodeJS.Platform): boolean =>
  platform === 'darwin' && ppid === 1
