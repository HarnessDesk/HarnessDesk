# What is open, and what is hosted

HarnessDesk is a desktop app that runs on your machine. A phone can reach it
from anywhere through a hosted service. This page says which side of that line
each piece is on, and what the service can and cannot see.

**Status.** The desktop does not connect to the hosted service yet, and
nothing in the app sends anything to it. What exists today is the wire both
sides share — the two packages named below — with their tests. Until sign-in
ships, [data-boundaries.md](data-boundaries.md) stays exactly as written.

## The client is open

Everything the desktop does with the service is in this repository, under the
MIT licence:

- **Sign-in.** The app is a public client: it signs in through the system
  browser with PKCE and a `harnessdesk://` redirect, and keeps the resulting
  token in the keychain. It holds no client secret, because a client that ships
  to every machine cannot keep one.
- **The desk's identity.** Each desk creates its own Ed25519 key. Its id is
  derived from the public key, and pairing a phone is a QR code that carries
  that public key, so the phone can check it is talking to the desk it scanned.
- **Encryption.** The relay connection and push messages are encrypted on the
  desk, with keys the service never receives.

The protocol is open as well. `packages/contract` holds the schemas for ids,
tokens, pairing offers, relay frames and the account API. `packages/crypto`
holds the handshake, framing, token signing and push sealing, using WebCrypto
only. `packages/crypto/test-vectors.json` fixes inputs to outputs; every
implementation of the wire, including the phone's, must reproduce it.

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
public keys, message sizes and timing. It never sees a prompt, a reply, a file,
a diff or a notification's text. The relay cannot open the frames it passes
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
| The desktop's cloud code | One seam in the host, so it can move without touching the rest. The renderer never imports the wire: `pnpm layering` refuses it |
| The hosted service | Not in this repository |

[decisions.md](decisions.md#the-client-is-open-the-hosted-service-is-closed--2026-10-21)
records why the line is drawn here.
