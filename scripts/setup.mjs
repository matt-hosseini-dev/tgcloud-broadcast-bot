#!/usr/bin/env node
// One-command setup and deploy: `npm run setup`.
// Asks for the owner ids, links the project to your bot (tgcloud login asks for
// the CLI access token itself; this script never sees it), then deploys.
// Safe to re-run: it updates the owners and redeploys.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseOwnerIds, readEnvFile, writeConfig } from './write-config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = join(ROOT, '.env');

/** .env contents with `updates` applied, other keys kept. */
export function renderEnv(current, updates) {
  const merged = { ...current, ...updates };
  return Object.entries(merged)
    .map(([k, v]) => `${k}=${v}\n`)
    .join('');
}

export function nodeMajorOk(version) {
  const [major, minor] = version.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 15);
}

const step = (text) => console.log(`\n▸ ${text}`);

function run(cmd, args) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) throw new Error(`"${cmd} ${args.join(' ')}" failed.`);
}

async function askOwners() {
  const current = readEnvFile(ENV_FILE).OWNER_IDS;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('Owners manage targets and broadcasters. Get your id from @userinfobot.');
    for (;;) {
      const hint = current ? ` [${current}]` : '';
      const answer = (
        await rl.question(`Owner Telegram user ids, comma separated${hint}: `)
      ).trim();
      const raw = answer || current;
      try {
        return parseOwnerIds(raw).join(',');
      } catch (err) {
        console.log(`  ${err.message}`);
      }
    }
  } finally {
    rl.close();
  }
}

async function main() {
  if (!nodeMajorOk(process.versions.node)) {
    throw new Error(`Node.js 22.15+ is required (you have ${process.versions.node}).`);
  }
  if (!existsSync(join(ROOT, 'node_modules/@tgcloud/cli'))) {
    step('Installing dependencies');
    run('npm', ['install']);
  }

  step('Owners');
  const owners = await askOwners();
  writeFileSync(ENV_FILE, renderEnv(readEnvFile(ENV_FILE), { OWNER_IDS: owners }));
  writeConfig();

  // Marks this folder as the tgcloud project root.
  mkdirSync(join(ROOT, '.tgcloud'), { recursive: true });
  if (!process.env.TGCLOUD_TOKEN && !existsSync(join(ROOT, '.tgcloud/credentials'))) {
    step('Link your bot (@BotFather → your bot → Serverless → CLI Access → token)');
    run('npx', ['tgcloud', 'login']);
  }

  step('Deploying');
  run('npx', ['tgcloud', 'push']);
  step('Creating database tables');
  run('npx', ['tgcloud', 'migrate', '--safe']);

  console.log('\n✅ Done. Open your bot in Telegram and send /start.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`\n✖ ${err.message}`);
    process.exit(1);
  });
}
