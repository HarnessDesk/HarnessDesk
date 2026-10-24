# What is open, and what is hosted

HarnessDesk is a desktop app that runs on your machine. A phone can reach it
from anywhere through a hosted service. This page says which side of that line
each piece is on, and what the service can and cannot see.

**Status.** Desktop account sign-in, account details, linked-phone removal,
desk rename and sign-out are implemented. They are optional and do not send
conversations or files. Desktop phone relay transport and pairing are not
implemented in this build. [data-boundaries.md](data-boundaries.md) describes
the account lane separately from local work.

## The client is open

The desktop's service integration is in this repository under the MIT licence:

- **Sign-in.** The host proves its desk key and opens a named desk and short
  code in the system browser. The person signs in there and explicitly links
  it; the host learns the result by polling with its own secret. The browser
  session never reaches the desk. `harnessdesk://` only focuses the app.
- **The desk's identity.** Each desk creates an Ed25519 key; its id is derived
  from the public key. The existing desktop keystore cipher protects the key,
  renewable desk token and cached profile in a separate sealed file per cloud
  origin. There is no
  plaintext fallback for this account. Future QR pairing uses this identity
  so a phone can verify the desk it scanned.
- **Encryption.** The relay connection and push messages will be encrypted on
  the desk, with keys the service never receives.

The protocol is open as well. `packages/contract` holds the schemas for ids,
tokens, pairing offers, relay frames and the account API. `packages/crypto`
holds the handshake, framing, token signing and push sealing, using WebCrypto
only. `packages/crypto/test-vectors.json` fixes inputs to outputs; every
implementation of the wire, including the phone's, must reproduce it. This
repository's copy is the canonical one: the service carries a copy of both
packages and checks that its files match the ones here byte for byte, so a
change to the wire is made here first.
Tokens carry a purpose (`typ`), a key id, and issue and expiry times, and the
verifier states which purpose it expects; they carry no audience claim yet, so
a token is accepted by every service that trusts its key id.

## The service is hosted

The hosted service is closed source and runs three things:

- **Accounts and sign-in.** It issues tokens and checks that a desk owns the
  key it names.
- **The relay.** Desk and phone each open an outbound connection to it, and it
  passes their frames to each other.
- **Push.** It wraps a message the desk has already encrypted in a generic
  notification and hands it to Apple.

The iOS app is closed as well.

## What the service sees

It sees ciphertext and what it needs to route it: account and device ids,
public keys, message sizes and timing. It also sees what the account API
carries in the clear, which is what the contract's schemas name and nothing
more:

- the desk's name, when it is registered or listed, and the name a phone gives
  itself when it redeems an invite;
- a phone's APNs token, its environment and the app's bundle id, when it
  registers for push;
- on each push, the device it is for, its priority and its collapse key, and the
  size of the sealed message.

It never sees a prompt, a reply, a file, a diff or a notification's text. The relay cannot open the frames it passes
along, and the push gateway cannot open the message it wraps, because neither
holds the keys.

## Where secrets live

Only on the server. The keys that sign tokens, the push credentials and the
service's other secrets exist in the hosted service's configuration and
nowhere in this repository or in the app. A desk holds its own private key and
its sign-in token, in the keychain, and nothing that could act as the service.

Because the client is public, the service cannot rely on the client behaving:
every limit, check and expiry is enforced on the server.

## Where the code is

| | |
| --- | --- |
| `packages/contract` | Schemas for the wire — see [architecture.md](architecture.md#the-packages) |
| `packages/crypto` | The cryptography of the wire, and its test vectors |
| The desktop's cloud code | `packages/server/src/harnessdesk-account.ts`, behind `account/*` on the local renderer wire. The renderer never imports the cloud wire: `pnpm layering` refuses it |
| The hosted service | Not in this repository |

[decisions.md](decisions.md#the-client-is-open-the-hosted-service-is-closed--2026-10-21)
records why the line is drawn here.
