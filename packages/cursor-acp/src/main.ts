#!/usr/bin/env node
import { CursorAcpBridge } from './bridge.js'

/**
 * `cursor-acp` — Cursor as an ACP agent, on stdio.
 *
 * Point any ACP client at this executable. `CURSOR_ACP_COMMAND` overrides
 * which cursor-agent binary is run (the tests point it at a fake).
 */
await new CursorAcpBridge().serve()
