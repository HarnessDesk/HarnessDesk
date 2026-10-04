/**
 * What the command reference says that several commands share.
 *
 * `docs/cli.md` is written out of the command table in `cli.ts` by
 * `script/cli-doc.mjs`, and `pnpm verify` fails when the two disagree. Each
 * command's own description, usage, flags, JSON shape and exit codes sit
 * beside it in that table, where the person changing the command is looking.
 * What would otherwise be said twice lives here: the exit codes every command
 * can return, the three flags every command takes, and the flags the two flow
 * commands share.
 *
 * It is written for people driving their own work, in their words. Nothing
 * here is read at run time except by the reference generator.
 */

/** A value a command is given by position, as the reference describes it. */
export interface ArgumentDoc {
  readonly name: string
  readonly description: string
}

/** A flag, as the reference describes it. `value` is how its argument is written. */
export interface OptionDoc {
  readonly flag: string
  readonly value?: string
  readonly description: string
}

/**
 * Every exit code the command line returns, and what it means when it is
 * returned. A command's own `exits` say which of these it can end with and
 * what they mean for it.
 */
export const EXIT_CODES: Readonly<Record<number, string>> = {
  0: 'Done. For `run wait`: the run settled.',
  1: 'The desk answered with an error not covered below, or the command failed for another reason.',
  2: 'Usage: an unknown command or flag, a missing argument, or a spend without a terminal and without `--yes`.',
  3: 'No desk: none is running for this home.',
  4: 'Refused: the desk refused the request (a flow with problems, a tier this desk does not grant, a card not addressed to a person), or its socket failed the ownership check. The desk\'s error code is printed on stderr.',
  5: 'Waiting for a person: `run wait` ended on a person card or a question.',
  6: 'Incompatible: the desk speaks a different protocol version, or is older than this command line and lacks a method the command needs.',
  7: '`run wait`: the run ended stopped or stalled.',
  8: '`run wait`: the timeout passed first.',
  130: 'Interrupted with Ctrl-C (SIGINT).',
  143: 'Terminated (SIGTERM).',
}

/** The three flags every command takes. */
export const GLOBAL_OPTIONS: readonly OptionDoc[] = [
  {
    flag: '--home',
    value: 'DIR',
    description:
      'The desk to talk to, named by the folder it keeps its state in. Without it: `HARNESSDESK_HOME`, then `~/.harnessdesk`.',
  },
  {
    flag: '--json',
    description:
      'Print JSON on stdout instead of text: one object for a command, one object per line for a stream. Errors still go to stderr.',
  },
  {
    flag: '--trace-wire',
    description:
      'Write every message sent to and received from the desk to stderr, one JSON object per line. For finding out what a command did; not a stable format.',
  },
]

/** The positional arguments the Team, run and card commands share. */
export const TEAM_ARGUMENT: ArgumentDoc = {
  name: 'team',
  description: 'A Team\'s id, as `harnessdesk teams` lists it.',
}
export const RUN_ARGUMENT: ArgumentDoc = {
  name: 'run',
  description: 'A run\'s id, as `harnessdesk runs` lists it.',
}
export const CARD_ARGUMENT: ArgumentDoc = {
  name: 'card',
  description: 'A card\'s number on the Team\'s board: a whole number.',
}

/** The positional argument that names a flow, shared by `flow preview` and `flow start`. */
export const FLOW_ARGUMENT: ArgumentDoc = {
  name: 'flow',
  description:
    'The flow to run: a catalogue id such as `review-pr` (see `harnessdesk flows`), or the path of a flow file. A name with a `/` in it, or ending in `.yaml` or `.yml`, is read as a file: the command line reads it and sends the desk its text, and the desk never opens a path you name.',
}

/** The flags `flow preview` and `flow start` share: what a run is given. */
export const FLOW_OPTIONS: readonly OptionDoc[] = [
  {
    flag: '--project',
    value: 'PATH',
    description:
      'The project the flow works in: the path of its folder. Defaults to the Git repository containing the current folder.',
  },
  {
    flag: '--title',
    value: 'TEXT',
    description:
      'The Team\'s sentence: what the work is, in your words. It also fills the flow\'s `title` input when the flow declares one.',
  },
  {
    flag: '--brief-file',
    value: 'PATH',
    description:
      'Read the flow\'s `brief` input from this file, or from standard input with `-`. Refused, with the inputs the flow does declare, when the flow has no `brief` input.',
  },
  {
    flag: '--input',
    value: 'NAME=VALUE',
    description:
      'Give another input the flow declares. Repeat it for more. `NAME=@PATH` reads the value from a file; long text belongs in a file, not on the command line.',
  },
  {
    flag: '--seat',
    value: 'ROLE=RUNTIME[=MODEL][/EFFORT][+thinking]',
    description:
      'Choose who holds a role for this run, written the way a flow file writes a seat (`RUNTIME` is an agent\'s id, as `harnessdesk status --json` lists them under `hello.runtimes`). Repeat it for another role; a comma-separated list gives a role with several cards one seat each. The preview shows each override beside the file\'s own seat.',
  },
  {
    flag: '--unattended',
    description:
      'Start the run unattended, under the same rules as a run a trigger starts: a seat\'s question waits as long as your own unattended-question setting allows and then the run stops, and a seat whose ceiling can only be asked is refused. Without it the run is attended, and its questions and approvals wait for you in the app.',
  },
]

/** The flag that answers a confirmation, shared by every command that asks one. */
export const YES_OPTION: OptionDoc = {
  flag: '--yes',
  description:
    'Answer yes to the confirmation. Needed when there is no terminal to ask on; without it and without a terminal the command exits 2.',
}
