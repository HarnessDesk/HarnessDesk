import type { AcpSecretSpec } from '@harnessdesk/adapter-acp'

/**
 * What the desk knows about each agent it can run, beyond what the public
 * ACP registry says.
 *
 * The registry names a package or an archive per agent; it does not say
 * where `brew install` or a vendor's `curl | sh` puts the same binary, what
 * `--version` prints, which release first spoke ACP, where the agent keeps
 * its credentials, or how a person signs in. Those are the facts that
 * decide whether the copy a person already has can be driven, whether it
 * is too old, what to run to bring it current, and what to say when it is
 * signed out — and every one of them was read from the vendor's own
 * installer, package or CLI on 2026-09-05, not from a description of it.
 *
 * The table is data. Nothing in it is executed on its own authority: a
 * command named here runs only through the same paths a hand-written
 * `agents.json` row already reaches, and a path here is only somewhere to
 * *look*. What the table changes is which copy answers, and what the
 * interface can say about it.
 */

export interface CommandSpec {
  readonly command: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
}

export interface KnownAgent {
  /** Our key: the public registry's id where one exists, the template key otherwise. */
  readonly id: string
  readonly name: string
  /** A lobe-icons key, for the mark. */
  readonly brand?: string
  readonly tagline: string
  /** The agent's CLI on disk. */
  readonly cli: {
    /** Names it answers to on PATH; the first is the canonical one. */
    readonly commands: readonly string[]
    /** Where installers put it when PATH does not say; `~` is the home. */
    readonly paths?: readonly string[]
    /** What makes it print its version; `--version` unless said otherwise. */
    readonly versionArgs?: readonly string[]
    /** The oldest release that speaks ACP the way `acp` below starts it. */
    readonly minVersion?: string
    readonly minVersionReason?: string
  }
  /**
   * How the CLI becomes an ACP agent. `args` are appended to the CLI's own
   * path; a `bridge` is a separate program that speaks ACP on the CLI's
   * behalf and is told where the CLI is through `executableEnv`.
   */
  readonly acp: {
    readonly args: readonly string[]
    readonly env?: Readonly<Record<string, string>>
    readonly bridge?: {
      readonly command: string
      readonly args: readonly string[]
      /** The variable the bridge reads the CLI's path from. */
      readonly executableEnv: string
      readonly minVersion?: string
    }
  }
  /** Where the vendor publishes it, so an update can be phrased for the road taken. */
  readonly publish: {
    readonly npm?: string
    readonly brew?: string
    readonly pypi?: string
    /** The agent's own update verb, when it has one. */
    readonly selfUpdate?: string
    /** The one-line install for a machine with nothing. */
    readonly installCommand: string
    readonly url?: string
  }
  /** Where the agent keeps its own world. */
  readonly home: {
    readonly path: string
    /** The variable that moves the whole home, when the agent honours one. */
    readonly env?: string
    /** Files inside that hold a credential — what a second account must keep apart. */
    readonly credentials: readonly string[]
    readonly config: readonly string[]
    readonly note?: string
  }
  /** How a person signs in, and how the desk can tell. */
  readonly auth: {
    readonly kind: 'browser' | 'device-code' | 'api-key' | 'terminal' | 'gateway'
    /** Prints who is signed in, when the CLI can say. */
    readonly status?: CommandSpec
    /** A sign-in that prints a URL and exits 0 when done; drivable from the desk. */
    readonly login?: CommandSpec
    readonly logout?: CommandSpec
    /** A sign-in that needs a terminal — the desk opens one on this. */
    readonly terminal?: string
    /** An API key the desk can hold and inject, for agents that take one. */
    readonly secrets?: readonly AcpSecretSpec[]
    readonly note: string
  }
  /** A service that must already be running for the agent to answer. */
  readonly daemon?: {
    readonly name: string
    /** Exits 0 when the service is up. */
    readonly check: CommandSpec
    readonly start: string
    readonly note: string
  }
  /**
   * A check to run before starting, whose failure output is the reason the
   * agent will not start — an agent's own `config validate`, say, which
   * knows its schema and the desk does not.
   */
  readonly preflight?: {
    readonly command: CommandSpec
    readonly remediation: string
  }
  /** What the interface should say about this agent's particular situation. */
  readonly notes?: readonly string[]
}

