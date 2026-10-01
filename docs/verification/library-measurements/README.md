# Library measurements

Every result below was written by the hardened isolated harness after its
per-run sandbox preflight passed. CLI help and versions were captured through
`run()`. A signed-out ACP peer was asked to initialize and create a session,
without a prompt. Codex was queried over `codex app-server`; its response was
reduced to fixture membership, enums, booleans and counts. Raw protocol output
is not persisted.

`could-not-ask` cells name the limiting condition. For non-Codex agents,
measurements 1–5 need a signed-in model answer. Measurements 6–7 were not
implemented for ACP. Measurement 8 needs an ACP session; a process that did
not start a session cannot report commands or skills. Unknown versions mean
the binary was not installed, did not answer, or could not safely be queried;
the JSON records distinguish these outcomes.

| Agent (result) | 1 rules | 2 catalogue | 3 precedence | 4 limits | 5 roots | 6 refresh | 7 MCP | 8 signed-out listing |
|---|---|---|---|---|---|---|---|---|
| Codex ([0.155.0](codex-0.155.0.json)) | could-not-ask: needs sign-in, a model answer is required | user, repo and auxiliary fixtures reported | duplicate loaded in user and repo scopes (2 copies) | missing description rejected with a description error; 1.1 MB skill accepted; no size word in error | user and repo scopes reported | force reload saw fixture edit; `runtime/refreshCatalog` rejected; open-session visibility unknown | MCP config recognized; connection status unknown | available: fixture skills were reported |
| Gemini CLI ([0.62.0](gemini-0.62.0.json)) | could-not-ask: needs sign-in, a model answer is required | could-not-ask: needs sign-in, a model answer is required | could-not-ask: needs sign-in, a model answer is required | could-not-ask: needs sign-in, a model answer is required | could-not-ask: needs sign-in, a model answer is required | could-not-ask: ACP session unavailable | could-not-ask: ACP session unavailable | could-not-ask: ACP session unavailable |
| OpenClaw ([2026.8.2](openclaw-2026.8.2.json)) | could-not-ask: needs sign-in, a model answer is required | could-not-ask: needs sign-in, a model answer is required | could-not-ask: needs sign-in, a model answer is required | could-not-ask: needs sign-in, a model answer is required | could-not-ask: needs sign-in, a model answer is required | could-not-ask: ACP session unavailable | could-not-ask: ACP session unavailable | could-not-ask: ACP session unavailable |
| OpenCode ([1.18.30](opencode-1.18.30.json)) | could-not-ask: needs sign-in, a model answer is required | could-not-ask: needs sign-in, a model answer is required | could-not-ask: needs sign-in, a model answer is required | could-not-ask: needs sign-in, a model answer is required | could-not-ask: needs sign-in, a model answer is required | could-not-ask: ACP session unavailable | could-not-ask: ACP session unavailable | could-not-ask: ACP session unavailable |
| Cline ([3.0.67](cline-3.0.67.json)) | could-not-ask: needs sign-in, a model answer is required | could-not-ask: needs sign-in, a model answer is required | could-not-ask: needs sign-in, a model answer is required | could-not-ask: needs sign-in, a model answer is required | could-not-ask: needs sign-in, a model answer is required | could-not-ask: ACP session unavailable | could-not-ask: ACP session unavailable | could-not-ask: ACP session unavailable |
| Hermes ([unknown](hermes-unknown.json)) | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed |
| CodeBuddy Code ([unknown](codebuddy-code-unknown.json)) | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed |
| Kimi ([unknown](kimi-unknown.json)) | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed |
| Pi ACP ([unknown](pi-acp-unknown.json)) | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed |
| Grok Build ([unknown](grok-build-unknown.json)) | could-not-ask: cannot isolate | could-not-ask: cannot isolate | could-not-ask: cannot isolate | could-not-ask: cannot isolate | could-not-ask: cannot isolate | could-not-ask: cannot isolate | could-not-ask: cannot isolate | could-not-ask: cannot isolate |
| GitHub Copilot CLI ([unknown](github-copilot-cli-unknown.json)) | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed |
| Antigravity ([unknown](antigravity-acp-unknown.json)) | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed |
| Claude ([unknown](claude-code-unknown.json)) | could-not-ask: cannot isolate | could-not-ask: cannot isolate | could-not-ask: cannot isolate | could-not-ask: cannot isolate | could-not-ask: cannot isolate | could-not-ask: cannot isolate | could-not-ask: cannot isolate | could-not-ask: cannot isolate |
| Cursor ([unknown](cursor-unknown.json)) | could-not-ask: cannot isolate | could-not-ask: cannot isolate | could-not-ask: cannot isolate | could-not-ask: cannot isolate | could-not-ask: cannot isolate | could-not-ask: cannot isolate | could-not-ask: cannot isolate | could-not-ask: cannot isolate |
| DeepSeek ([0.1.7-rc.2](dsh-0.1.7-rc.2.json)) | could-not-ask: needs sign-in, a model answer is required | could-not-ask: needs sign-in, a model answer is required | could-not-ask: needs sign-in, a model answer is required | could-not-ask: needs sign-in, a model answer is required | could-not-ask: needs sign-in, a model answer is required | could-not-ask: ACP session unavailable | could-not-ask: ACP session unavailable | could-not-ask: ACP session unavailable |
| Devin ([unknown](devin-unknown.json)) | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed | could-not-ask: binary not installed |

The Codex fixture was read in a fresh signed-out home. `skills/list` returned
both same-name copies, omitted the missing-description skill with one error,
and returned the oversized skill. A forced second list saw the changed
description. The runtime refresh method was rejected; a live MCP connection
status was not available even though config reading recognized the fixture.
The ACP attempts sent `initialize` and `session/new` only; no model prompt,
login, credential or quota was used.
