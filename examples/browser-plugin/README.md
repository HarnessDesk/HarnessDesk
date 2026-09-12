# Browser — the worked plugin example

A complete, installable HarnessDesk plugin: three agent tools (`browse_page`,
`page_links`, `find_in_page`), two slash commands (`/browse`, `/browser-clear`),
and a live reading-history panel in the sidebar — written the way a
third-party author would write one, and used to validate the developer
experience end to end.

Driving a real browser — open, screenshot, click, type — is **built in**
(`packages/plugins/src/browser.ts`) and is not duplicated here. An example
that ships a second copy of a shipped feature teaches the wrong thing, and
hands an agent two tools with the same name.

## What it asks for, and why

The manifest declares `"network": { "hosts": ["*"] }`. That is this plugin's
honest declaration and not the line to copy: `browse_page` reads whatever URL
the agent names, so there is no host to name in advance. A plugin that talks
to one API names it — `"hosts": ["api.example.com"]`, or `["*.example.com"]` —
and anything the manifest does not name is refused where it is used, not at
install time. A plugin's manifest is its grant and nothing widens it
afterwards, so asking for the wildcard asks whoever installs it to trust every
host on the network.

Install it from **Settings → Plugins → Add plugin** with this directory's
path. Edit it, press **Update from source** on its card, and the new code is
live. See [docs/extending.md](../../docs/extending.md) for the full guide this
example follows.
