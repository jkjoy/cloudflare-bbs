import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const APP_TABLES = ['settings', 'boards', 'users', 'posts', 'replies', 'likes', 'notifications'];
const DELETE_TABLES = ['likes', 'notifications', 'replies', 'posts', 'users', 'boards', 'settings'];
const CACHE_BUCKETS = ['meta', 'posts', 'notifications', 'admin'];
const DEFAULT_CONFIG_PATH = 'wrangler.toml';
const DEFAULT_OUTPUT_DIR = path.join('backups', 'd1');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command) {
    printHelp();
    return;
  }

  const config = await loadProjectConfig(args.config);
  switch (args.command) {
    case 'backup-local':
      await backupLocal(config, args);
      return;
    case 'import-remote':
      await importRemote(config, args);
      return;
    case 'deploy-with-data':
      await deployWithData(config, args);
      return;
    default:
      throw new Error(`Unknown command: ${args.command}`);
  }
}

function parseArgs(argv) {
  const args = {
    command: '',
    help: false,
    allowEmpty: false,
    skipRemoteBackup: false,
    skipMigrations: false,
    skipDeploy: false,
    skipKvBump: false,
    outputDir: DEFAULT_OUTPUT_DIR,
    config: DEFAULT_CONFIG_PATH,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('-') && !args.command) {
      args.command = arg;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (arg === '--allow-empty') {
      args.allowEmpty = true;
      continue;
    }
    if (arg === '--skip-remote-backup') {
      args.skipRemoteBackup = true;
      continue;
    }
    if (arg === '--skip-migrations') {
      args.skipMigrations = true;
      continue;
    }
    if (arg === '--skip-deploy') {
      args.skipDeploy = true;
      continue;
    }
    if (arg === '--skip-kv-bump') {
      args.skipKvBump = true;
      continue;
    }
    if (arg === '--input' || arg === '-i') {
      args.input = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--output' || arg === '-o') {
      args.output = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--output-dir') {
      args.outputDir = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--config' || arg === '-c') {
      args.config = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--database') {
      args.database = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--kv-binding') {
      args.kvBinding = requireValue(argv, index, arg);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function printHelp() {
  console.log('Usage: node scripts/d1-sync.mjs <command> [options]');
  console.log('');
  console.log('Commands:');
  console.log('  backup-local      Export the current local D1 database to a SQL file');
  console.log('  import-remote     Generate or use a SQL file and import it into the remote D1 database');
  console.log('  deploy-with-data  Backup local D1, import its data into remote D1, then deploy the Worker');
  console.log('');
  console.log('Common options:');
  console.log('  --config <path>       Wrangler config path, default: wrangler.toml');
  console.log('  --output-dir <path>   Backup directory, default: backups/d1');
  console.log('  --database <name>     Override D1 database name');
  console.log('  --kv-binding <name>   Override KV binding name, default from wrangler.toml');
  console.log('');
  console.log('backup-local options:');
  console.log('  --output <path>       Output SQL file path');
  console.log('');
  console.log('import-remote options:');
  console.log('  --input <path>        Use an existing SQL file instead of exporting from local D1');
  console.log('  --allow-empty         Allow importing an empty local export and clear remote data');
  console.log('  --skip-remote-backup  Skip exporting the current remote D1 backup before import');
  console.log('  --skip-migrations     Skip `wrangler d1 migrations apply --remote`');
  console.log('  --skip-kv-bump        Skip bumping remote KV cache versions after import');
  console.log('');
  console.log('deploy-with-data options:');
  console.log('  --allow-empty         Allow importing an empty local export and clear remote data');
  console.log('  --skip-remote-backup  Skip exporting the current remote D1 backup before import');
  console.log('  --skip-migrations     Skip `wrangler d1 migrations apply --remote`');
  console.log('  --skip-kv-bump        Skip bumping remote KV cache versions after import');
  console.log('  --skip-deploy         Only sync the remote D1 data, do not deploy the Worker');
}

async function loadProjectConfig(configPathArg) {
  const configPath = path.resolve(process.cwd(), configPathArg ?? DEFAULT_CONFIG_PATH);
  const raw = await fs.readFile(configPath, 'utf8');
  const d1Block = findTomlBlock(raw, 'd1_databases');
  const kvBlock = findTomlBlock(raw, 'kv_namespaces');
  return {
    configPath,
    databaseName: readTomlValue(d1Block, 'database_name') ?? 'micro-bbs',
    kvBinding: readTomlValue(kvBlock, 'binding') ?? 'FORUM_KV',
  };
}

function findTomlBlock(raw, sectionName) {
  const match = raw.match(new RegExp(String.raw`\[\[${sectionName}\]\]([\s\S]*?)(?=\n\[\[|\n\[|$)`));
  return match?.[1] ?? '';
}

function readTomlValue(block, key) {
  const match = block.match(new RegExp(String.raw`^\s*${key}\s*=\s*"([^"]+)"`, 'm'));
  return match?.[1] ?? null;
}

async function backupLocal(config, args) {
  const databaseName = args.database ?? config.databaseName;
  const outputDir = path.resolve(process.cwd(), args.outputDir ?? DEFAULT_OUTPUT_DIR);
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = args.output
    ? path.resolve(process.cwd(), args.output)
    : path.join(outputDir, `local-${timestamp()}.sql`);

  await exportDatabase({
    databaseName,
    location: 'local',
    outputPath,
    tables: APP_TABLES,
  });

  const summary = await summarizeSqlFile(outputPath);
  console.log(`Local D1 backup written to ${relativeToCwd(outputPath)}`);
  if (summary.isEffectivelyEmpty) {
    console.log('Warning: the current local D1 export contains no application schema or data.');
    console.log('This usually means the default local D1 database has not been initialized yet.');
  }
}

async function importRemote(config, args) {
  const databaseName = args.database ?? config.databaseName;
  const kvBinding = args.kvBinding ?? config.kvBinding;
  const outputDir = path.resolve(process.cwd(), args.outputDir ?? DEFAULT_OUTPUT_DIR);
  await fs.mkdir(outputDir, { recursive: true });

  const inputPath = args.input
    ? path.resolve(process.cwd(), args.input)
    : (await buildRemoteImportSql({
      databaseName,
      outputDir,
      allowEmpty: args.allowEmpty,
    })).importPath;

  const importSummary = await summarizeSqlFile(inputPath);
  if (importSummary.isEffectivelyEmpty && !args.allowEmpty) {
    throw new Error('The import SQL is empty. Re-run with --allow-empty if you really want to clear remote data.');
  }

  if (!args.skipRemoteBackup) {
    const remoteBackupPath = path.join(outputDir, `remote-before-import-${timestamp()}.sql`);
    await exportDatabase({
      databaseName,
      location: 'remote',
      outputPath: remoteBackupPath,
      tables: APP_TABLES,
    });
    console.log(`Remote D1 backup written to ${relativeToCwd(remoteBackupPath)}`);
  }

  if (!args.skipMigrations) {
    await runCommand('npx', ['wrangler', 'd1', 'migrations', 'apply', databaseName, '--remote'], {
      env: { CI: '1' },
    });
  }

  const remoteReadyPath = await writeRemoteReadySql(inputPath, outputDir);
  await runCommand('npx', ['wrangler', 'd1', 'execute', databaseName, '--remote', '--file', remoteReadyPath, '--yes']);
  console.log(`Remote D1 import completed from ${relativeToCwd(remoteReadyPath)}`);

  if (!args.skipKvBump) {
    await bumpRemoteKvCaches(kvBinding);
  }
}

async function deployWithData(config, args) {
  const databaseName = args.database ?? config.databaseName;
  const outputDir = path.resolve(process.cwd(), args.outputDir ?? DEFAULT_OUTPUT_DIR);
  await fs.mkdir(outputDir, { recursive: true });

  const localBackupPath = args.output
    ? path.resolve(process.cwd(), args.output)
    : path.join(outputDir, `local-${timestamp()}.sql`);

  await exportDatabase({
    databaseName,
    location: 'local',
    outputPath: localBackupPath,
    tables: APP_TABLES,
  });
  console.log(`Local D1 backup written to ${relativeToCwd(localBackupPath)}`);

  await importRemote(config, {
    ...args,
    database: databaseName,
    outputDir,
  });

  if (!args.skipDeploy) {
    await runCommand('npx', ['wrangler', 'deploy']);
    console.log('Worker deploy completed.');
  }
}

async function buildRemoteImportSql({ databaseName, outputDir, allowEmpty }) {
  const stamp = timestamp();
  const tempDir = path.join(outputDir, `.tmp-import-${stamp}`);
  const dataExportPath = path.join(outputDir, `local-${stamp}.data.sql`);
  const importPath = path.join(outputDir, `local-${stamp}.remote-import.sql`);
  await fs.mkdir(tempDir, { recursive: true });

  try {
    const chunks = [];
    for (const tableName of APP_TABLES) {
      const tablePath = path.join(tempDir, `${tableName}.sql`);
      await exportDatabase({
        databaseName,
        location: 'local',
        outputPath: tablePath,
        tables: [tableName],
        noSchema: true,
      });
      const tableSql = stripExportPreamble(await fs.readFile(tablePath, 'utf8'));
      if (hasExecutableSql(tableSql)) {
        chunks.push(`-- ${tableName}\n${tableSql.trim()}`);
      }
    }

    const mergedDataSql = chunks.length > 0 ? `${chunks.join('\n\n')}\n` : '';
    await fs.writeFile(dataExportPath, mergedDataSql || 'PRAGMA defer_foreign_keys=TRUE;\n', 'utf8');

    if (!mergedDataSql && !allowEmpty) {
      throw new Error('The current local D1 export is empty. Aborted before touching remote D1. Use --allow-empty to force a remote reset.');
    }

    const importSql = renderRemoteImportSql(mergedDataSql);
    await fs.writeFile(importPath, importSql, 'utf8');

    console.log(`Local D1 data export written to ${relativeToCwd(dataExportPath)}`);
    console.log(`Remote import SQL written to ${relativeToCwd(importPath)}`);
    return { dataExportPath, importPath };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function renderRemoteImportSql(dataSql) {
  const sanitizedDataSql = sanitizeForRemoteExecute(dataSql);
  const lines = [
    '-- Generated by scripts/d1-sync.mjs',
    `-- Generated at: ${new Date().toISOString()}`,
    'PRAGMA defer_foreign_keys=TRUE;',
    ...DELETE_TABLES.map((tableName) => `DELETE FROM ${tableName};`),
  ];

  if (hasExecutableSql(sanitizedDataSql)) {
    lines.push(sanitizedDataSql.trim());
  }

  return `${lines.join('\n')}\n`;
}

async function exportDatabase({
  databaseName,
  location,
  outputPath,
  tables = APP_TABLES,
  noSchema = false,
}) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const args = ['wrangler', 'd1', 'export', databaseName, `--${location}`, '--output', outputPath];
  if (noSchema) {
    args.push('--no-schema');
  }
  for (const tableName of tables) {
    args.push('--table', tableName);
  }
  await runCommand('npx', args);
}

async function bumpRemoteKvCaches(kvBinding) {
  const version = String(Math.floor(Date.now() / 1000));
  for (const bucket of CACHE_BUCKETS) {
    await runCommand('npx', ['wrangler', 'kv', 'key', 'put', `cache-version:${bucket}`, version, '--binding', kvBinding, '--remote']);
  }
  await runCommand('npx', ['wrangler', 'kv', 'key', 'delete', 'cache:has-admin', '--binding', kvBinding, '--remote']);
  console.log(`Remote KV cache versions bumped via binding ${kvBinding}.`);
}

async function summarizeSqlFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return {
    bytes: Buffer.byteLength(raw, 'utf8'),
    isEffectivelyEmpty: !hasExecutableSql(stripExportPreamble(raw)),
  };
}

async function writeRemoteReadySql(inputPath, outputDir) {
  const raw = await fs.readFile(inputPath, 'utf8');
  const sanitized = sanitizeForRemoteExecute(raw);
  const remoteReadyPath = path.join(outputDir, `${path.basename(inputPath, path.extname(inputPath))}.remote-ready.sql`);
  await fs.writeFile(remoteReadyPath, sanitized, 'utf8');
  console.log(`Remote-ready SQL written to ${relativeToCwd(remoteReadyPath)}`);
  return remoteReadyPath;
}

function stripExportPreamble(raw) {
  return String(raw)
    .replace(/^\s*PRAGMA defer_foreign_keys=TRUE;\s*/iu, '')
    .trim();
}

function sanitizeForRemoteExecute(raw) {
  const body = String(raw)
    .replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*(?:OFF|ON)\s*;\s*$/gimu, '')
    .replace(/^\s*PRAGMA\s+defer_foreign_keys\s*=\s*TRUE\s*;\s*$/gimu, '')
    .replace(/^\s*BEGIN(?:\s+TRANSACTION)?\s*;\s*$/gimu, '')
    .replace(/^\s*COMMIT\s*;\s*$/gimu, '')
    .trim();
  if (!body) {
    return 'PRAGMA defer_foreign_keys=TRUE;\n';
  }
  return `PRAGMA defer_foreign_keys=TRUE;\n${body}\n`;
}

function hasExecutableSql(raw) {
  return stripSqlComments(String(raw)).trim().length > 0;
}

function stripSqlComments(raw) {
  return raw
    .replace(/^\s*--.*$/gmu, '')
    .trim();
}

function timestamp() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hour = String(now.getHours()).padStart(2, '0');
  const minute = String(now.getMinutes()).padStart(2, '0');
  const second = String(now.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}-${hour}${minute}${second}`;
}

function relativeToCwd(filePath) {
  return path.relative(process.cwd(), filePath) || path.basename(filePath);
}

async function runCommand(command, args, options = {}) {
  const env = {
    ...process.env,
    ...options.env,
  };
  const commandLine = [command, ...args.map(quoteForShell)].join(' ');
  console.log(`> ${commandLine}`);
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.platform === 'win32' ? 'cmd.exe' : command,
      process.platform === 'win32' ? ['/d', '/s', '/c', commandLine] : args,
      {
        cwd: process.cwd(),
        stdio: 'inherit',
        windowsHide: true,
        env,
      },
    );

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve(undefined);
        return;
      }
      reject(new Error(`${command} exited with code ${code ?? 'null'}${signal ? ` (signal: ${signal})` : ''}`));
    });
  });
}

function quoteForShell(value) {
  const stringValue = String(value);
  if (!stringValue) {
    return '""';
  }
  if (process.platform === 'win32') {
    return /[\s"&()^<>|]/u.test(stringValue)
      ? `"${stringValue.replace(/"/g, '""')}"`
      : stringValue;
  }
  return /[\s"'\\$`]/u.test(stringValue)
    ? `'${stringValue.replace(/'/g, `'\\''`)}'`
    : stringValue;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
