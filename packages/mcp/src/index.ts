#!/usr/bin/env node
/**
 * Multiloger MCP server (stdio transport).
 *
 * Exposes Multiloger browser-profile management and automation as MCP tools,
 * acting STRICTLY as an authenticated consumer of the Multiloger REST API.
 * This process never spawns browsers, never touches the SQLite database, and
 * never imports from @multiloger/api.
 *
 * Configuration (environment only — tools never see these values):
 *   MULTILOGER_API_URL    Base URL of the Multiloger API (default http://127.0.0.1:3000)
 *   MULTILOGER_API_TOKEN  Bearer token for the API (REQUIRED)
 *
 * All logging goes to stderr: stdout is the MCP protocol channel.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MultilogerApiClient } from './api-client.js';
import { buildTools } from './tools.js';

const SERVER_NAME = 'multiloger';
const SERVER_VERSION = '0.1.0';
const DEFAULT_API_URL = 'http://127.0.0.1:3000';

interface ServerConfig {
  apiUrl: string;
  token: string;
}

function readConfig(): ServerConfig {
  const rawUrl = process.env.MULTILOGER_API_URL?.trim();
  const apiUrl = rawUrl === undefined || rawUrl === '' ? DEFAULT_API_URL : rawUrl;
  const token = process.env.MULTILOGER_API_TOKEN?.trim();
  if (token === undefined || token === '') {
    process.stderr.write(
      'multiloger-mcp: MULTILOGER_API_TOKEN is required but not set.\n' +
        'Set it to a valid Multiloger API token and restart the server.\n',
    );
    process.exit(1);
  }
  return { apiUrl, token };
}

function fail(message: string): never {
  process.stderr.write(`multiloger-mcp: fatal: ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { apiUrl, token } = readConfig();
  const client = new MultilogerApiClient(apiUrl, token);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  for (const tool of buildTools(client)) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args) => tool.handler(args),
    );
  }

  await server.connect(new StdioServerTransport());
  process.stderr.write(`multiloger-mcp: connected (api=${apiUrl})\n`);
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
