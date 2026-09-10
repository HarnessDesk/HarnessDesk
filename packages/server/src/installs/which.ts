import { accessSync, constants, statSync } from 'node:fs'
import { posix, win32 } from 'node:path'

/**
 * Where a command on PATH actually is, or null.
 *
 * Two copies of this existed — `agent-registry.ts` and `acp-registry.ts`,
 * byte for byte the same — and both ran `/usr/bin/which`, which is an absolute
 * POSIX path in a project that ships a Windows build. On Windows the spawn
 * throws `ENOENT`, the `catch` answers `null`, and every agent reads as *not
 * installed*: "Needs npx (Node.js), which is not on PATH" beside a working
 * Node. It is not only Windows. `which` lives at `/bin/which` on some Linux
 * distributions and is absent from minimal images altogether, and each of
 * those reads the same way — an agent the machine has, reported missing, with
 * a sentence that sends the reader to install what they already installed.
 *
 * So this asks no binary anything. PATH is a list of directories and the
 * question is which of them holds the file; walking it is a few `stat` calls,
 * needs nothing installed, behaves the same on every platform, and cannot be
 * confused by a `which` that reads the user's shell configuration.
 *
 * PATH is read at call time, deliberately: `applyLoginShellPath` rewrites
 * `process.env.PATH` once the login shell answers, and a value captured before
 * that is the launchd PATH this app already had to work around.
 *
 * `platform` is a parameter for the reason `readChannel`'s is: this is a fix
 * for a platform the person writing it is not on, and a Windows rule that can
 * only be exercised on Windows is a Windows rule nothing checks. Callers pass
 * nothing and get this machine's.
 */
export interface WhichOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  /** Whether a candidate exists and can be run. Injected only by tests. */
  readonly runnable?: (path: string) => boolean
}

export const whichOnPath = (command: string, options: WhichOptions = {}): string | null => {
  if (command.length === 0) return null
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const runnable = options.runnable ?? ((path: string) => isRunnable(path, platform))

  /* A command with a path in it is not a PATH question. `execFile` would run
     it as given, so this answers as given too rather than searching for a
     name that has a separator in it and never matching. */
  if (win32.isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return runnable(command) ? command : null
  }

  /* `;` on Windows and `:` elsewhere, taken from the asked-for platform
     rather than from this process — the separator is half of what makes a
     PATH a PATH, and reading the host's would parse a Windows PATH by the
     rules of the machine doing the parsing. */
  const separator = platform === 'win32' ? ';' : ':'
  /* And the path rules, from the same place. `join` is the host's, so on a
     Mac it joins `C:\\tools` and `npx.cmd` with a forward slash — which is
     right in production, where the Windows branch only ever runs on Windows,
     and wrong for a test that asks about Windows from anywhere else. Taking
     both from the platform makes the answer depend on the question rather
     than on the machine. Found by writing that test. */
  const rules = platform === 'win32' ? win32 : posix
  for (const dir of (env['PATH'] ?? '').split(separator)) {
    if (dir.length === 0) continue
    for (const suffix of suffixes(env, platform, command)) {
      const candidate = rules.join(dir, `${command}${suffix}`)
      if (runnable(candidate)) return candidate
    }
  }
  return null
}

/**
 * What Windows appends before a name is executable at all.
 *
 * `npx` on Windows is `npx.cmd`; a PATH walk that only tried the bare name
 * would find nothing and be the same bug in a new spelling.
 *
 * **The bare name is not tried first, and usually not at all.** An official
 * Node install on Windows puts *both* `npx` — a POSIX shell script, there for
 * Git Bash — and `npx.cmd` in the same directory, and Windows has no execute
 * bit to tell them apart. Trying the empty suffix first returns the shell
 * script, which `CreateProcess` cannot run: *"%1 is not a valid Win32
 * application"*. So the rule is cmd.exe's own — a name that already carries a
 * PATHEXT extension is taken as written, and a name without one is only ever
 * tried with an extension. Review found this; the first version had the
 * empty suffix at the front and a test that asserted it belonged there.
 *
 * It also settles the other half: `whichOnPath('README.md')` cannot resolve
 * to a file that merely exists, because `.md` is not in PATHEXT and the bare
 * name is never tried.
 */
const suffixes = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform, command: string): readonly string[] => {
  if (platform !== 'win32') return ['']
  const known = (env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const already = known.some((one) => command.toLowerCase().endsWith(one.toLowerCase()))
  return already ? [''] : known
}

const isRunnable = (path: string, platform: NodeJS.Platform): boolean => {
  try {
    if (!statSync(path).isFile()) return false
  } catch {
    return false
  }
  // Windows has no execute bit; being the right kind of file is the whole test.
  if (platform === 'win32') return true
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}
