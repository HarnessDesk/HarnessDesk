/** Command-line arguments that keep git reads from running repository-configured programs. */
export const GIT_READ_HARDENING_ARGS: readonly string[] = [
  '--no-optional-locks', '--no-pager',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'diff.external=',
]
