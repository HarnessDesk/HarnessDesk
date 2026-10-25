# What is open, and what is hosted

HarnessDesk runs the desktop and its host on this machine. Account sign-in is
an optional connection to a hosted service. LAN phone pairing is a separate
local connection and needs no account link.

## What this desktop implements

- **Account.** Settings › Account starts sign-in in the system browser, shows
  the desk name and matching code, and polls for the person's approval. The
  host proves its own key for a renewable desk session and reads account and
  linked-phone metadata. Rename, linked-phone removal, sign-out and account
  deletion use that session. The browser's account session stays in the browser.
- **Stored identity.** The desktop's OS keystore cipher protects the private
  desk key, pending approval, desk token and cached profile in a sealed file
  per service origin, excluded from backups. Account sign-in requires encrypted
  storage. The host fetches bounded raster pictures and supplies local image
  data to the renderer.
- **Local phone.** `HARNESSDESK_PHONE_LINK=1` starts the LAN listener.
  Settings › Phone shows a code to scan on the same network; the desktop must
  allow the phone. The local desk key and paired-device registry live under
  `phone-link/`, independently of the account identity. Removing a phone ends
  its connection and requires a new pairing.
- **Lead.** `HARNESSDESK_LEAD=1` enables the optional planning conversation.
  Its child requires Node 25+. The current desktop embeds an older runtime and
  reports Lead unavailable when enabled. A compatible host keeps its journal
  locally, sends bounded provider requests and manages local worker Flows.
- **Git publication.** The host pins the repository and publishes through the
  shared gateway. The local Git record retains approvals and outcomes; Git
  objects, pull-request text and comments go to the selected forge.

The account's Reachable from your phone switch only saves a preference in
this build. The desktop opens no account relay transport. Signing in does not
upload conversations or files, synchronize work or enable hosted execution.
The full request inventory, payloads, timing, retention and sign-out behavior
are in [data-boundaries.md](data-boundaries.md).

## The open wire and the hosted service

The desktop integration and wire are in this repository under the MIT licence.
`packages/contract` defines account, token, pairing and relay schemas;
`packages/crypto` implements key proofs, handshakes, framing and push sealing.
Its fixed test vectors describe the bytes an implementation must reproduce.
The hosted service and phone application are outside this repository.

The account service receives the public key, desk name and signed proofs used
for registration and renewal, then the authenticated account operations listed
in [the request inventory](data-boundaries.md#harnessdesk-account--only-after-you-choose-sign-in).
The private desk key and browser cookies are not sent in those requests.
Relay and push schemas describe encrypted frames; the current desktop does
not open that transport, so those schemas do not establish a live desktop lane.

## Where the code is

| Boundary | Source |
| --- | --- |
| Account host service | `packages/server/src/harnessdesk-account.ts`, exposed to the renderer through `account/*` |
| Account pictures | `packages/server/src/account-picture.ts` |
| Desktop encryption and external browser | `packages/desktop/electron/main.mjs` |
| LAN phone transport and registry | `packages/phone-link` and `packages/server/src/phone-link.ts` |
| Lead child and host integration | `packages/lead` and `packages/server/src/lead` |
| Publication gateway | `packages/server/src/git-gateway` |
| Shared schemas and cryptography | `packages/contract` and `packages/crypto` |
