/**
 * Git, run by the host in a checkout an agent can write to (#1074).
 *
 * A repository's own configuration can name programs git runs on its own:
 * hooks, a filesystem monitor, a signing program, an ssh command. An agent
 * that can write the checkout's `.git` — any agent whose runtime has no
 * sandbox, or one handed a repository somebody else prepared — can point any
 * of them at a script of its own, and the next git the host runs there would
 * run that script with the host's full access. So every git the host runs in
 * such a checkout carries these overrides, which are read at command-line
 * precedence: above the repository's configuration and above anything it
 * includes, and inherited by any git that git starts in turn.
 *
 * This is the floor for every host git helper. The commit the host makes for
 * an agent (`card-commit.ts`) goes further: no system or global
 * configuration, and every filter driver the configuration defines switched
 * off by name, because a filter is a program `git add` runs over file
 * contents.
 */
export const HARDENED_GIT_CONFIG: readonly string[] = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.sshCommand=ssh',
  '-c', 'commit.gpgSign=false',
  '-c', 'tag.gpgSign=false',
]
