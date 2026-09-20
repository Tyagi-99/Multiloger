#!/usr/bin/env node
/**
 * Multiloger control-plane CLI.
 *
 * `multiloger` (or `pnpm --filter @multiloger/api start`) boots the API
 * server with the built dashboard. Configuration precedence:
 * CLI flag > MULTILOGER_* environment variable > documented default.
 *
 * The API itself stays environment-agnostic: this module is the only place
 * that reads process.env / process.argv for server configuration. Backup
 * key material is intentionally NOT parsed here — startServer() reads
 * MULTILOGER_BACKUP_KEY / MULTILOGER_BACKUP_KEY_FILE itself.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server/index.js';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 3000;
export const DEFAULT_DATA_DIR = './multiloger-data';

export class CliError extends Error {
  readonly code = 'CLI_USAGE';
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}

export interface CliConfig {
  help: boolean;
  version: boolean;
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  chromiumPath?: string;
  /** Dashboard build dir; undefined = API-only mode. */
  webDir?: string;
  headless: boolean;
  /**
   * Opt-in generic webhook URL for monitoring alert transitions
   * (MULTILOGER_MONITORING_WEBHOOK). Unset = no webhook.
   */
  monitoringWebhookUrl?: string;
}

function parsePort(raw: string | undefined, source: string): number {
  if (raw === undefined || raw.length === 0) {
    throw new CliError(`Invalid port from ${source}: expected an integer 1-65535`);
  }
  if (!/^\d+$/.test(raw)) {
    throw new CliError(`Invalid port from ${source}: ${JSON.stringify(raw)} is not an integer`);
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new CliError(
      `Invalid port from ${source}: ${JSON.stringify(raw)} is out of range 1-65535`,
    );
  }
  return port;
}

function parseHeadless(raw: string | undefined): boolean {
  if (raw === undefined) {
    return true;
  }
  const normalized = raw.trim().toLowerCase();
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  throw new CliError(
    `Invalid MULTILOGER_HEADLESS=${JSON.stringify(raw)}: expected true/false, 1/0, yes/no, on/off`,
  );
}

/**
 * Locate the built dashboard for a monorepo layout: this file lives at
 * <repo>/packages/api/dist/cli.js, so <repo>/packages/web/dist is two
 * levels up from the dist dir. Returns undefined when no build is present
 * (API-only mode). `cliFileUrl` is injectable for tests.
 */
export function defaultWebDir(cliFileUrl: string = import.meta.url): string | undefined {
  try {
    const dir = resolve(dirname(fileURLToPath(cliFileUrl)), '..', '..', 'web', 'dist');
    return existsSync(join(dir, 'index.html')) ? dir : undefined;
  } catch {
    return undefined;
  }
}

const HELP_TEXT = `multiloger — control-plane API server + dashboard

Usage:
  multiloger [options]

Options:
  --host <addr>         Bind address (default: 127.0.0.1)
  --port <n>            Port (default: 3000)
  --data-dir <path>     Profile data root (default: ./multiloger-data)
  --db-path <path>      SQLite path (default: <data-dir>/multiloger.db)
  --chromium-path <p>   Chromium binary (default: auto-detect)
  --web-dir <path>      Built dashboard dir (default: auto-detect ../web/dist;
                        missing = API-only mode)
  --no-web              Force API-only mode (no dashboard)
  --headful             Run browsers with a visible UI (default: headless)
  -h, --help            Show this help
  --version             Show the version

Environment (MULTILOGER_*), overridden by flags:
  MULTILOGER_HOST, MULTILOGER_PORT, MULTILOGER_DATA_DIR, MULTILOGER_DB_PATH,
  MULTILOGER_CHROMIUM_PATH, MULTILOGER_WEB_DIR, MULTILOGER_HEADLESS,
  MULTILOGER_BACKUP_KEY, MULTILOGER_BACKUP_KEY_FILE,
  MULTILOGER_VAULT_KEY, MULTILOGER_VAULT_KEY_FILE, MULTILOGER_VAULT_PATH
  (vault key: 64 hex chars, like the backup key; vault path defaults to
  <data-dir>/vault.mlvault and holds proxy credentials encrypted at rest)

On first start with no API tokens, a bootstrap token is printed ONCE —
save it, then create a named token via the dashboard or API.
`;