const cli = (command: string, ...args: string[]): CommandSpec => ({ command, args })

export const KNOWN_AGENTS: readonly KnownAgent[] = [
  {
    id: 'gemini',
    name: 'Gemini CLI',
    brand: 'geminicli',
    tagline: "Google's Gemini CLI, speaking ACP directly.",
    cli: {
      commands: ['gemini'],
      minVersion: '0.58.0',
      minVersionReason: '`--acp` replaced `--experimental-acp` in 0.58; older builds are started with the old flag.',
    },
    acp: { args: ['--acp'] },
    publish: {
      npm: '@google/gemini-cli',
      brew: 'gemini-cli',
      installCommand: 'npm install -g @google/gemini-cli',
      url: 'https://geminicli.com',
    },
    home: {
      path: '~/.gemini',
      credentials: ['oauth_creds.json', 'google_accounts.json'],
      config: ['settings.json'],
      note: 'GEMINI_API_KEY or GOOGLE_API_KEY in the environment stands in for the browser sign-in.',
    },
    auth: {
      kind: 'browser',
      terminal: 'gemini',
      secrets: [
        {
          env: 'GEMINI_API_KEY',
          label: 'Gemini API key',
          helpUrl: 'https://aistudio.google.com/apikey',
          description: 'Optional: an API key instead of the Google account sign-in Gemini CLI runs in its own window.',
        },
      ],
      note: 'Gemini CLI signs in from its own interface (`/auth`), opening a browser; NO_BROWSER=true prints the link instead. There is no separate login command.',
    },
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    brand: 'openclaw',
    tagline: "OpenClaw's Gateway, through its own ACP bridge.",
    cli: { commands: ['openclaw'], versionArgs: ['--version'] },
    acp: {
      args: ['acp'],
      // The bridge shares stdout with the protocol; the banner and the
      // update notes would corrupt the first frame.
      env: { OPENCLAW_HIDE_BANNER: '1', OPENCLAW_SUPPRESS_NOTES: '1' },
    },
    publish: {
      npm: 'openclaw',
      installCommand: 'npm install -g openclaw',
      url: 'https://docs.openclaw.ai/cli/acp',
    },
    home: {
      path: '~/.openclaw',
      env: 'OPENCLAW_STATE_DIR',
      credentials: ['credentials', 'gateway.token'],
      config: ['openclaw.json'],
      note: '`--profile <name>` isolates a whole second home under ~/.openclaw-<name>; OPENCLAW_CONFIG_PATH moves the config file alone.',
    },
    auth: {
      kind: 'gateway',
      note: 'The bridge signs in to the Gateway, not to a vendor: a token from `gateway.auth.token` in openclaw.json, OPENCLAW_GATEWAY_TOKEN, or --token-file. Model providers are configured in the Gateway.',
    },
    daemon: {
      name: 'the OpenClaw Gateway',
      check: cli('openclaw', 'gateway', 'status', '--json', '--no-probe'),
      start: 'openclaw daemon start',
      note: '`openclaw acp` forwards every prompt to a running Gateway over WebSocket; without one it has nobody to ask.',
    },
    preflight: {
      command: cli('openclaw', 'config', 'validate'),
      remediation:
        'openclaw.json was written by a different OpenClaw version and this one refuses it. `openclaw doctor --fix` migrates the keys it knows; the lines above name the rest.',
    },
    notes: ['Per-session MCP servers are refused by the bridge, so plugin tools do not reach OpenClaw sessions.'],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    brand: 'opencode',
    tagline: 'The open-source coding agent, speaking ACP directly.',
    cli: {
      commands: ['opencode'],
      paths: ['~/.opencode/bin/opencode'],
    },
    acp: { args: ['acp'] },
    publish: {
      npm: 'opencode-ai',
      brew: 'opencode',
      selfUpdate: 'opencode upgrade',
      installCommand: 'curl -fsSL https://opencode.ai/install | bash',
      url: 'https://opencode.ai/docs/cli/',
    },
    home: {
      path: '~/.local/share/opencode',
      env: 'XDG_DATA_HOME',
      credentials: ['auth.json'],
      config: ['~/.config/opencode/opencode.json'],
      note: 'Config and data are two XDG folders: OPENCODE_CONFIG names a config file, OPENCODE_CONFIG_DIR a config folder; auth.json sits under XDG_DATA_HOME.',
    },
    auth: {
      kind: 'terminal',
      status: cli('opencode', 'auth', 'list'),
      terminal: 'opencode auth login',
      note: 'Providers are added one at a time with `opencode auth login`, which asks in the terminal; Claude Pro/Max, ChatGPT and Copilot sign in through a browser from there, the rest take an API key.',
    },
  },
  {
    id: 'cline',
    name: 'Cline',
    brand: 'cline',
    tagline: "Cline's CLI, speaking ACP directly.",
    cli: { commands: ['cline'] },
    acp: { args: ['--acp'] },
    publish: {
      npm: 'cline',
      selfUpdate: 'cline --update',
      installCommand: 'npm install -g cline',
      url: 'https://docs.cline.bot/cline-cli/overview',
    },
    home: {
      path: '~/.cline',
      credentials: ['data'],
      config: ['data'],
      note: '`--config <dir>` and `--data-dir <dir>` move the folder per run; there is no environment variable for it.',
    },
    auth: {
      kind: 'terminal',
      terminal: 'cline auth',
      secrets: [
        {
          env: 'CLINE_API_KEY',
          label: 'Cline API key',
          helpUrl: 'https://app.cline.bot',
          description: 'Optional: a Cline account key instead of the terminal sign-in.',
        },
      ],
      note: '`cline auth` runs the same flow as the editor extension — a Cline account, ClinePass, or a provider key — and saves what it gets under ~/.cline for every later run.',
    },
  },
  {
    id: 'hermes',
    name: 'Hermes Agent',
    brand: 'hermesagent',
    tagline: "Nous Research's Hermes Agent, speaking ACP directly.",
    cli: {
      commands: ['hermes'],
      paths: ['~/.local/bin/hermes', '/usr/local/bin/hermes'],
      versionArgs: ['--version'],
    },
    acp: { args: ['acp'] },
    publish: {
      pypi: 'hermes-agent',
      selfUpdate: 'hermes update',
      installCommand: 'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash',
      url: 'https://hermes-agent.nousresearch.com/docs',
    },
    home: {
      path: '~/.hermes',
      env: 'HERMES_HOME',
      credentials: ['.env'],
      config: ['config.yaml'],
      note: "The installer keeps the code under $HERMES_HOME/hermes-agent and links the command into ~/.local/bin; data, config and sessions stay in $HERMES_HOME.",
    },
    auth: {
      kind: 'terminal',
      terminal: 'hermes setup',
      note: 'Providers are configured with `hermes setup` (or `hermes model`); ACP mode reads the same ~/.hermes/.env and config.yaml, and advertises a terminal auth method for first runs.',
    },
  },
  {
    id: 'codebuddy-code',
    name: 'CodeBuddy Code',
    brand: 'codebuddy',
    tagline: "Tencent Cloud's CodeBuddy Code, speaking ACP directly.",
    cli: { commands: ['codebuddy', 'cbc'] },
    acp: { args: ['--acp'] },
    publish: {
      npm: '@tencent-ai/codebuddy-code',
      selfUpdate: 'codebuddy update',
      installCommand: 'npm install -g @tencent-ai/codebuddy-code',
      url: 'https://www.codebuddy.cn/cli/',
    },
    home: {
      path: '~/.codebuddy',
      env: 'CODEBUDDY_CONFIG_DIR',
      credentials: ['.credentials.json'],
      config: ['settings.json', 'settings.local.json'],
    },
    auth: {
      kind: 'terminal',
      terminal: 'codebuddy',
      secrets: [
        {
          env: 'CODEBUDDY_API_KEY',
          label: 'CodeBuddy API key',
          helpUrl: 'https://www.codebuddy.cn/cli/',
          description: 'Optional: an API key instead of the in-app `/login`.',
        },
      ],
      note: 'CodeBuddy signs in from its own interface with `/login`, opening a browser; CODEBUDDY_API_KEY in the environment stands in for it.',
    },
    notes: ['`codebuddy install` fetches a native build; the npm package and the native build report the same version.'],
  },
  {
    id: 'kimi',
    name: 'Kimi CLI',
    brand: 'kimi',
    tagline: "Moonshot AI's Kimi CLI, speaking ACP directly.",
    cli: {
      commands: ['kimi'],
      paths: ['~/.local/bin/kimi', '~/.kimi-code/bin/kimi'],
    },
    acp: { args: ['acp'] },
    publish: {
      pypi: 'kimi-cli',
      installCommand: 'curl -LsSf https://code.kimi.com/install.sh | bash',
      url: 'https://moonshotai.github.io/kimi-cli/',
    },
    home: {
      path: '~/.kimi',
      credentials: ['credentials'],
      config: ['config.toml'],
      note: 'Two generations ship under one name: `kimi-cli` (Python, `uv tool install kimi-cli`, under ~/.local/bin) and Kimi Code (a native binary under ~/.kimi-code). The installer now offers the new one and takes KIMI_CLI_FORCE_OLD=1 for the old.',
    },
    auth: {
      kind: 'terminal',
      terminal: 'kimi',
      secrets: [
        {
          env: 'KIMI_API_KEY',
          label: 'Moonshot API key',
          helpUrl: 'https://platform.moonshot.ai/console/api-keys',
          description: 'Optional: a platform key instead of the in-app `/login`.',
        },
      ],
      note: 'Kimi signs in from its own interface with `/login`: the Kimi Code plan opens a browser, other platforms take an API key.',
    },
  },
  {
    id: 'pi-acp',
    name: 'pi',
    brand: 'pi',
    tagline: 'The pi coding agent, through the pi-acp adapter.',
    cli: {
      commands: ['pi'],
      minVersion: '0.80.4',
      minVersionReason: 'pi-acp drives `pi --mode rpc`, which pi gained in 0.80.4.',
    },
    acp: {
      args: [],
      bridge: {
        command: 'npx',
        args: ['-y', 'pi-acp@0.0.33'],
        executableEnv: 'PI_ACP_PI_COMMAND',
      },
    },
    publish: {
      npm: '@earendil-works/pi-coding-agent',
      installCommand: 'npm install -g @earendil-works/pi-coding-agent',
      url: 'https://pi.dev',
    },
    home: {
      path: '~/.pi/agent',
      env: 'PI_CODING_AGENT_DIR',
      credentials: ['auth.json'],
      config: ['models.json', 'settings.json'],
      note: 'pi moved from @mariozechner/pi-coding-agent to @earendil-works/pi-coding-agent; the old package is deprecated and stops at 0.73, below what pi-acp needs.',
    },
    auth: {
      kind: 'terminal',
      terminal: 'pi',
      note: 'pi signs in per provider from its own interface (`/login`), or reads provider keys such as ANTHROPIC_API_KEY from the environment; pi-acp reuses that setup and offers a terminal sign-in of its own (`pi-acp --terminal-login`).',
    },
  },
  {
    id: 'grok-build',
    name: 'Grok Build',
    brand: 'grok',
    tagline: "xAI's Grok Build, speaking ACP over its stdio agent.",
    cli: {
      commands: ['grok'],
      paths: ['~/.grok/bin/grok'],
      versionArgs: ['version'],
    },
    acp: { args: ['agent', 'stdio'] },
    publish: {
      npm: '@xai-official/grok',
      selfUpdate: 'grok update',
      installCommand: 'npm install -g @xai-official/grok',
      url: 'https://x.ai/cli',
    },
    home: {
      path: '~/.grok',
      env: 'GROK_HOME',
      credentials: ['credentials'],
      config: ['config.toml'],
      note: 'The npm package is a trampoline: the native binary lives under $GROK_HOME/bin, which `grok update` replaces in place.',
    },
    auth: {
      kind: 'device-code',
      login: cli('grok', 'login', '--device-auth'),
      logout: cli('grok', 'logout'),
      secrets: [
        {
          env: 'XAI_API_KEY',
          label: 'xAI API key',
          helpUrl: 'https://console.x.ai',
          description: 'Optional: an API key instead of the Grok sign-in.',
        },
      ],
      note: '`grok login` opens auth.x.ai in a browser; `--device-auth` prints a code and a link instead, which is the headless flow.',
    },
    notes: ["npm's `latest` tag for @xai-official/grok lags the newest release by several versions; the registry pins a version the tag does not name."],
  },
  {
    id: 'antigravity-acp',
    name: 'Google Antigravity',
    brand: 'antigravity',
    tagline: "Google's Antigravity agent, through its own ACP server.",
    cli: {
      commands: ['agy_acp_server'],
      paths: ['~/.antigravity/antigravity/bin/agy_acp_server', '~/.antigravity-ide/antigravity-ide/bin/agy_acp_server'],
    },
    acp: { args: [] },
    publish: {
      installCommand: 'Add it from the ACP registry; the server is a download from dl.google.com.',
      url: 'https://antigravity.google/docs',
    },
    home: {
      path: '~/.gemini/antigravity',
      credentials: ['~/.gemini/google_accounts.json'],
      config: [],
      note: 'The server is not part of the Antigravity IDE bundle; the registry download is the only copy, and its Google sign-in is its own.',
    },
    auth: {
      kind: 'browser',
      note: 'The server opens a Google sign-in in the browser on first use; the desk relays what it asks.',
    },
  },
  {
    id: 'claude-code',
    name: 'Claude',
    brand: 'claudecode',
    tagline: "Anthropic's coding agent, through HarnessDesk's claude-acp bridge.",
    cli: {
      commands: ['claude'],
      paths: ['~/.local/bin/claude', '~/.claude/local/claude'],
    },
    acp: { args: [], bridge: { command: 'claude-acp', args: [], executableEnv: 'CLAUDE_CODE_EXECUTABLE' } },
    publish: {
      npm: '@anthropic-ai/claude-code',
      selfUpdate: 'claude update',
      installCommand: 'npm install -g @anthropic-ai/claude-code',
      url: 'https://docs.anthropic.com/claude-code',
    },
    home: {
      path: '~/.claude',
      env: 'CLAUDE_CONFIG_DIR',
      credentials: ['.credentials.json'],
      config: ['settings.json'],
    },
    auth: {
      kind: 'browser',
      status: cli('claude', 'auth', 'status'),
      login: cli('claude', 'auth', 'login'),
      logout: cli('claude', 'auth', 'logout'),
      note: '`claude auth login` prints the sign-in link and exits when the browser comes back.',
    },
  },
  {
    id: 'cursor',
    name: 'Cursor',
    brand: 'cursor',
    tagline: "Cursor's CLI agent, through HarnessDesk's cursor-acp bridge.",
    cli: { commands: ['cursor-agent'], paths: ['~/.local/bin/cursor-agent'] },
    acp: { args: [], bridge: { command: 'cursor-acp', args: [], executableEnv: 'CURSOR_ACP_COMMAND' } },
    publish: {
      selfUpdate: 'cursor-agent update',
      installCommand: 'curl https://cursor.com/install -fsS | bash',
      url: 'https://cursor.com/docs/cli',
    },
    home: {
      path: '~/.cursor',
      credentials: [],
      config: ['cli-config.json'],
    },
    auth: {
      kind: 'browser',
      status: cli('cursor-agent', 'status'),
      login: { command: 'cursor-agent', args: ['login'], env: { NO_OPEN_BROWSER: '1' } },
      logout: cli('cursor-agent', 'logout'),
      note: '`cursor-agent login` prints the link with NO_OPEN_BROWSER=1 and exits when signed in.',
    },
    notes: [
      'The Homebrew cask `cursor-cli` leaves a `/opt/homebrew/bin/cursor-agent` that is months behind the self-updating `~/.local/bin` copy, and one such copy hung on `--version` — which is why a copy that does not answer is never chosen.',
    ],
  },
]

export const knownAgent = (id: string): KnownAgent | undefined =>
  KNOWN_AGENTS.find((agent) => agent.id === id)

/** The known agent a CLI name belongs to, for rows that name only a command. */
export const knownAgentByCommand = (command: string): KnownAgent | undefined =>
  KNOWN_AGENTS.find((agent) => agent.cli.commands.includes(command))
