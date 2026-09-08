# Support

**Something misbehaving?** Open a
[bug report](https://github.com/HarnessDesk/HarnessDesk/issues/new?template=bug_report.yml)
and attach a diagnostics bundle: **Settings (⌘,) → General → Save bundle…**.
It carries versions, runtime health, plugin state and the last 500 log lines —
with credential shapes, workspace roots and your home directory scrubbed before
it is written, in one file you can review before sharing.

**A question rather than a bug?** Open an
[issue](https://github.com/HarnessDesk/HarnessDesk/issues/new/choose) too —
there is no separate forum yet, and a question is a defect report against the
documentation.

Before either, the short version of most answers:

- [docs/getting-started.md#troubleshooting](docs/getting-started.md#troubleshooting)
  ends with troubleshooting for common failures — an agent not found or too
  old, a spent usage window, an unbuilt ACP bridge, or a missing plugin tool
  bridge.
- Logs live at `~/.harnessdesk/logs/host.ndjson`. In the desktop app,
  **Help → Open Diagnostics Folder** opens the folder containing the log and
  any crash reports under `crashes/`.
- The model list is the agent's own; when it looks wrong,
  [docs/agents.md#where-the-model-list-comes-from](docs/agents.md#where-the-model-list-comes-from)
  explains whose fact it is.

Security reports take a different door: [SECURITY.md](SECURITY.md), privately.