export function parseCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliConfig {
  let help = false;
  let version = false;
  let host = env.MULTILOGER_HOST;
  let portRaw = env.MULTILOGER_PORT;
  let portSource = 'MULTILOGER_PORT';
  let dataDir = env.MULTILOGER_DATA_DIR;
  let dbPath = env.MULTILOGER_DB_PATH;
  let chromiumPath = env.MULTILOGER_CHROMIUM_PATH;
  let webDir = env.MULTILOGER_WEB_DIR;
  let noWeb = false;
  let headless = parseHeadless(env.MULTILOGER_HEADLESS);
  let monitoringWebhookUrl = env.MULTILOGER_MONITORING_WEBHOOK;

  const takeValue = (flag: string, i: number): string => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('-')) {
      throw new CliError(`${flag} expects a value`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    switch (arg) {
      case '-h':
      case '--help':
        help = true;
        break;
      case '--version':
        version = true;
        break;
      case '--host':
        host = takeValue(arg, i++);
        break;
      case '--port':
        portRaw = takeValue(arg, i++);
        portSource = '--port';
        break;
      case '--data-dir':
        dataDir = takeValue(arg, i++);
        break;
      case '--db-path':
        dbPath = takeValue(arg, i++);
        break;
      case '--chromium-path':
        chromiumPath = takeValue(arg, i++);
        break;
      case '--web-dir':
        webDir = takeValue(arg, i++);
        break;
      case '--no-web':
        noWeb = true;
        break;
      case '--headful':
        headless = false;
        break;
      case '--monitoring-webhook':
        monitoringWebhookUrl = takeValue(arg, i++);
        break;
      default:
        throw new CliError(`Unknown option: ${arg} (see --help)`);
    }
  }

  if (help || version) {
    return {
      help,
      version,
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
      dataDir: DEFAULT_DATA_DIR,
      dbPath: `${DEFAULT_DATA_DIR}/multiloger.db`,
      headless: true,
    };
  }

  const resolvedDataDir = dataDir ?? DEFAULT_DATA_DIR;
  const resolved: CliConfig = {
    help: false,
    version: false,
    host: host ?? DEFAULT_HOST,
    port: portRaw === undefined ? DEFAULT_PORT : parsePort(portRaw, portSource),
    dataDir: resolvedDataDir,
    // An explicit --db-path wins; otherwise the DB lives under the data dir
    // (so --data-dir alone keeps everything together).
    dbPath: dbPath ?? `${resolvedDataDir}/multiloger.db`,
    headless,
  };
  if (chromiumPath !== undefined && chromiumPath.length > 0) {
    resolved.chromiumPath = chromiumPath;
  }
  if (monitoringWebhookUrl !== undefined && monitoringWebhookUrl.length > 0) {
    resolved.monitoringWebhookUrl = monitoringWebhookUrl;
  }
  if (!noWeb) {
    if (webDir !== undefined && webDir.length > 0) {
      // An explicit path that is not a dashboard build is a user error.
      if (!existsSync(join(webDir, 'index.html'))) {
        throw new CliError(`Dashboard directory not found (no index.html): ${webDir}`);
      }
      resolved.webDir = webDir;
    } else {
      // Auto-detect missing is fine — the server runs API-only.
      const detected = defaultWebDir();
      if (detected !== undefined) {
        resolved.webDir = detected;
      }
    }
  }
  return resolved;
}

function readVersion(): string {
  try {
    const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Start the server from a parsed config. Separated for testability. */
export async function runCli(config: CliConfig): Promise<void> {
  if (config.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }
  if (config.version) {
    process.stdout.write(`multiloger ${readVersion()}\n`);
    return;
  }

  const webNote = config.webDir ?? '(API-only: no dashboard build found)';
  // eslint-disable-next-line no-console
  console.log(
    `[multiloger] starting: host=${config.host} port=${String(config.port)} ` +
      `dataDir=${config.dataDir} db=${config.dbPath} ` +
      `chromium=${config.chromiumPath ?? 'auto-detect'} headless=${String(config.headless)} ` +
      `web=${webNote}`,
  );

  // The database file's parent must exist before SQLite opens it.
  mkdirSync(dirname(resolve(config.dbPath)), { recursive: true });

  let server;
  try {
    server = await startServer({
      dbPath: config.dbPath,
      dataDir: config.dataDir,
      host: config.host,
      port: config.port,
      ...(config.chromiumPath !== undefined ? { chromiumPath: config.chromiumPath } : {}),
      headless: config.headless,
      ...(config.webDir !== undefined ? { webDir: config.webDir } : {}),
      ...(config.monitoringWebhookUrl !== undefined
        ? { monitoring: { webhookUrl: config.monitoringWebhookUrl } }
        : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('EADDRINUSE')) {
      throw new CliError(
        `Port ${String(config.port)} is already in use — stop the other process or pick another --port`,
      );
    }
    throw error;
  }

  // eslint-disable-next-line no-console
  console.log(`[multiloger] dashboard: http://${config.host}:${String(server.port)}/`);
  // eslint-disable-next-line no-console
  console.log('[multiloger] Press Ctrl+C to stop.');

  const shutdown = (signal: string): void => {
    // eslint-disable-next-line no-console
    console.log(`[multiloger] ${signal} received — shutting down…`);
    void server.close().then(
      (): void => {
        process.exit(0);
      },
      (): void => {
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', (): void => {
    shutdown('SIGINT');
  });
  process.on('SIGTERM', (): void => {
    shutdown('SIGTERM');
  });
}

async function main(): Promise<void> {
  try {
    const config = parseCliArgs(process.argv.slice(2));
    await runCli(config);
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(`multiloger: ${error.message}\n`);
      process.exit(2);
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`multiloger: failed to start: ${message}\n`);
    process.exit(1);
  }
}

// Only auto-run when executed directly (not when imported by tests).
const invokedPath = process.argv[1] !== undefined ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  void main();
}
