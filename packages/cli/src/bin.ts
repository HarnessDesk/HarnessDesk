#!/usr/bin/env node
import { main } from './cli.js'
import { serveMcp } from './mcp.js'
const argv = process.argv.slice(2)
// The MCP server is the surface that serves the command table, not a command in it.
if (argv[0] === 'mcp') process.exit(await serveMcp(argv.slice(1)))
else process.exitCode = await main(argv)
