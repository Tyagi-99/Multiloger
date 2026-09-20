/**
 * Tests for the CLI argument / environment parsing (api/cli.ts), written
 * first. The parse function is pure: argv + env in, validated config out.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CliError, defaultWebDir, parseCliArgs } from './cli.js';

const BASE_ENV: NodeJS.ProcessEnv = {};

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('parseCliArgs', () => {
  it('applies documented defaults', () => {
    const config = parseCliArgs([], BASE_ENV);
    expect(config.help).toBe(false);
    expect(config.version).toBe(false);
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(3000);
    expect(config.dataDir).toBe('./multiloger-data');
    expect(config.dbPath).toBe('./multiloger-data/multiloger.db');
    expect(config.headless).toBe(true);
    expect(config.chromiumPath).toBeUndefined();
  });

  it('reads configuration from MULTILOGER_* environment variables', () => {
    const config = parseCliArgs([], {
      ...BASE_ENV,
      MULTILOGER_HOST: '0.0.0.0',
      MULTILOGER_PORT: '4000',
      MULTILOGER_DATA_DIR: '/srv/data',
      MULTILOGER_DB_PATH: '/srv/data/custom.db',
      MULTILOGER_CHROMIUM_PATH: '/usr/bin/chromium',
      MULTILOGER_HEADLESS: 'false',
    });
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(4000);
    expect(config.dataDir).toBe('/srv/data');
    expect(config.dbPath).toBe('/srv/data/custom.db');
    expect(config.chromiumPath).toBe('/usr/bin/chromium');
    expect(config.headless).toBe(false);
  });

  it('lets CLI flags override environment variables', () => {
    const config = parseCliArgs(['--port', '5000', '--host', '10.0.0.1', '--headful'], {
      ...BASE_ENV,
      MULTILOGER_PORT: '4000',
    });
    expect(config.port).toBe(5000);
    expect(config.host).toBe('10.0.0.1');
    expect(config.headless).toBe(false);
  });

  it('supports --data-dir, --db-path, --chromium-path, --web-dir', () => {
    const webDir = mkdtempSync(join(tmpdir(), 'multiloger-web-'));
    tempDirs.push(webDir);
    writeFileSync(join(webDir, 'index.html'), '<html></html>');
    const config = parseCliArgs(
      ['--data-dir', '/d', '--db-path', '/d/x.db', '--chromium-path', '/c', '--web-dir', webDir],
      BASE_ENV,
    );
    expect(config.dataDir).toBe('/d');
    expect(config.dbPath).toBe('/d/x.db');
    expect(config.chromiumPath).toBe('/c');
    expect(config.webDir).toBe(webDir);
  });

  it('rejects an explicit --web-dir that is not a dashboard build', () => {
    expect(() => parseCliArgs(['--web-dir', '/definitely/not/here'], BASE_ENV)).toThrow(CliError);
  });

  it('accepts --no-web to force API-only mode', () => {
    const config = parseCliArgs(['--no-web'], BASE_ENV);
    expect(config.webDir).toBeUndefined();
  });

  it('rejects invalid ports', () => {
    expect(() => parseCliArgs(['--port', 'abc'], BASE_ENV)).toThrow(CliError);
    expect(() => parseCliArgs(['--port', '0'], BASE_ENV)).toThrow(CliError);
    expect(() => parseCliArgs(['--port', '70000'], BASE_ENV)).toThrow(CliError);
    expect(() => parseCliArgs(['--port'], BASE_ENV)).toThrow(CliError);
    expect(() => parseCliArgs([], { ...BASE_ENV, MULTILOGER_PORT: 'nope' })).toThrow(CliError);
  });

  it('rejects unknown flags', () => {
    expect(() => parseCliArgs(['--frobnicate'], BASE_ENV)).toThrow(CliError);
  });

  it('parses --help and --version without requiring anything else', () => {
    expect(parseCliArgs(['--help'], BASE_ENV).help).toBe(true);
    expect(parseCliArgs(['--version'], BASE_ENV).version).toBe(true);
    expect(parseCliArgs(['-h'], BASE_ENV).help).toBe(true);
  });

  it('treats MULTILOGER_HEADLESS truthy/falsy spellings sanely', () => {
    expect(parseCliArgs([], { ...BASE_ENV, MULTILOGER_HEADLESS: '0' }).headless).toBe(false);
    expect(parseCliArgs([], { ...BASE_ENV, MULTILOGER_HEADLESS: 'no' }).headless).toBe(false);
    expect(parseCliArgs([], { ...BASE_ENV, MULTILOGER_HEADLESS: '1' }).headless).toBe(true);
  });

  it('derives dbPath from dataDir when only dataDir is given', () => {
    const config = parseCliArgs(['--data-dir', '/srv/ml'], BASE_ENV);
    expect(config.dbPath).toBe('/srv/ml/multiloger.db');
  });
});

describe('defaultWebDir', () => {
  it('returns undefined when no dashboard build exists', () => {
    expect(defaultWebDir('file:///definitely/not/here/cli.js')).toBeUndefined();
  });
});
