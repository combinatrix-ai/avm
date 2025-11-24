#!/usr/bin/env node

const { Command } = require('commander');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const https = require('https');

const pkg = require('../package.json');

const AVM_HOME = process.env.AVM_HOME || path.join(os.homedir(), '.avm');
const AGENTS_DIR = path.join(AVM_HOME, 'agents');
const STATE_FILE = path.join(AVM_HOME, 'state.json');
const SUPPORTED_AGENTS = new Set(['codex', 'claude', 'gemini']);
const DEFAULT_PACKAGES = {
  codex: '@openai/codex',
  claude: '@anthropic-ai/claude-code',
  gemini: '@google/gemini-cli',
};
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day

const program = new Command();

program
  .name('avm')
  .description(
    'A minimal version manager for AI coding agents (npx/npm based). Supported: codex, claude, gemini.'
  )
  .version(pkg.version, '-v, -V, --version');

function normalizeAgentName(name) {
  return (name || '').trim().toLowerCase();
}

function sanitizeName(name) {
  return name.replace(/[\\/]/g, '__');
}

function unsanitizeName(name) {
  return name.replace(/__/g, '/');
}

function assertSupportedAgent(name) {
  if (!SUPPORTED_AGENTS.has(name)) {
    const supported = Array.from(SUPPORTED_AGENTS).join(', ');
    throw new Error(`Unsupported agent "${name}". Supported agents: ${supported}.`);
  }
}

function resolvePackageName(name, { packageOverride, configPackage, statePackage }) {
  if (packageOverride) return packageOverride;
  if (configPackage) return configPackage;
  if (statePackage) return statePackage;
  const builtin = DEFAULT_PACKAGES[name];
  if (builtin) return builtin;
  throw new Error(
    `No npm package configured for agent "${name}". ` +
      `Specify with --package or configure it in avm.config.json.`
  );
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureBaseDirs() {
  await fs.mkdir(AGENTS_DIR, { recursive: true });
}

async function readJson(file, fallback = null) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

function parseAgentSpec(input) {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const atIndex = trimmed.lastIndexOf('@');
  if (atIndex > 0) {
    const name = normalizeAgentName(trimmed.slice(0, atIndex));
    const version = trimmed.slice(atIndex + 1);
    if (!name) return null;
    if (!version) return { name };
    return { name, version };
  }
  const name = normalizeAgentName(trimmed);
  if (!name) return null;
  return { name };
}

function parseArgsString(argString) {
  if (!argString || typeof argString !== 'string') return [];
  return argString
    .split(' ')
    .map((part) => part.trim())
    .filter(Boolean);
}

async function findConfigFile(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  // Walk up until root
  while (true) {
    const candidate = path.join(dir, 'avm.config.json');
    if (await pathExists(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function loadProjectConfig(cwd = process.cwd()) {
  const config = { default: null, agents: {}, path: null };
  const configPath = await findConfigFile(cwd);
  if (!configPath) return config;

  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    config.path = configPath;
    if (parsed.default && typeof parsed.default === 'object' && parsed.default.name) {
      const normalizedDefault = normalizeAgentName(parsed.default.name);
      assertSupportedAgent(normalizedDefault);
      config.default = normalizedDefault;
    }
    for (const [name, value] of Object.entries(parsed)) {
      if (name === 'default') continue;
      if (value && typeof value === 'object') {
        const normalizedName = normalizeAgentName(name);
        if (!normalizedName) continue;
        assertSupportedAgent(normalizedName);
        config.agents[normalizedName] = {
          package: value.package || value.pkg || null,
          version: value.version || null,
          args: value.args || '',
        };
      }
    }
  } catch (err) {
    throw new Error(`Failed to parse ${configPath}: ${err.message}`);
  }

  return config;
}

async function writeProjectConfig(config, targetPath) {
  const data = {};

  if (config.default) {
    data.default = { name: config.default };
  }

  const agents = config.agents || {};
  for (const [name, agent] of Object.entries(agents)) {
    const section = {};
    if (agent.package) section.package = agent.package;
    if (agent.version) section.version = agent.version;
    if (agent.args) section.args = agent.args;
    data[name] = section;
  }

  const content = JSON.stringify(data, null, 2) + '\n';
  await fs.writeFile(targetPath, content);
}

async function readState() {
  return (await readJson(STATE_FILE, {})) || {};
}

async function writeState(patch) {
  const previous = (await readJson(STATE_FILE, {})) || {};
  const next = { ...previous, ...patch, updatedAt: new Date().toISOString() };
  await writeJson(STATE_FILE, next);
}

function agentDir(name) {
  return path.join(AGENTS_DIR, sanitizeName(name));
}

function installDir(name, version) {
  return path.join(agentDir(name), version);
}

async function listInstalledAgents() {
  const results = [];
  try {
    const agentDirs = await fs.readdir(AGENTS_DIR, { withFileTypes: true });
    for (const entry of agentDirs) {
      if (!entry.isDirectory()) continue;
      const safeName = entry.name;
      const versionsDir = path.join(AGENTS_DIR, safeName);
      const versions = await fs.readdir(versionsDir, { withFileTypes: true });
      for (const versionEntry of versions) {
        if (!versionEntry.isDirectory()) continue;
        const version = versionEntry.name;
        const installPath = path.join(versionsDir, version);
        const meta = await readJson(path.join(installPath, '.meta.json'), null);
        results.push({
          name: meta?.name || unsanitizeName(safeName),
          package: meta?.package || meta?.name || unsanitizeName(safeName),
          version,
          args: meta?.args || '',
          path: installPath,
          installedAt: meta?.installedAt,
        });
      }
    }
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return results;
}

async function npmInstall(installPath, pkgSpec, registry) {
  await fs.mkdir(installPath, { recursive: true });
  const args = [
    'install',
    '--prefix',
    installPath,
    '--no-package-lock',
    '--no-progress',
    '--no-fund',
    pkgSpec,
  ];
  if (registry) {
    args.push('--registry', registry);
  }

  await runCommand('npm', args, { stdio: 'inherit' });
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
      }
    });
    child.on('error', (err) => reject(err));
  });
}

function isNewerVersion(remote, local) {
  if (!remote || !local) return false;
  const r = remote.split('.');
  const l = local.split('.');
  const len = Math.max(r.length, l.length);
  for (let i = 0; i < len; i += 1) {
    const rv = parseInt(r[i] || '0', 10);
    const lv = parseInt(l[i] || '0', 10);
    if (Number.isNaN(rv) || Number.isNaN(lv)) {
      return remote !== local;
    }
    if (rv > lv) return true;
    if (rv < lv) return false;
  }
  return false;
}

function fetchLatestAvmVersion() {
  const url = 'https://registry.npmjs.org/@combinatrix-ai%2Favm/latest';
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          Accept: 'application/vnd.npm.install-v1+json, application/json',
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(
            new Error(`Unexpected status code ${res.statusCode} from npm registry`)
          );
        }
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            resolve(parsed.version || null);
          } catch (err) {
            reject(err);
          }
        });
        return null;
      }
    );
    req.on('error', (err) => reject(err));
    req.setTimeout(3000, () => {
      req.destroy(new Error('Timeout while checking npm registry for avm updates'));
    });
  });
}

async function maybeNotifySelfUpdate() {
  if (process.env.AVM_NO_UPDATE_CHECK) return;

  try {
    const state = await readState();
    const selfState = state.self || {};

    const now = Date.now();
    if (selfState.lastUpdateCheck) {
      const last = Date.parse(selfState.lastUpdateCheck);
      if (!Number.isNaN(last) && now - last < UPDATE_CHECK_INTERVAL_MS) {
        return;
      }
    }

    let latestVersion = null;
    try {
      latestVersion = await fetchLatestAvmVersion();
    } catch (err) {
      if (process.env.AVM_DEBUG) {
        console.warn(`Warning: failed to check for avm updates: ${err.message}`);
      }
    }

    const nextSelfState = {
      ...selfState,
      lastUpdateCheck: new Date(now).toISOString(),
      ...(latestVersion ? { latestVersion } : {}),
    };

    try {
      await writeState({ self: nextSelfState });
    } catch (err) {
      if (process.env.AVM_DEBUG) {
        console.warn(`Warning: failed to write avm state: ${err.message}`);
      }
    }

    if (latestVersion && isNewerVersion(latestVersion, pkg.version)) {
      console.log(
        `A new version of avm is available: ${pkg.version} → ${latestVersion}.`
      );
      console.log(
        `Update with: npm install -g ${pkg.name}@latest    # or: avm self-update`
      );
    }
  } catch (err) {
    if (process.env.AVM_DEBUG) {
      console.warn(`Warning: self-update check failed: ${err.message}`);
    }
  }
}

async function ensureInstalled(target, { registry } = {}) {
  await ensureBaseDirs();
  const installPath = installDir(target.name, target.version);
  const metaPath = path.join(installPath, '.meta.json');
  const hasInstall = await pathExists(installPath);
  const existingMeta = hasInstall ? (await readJson(metaPath, null)) || null : null;

  const needsReinstall =
    !hasInstall ||
    !existingMeta ||
    existingMeta.package !== target.package ||
    existingMeta.version !== target.version;

  if (needsReinstall) {
    if (hasInstall) {
      await fs.rm(installPath, { recursive: true, force: true });
    }
    const pkgSpec = `${target.package}@${target.version}`;
    console.log(`> Installing ${pkgSpec} into ${installPath}`);
    await npmInstall(installPath, pkgSpec, registry);
    const meta = { ...target, installedAt: new Date().toISOString() };
    await writeJson(metaPath, meta);
    return { installPath, meta };
  }

  const mergedMeta = {
    ...existingMeta,
    name: target.name,
    package: target.package,
    version: target.version,
    args: target.args || existingMeta.args || '',
  };
  if (
    mergedMeta.name !== existingMeta.name ||
    mergedMeta.package !== existingMeta.package ||
    mergedMeta.version !== existingMeta.version ||
    mergedMeta.args !== existingMeta.args
  ) {
    await writeJson(metaPath, mergedMeta);
  }
  return { installPath, meta: mergedMeta };
}

async function findAgentBinary(installPath, packageName) {
  const pkgJsonPath = path.join(installPath, 'node_modules', packageName, 'package.json');
  let binRelative = null;

  try {
    const raw = await fs.readFile(pkgJsonPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.bin === 'string') {
      binRelative = parsed.bin;
    } else if (parsed.bin && typeof parsed.bin === 'object') {
      const binEntry = Object.values(parsed.bin)[0];
      binRelative = binEntry;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`Warning: unable to read ${pkgJsonPath}: ${err.message}`);
    }
  }

  if (binRelative) {
    const candidate = path.join(installPath, 'node_modules', packageName, binRelative);
    if (await pathExists(candidate)) return candidate;
  }

  const fallbackName = packageName.includes('/')
    ? packageName.split('/').pop()
    : packageName;
  const fallback = path.join(installPath, 'node_modules', '.bin', fallbackName);
  if (await pathExists(fallback)) return fallback;

  return null;
}

function resolveTarget(agentArg, config, state, { packageOverride, argsOverride } = {}) {
  const parsed = parseAgentSpec(agentArg);
  const rawName = parsed?.name || config.default || state.current?.name;
  const name = normalizeAgentName(rawName);
  if (!name) {
    throw new Error('No agent specified. Use avm <agent>, avm global <agent>, or configure avm.config.json.');
  }
  assertSupportedAgent(name);

  const fromConfig = config.agents[name] || {};
  const currentForAgent =
    state.current && normalizeAgentName(state.current.name) === name
      ? state.current
      : null;
  const packageName = resolvePackageName(name, {
    packageOverride,
    configPackage: fromConfig.package,
    statePackage: currentForAgent?.package,
  });
  const version = parsed?.version || fromConfig.version || currentForAgent?.version || 'latest';
  const args = argsOverride || fromConfig.args || currentForAgent?.args || '';

  return {
    name,
    package: packageName,
    version,
    args,
  };
}

async function setCurrent(target) {
  await writeState({ current: target });
}

async function listAction(options) {
  const [config, state, installed] = await Promise.all([
    loadProjectConfig(),
    readState(),
    listInstalledAgents(),
  ]);

  if (options && options.remote) {
    const installedNames = new Set(
      installed
        .map((agent) => normalizeAgentName(agent.name))
        .filter((name) => SUPPORTED_AGENTS.has(name))
    );
    const configAgents = config.agents || {};

    for (const name of Array.from(SUPPORTED_AGENTS).sort()) {
      const fromConfig = configAgents[name] || {};
      const packageName = resolvePackageName(name, {
        packageOverride: null,
        configPackage: fromConfig.package,
        statePackage: null,
      });
      const isInstalled = installedNames.has(name);
      const marker = isInstalled ? '*' : ' ';
      console.log(
        `${marker} ${name} (${packageName})` + (isInstalled ? ' [installed]' : '')
      );
    }
    return;
  }

  const current = state.current ? { ...state.current, name: normalizeAgentName(state.current.name) } : null;
  const supportedInstalled = installed.filter((agent) =>
    SUPPORTED_AGENTS.has(normalizeAgentName(agent.name))
  );
  if (!supportedInstalled.length) {
    console.log('No supported agents installed yet (codex, claude, gemini). Try `avm install codex`.');
    return;
  }

  for (const agent of supportedInstalled) {
    const normalizedName = normalizeAgentName(agent.name);
    const isCurrent =
      current &&
      current.name === normalizedName &&
      current.version === agent.version;
    const marker = isCurrent ? '*' : ' ';
    console.log(
      `${marker} ${normalizedName}@${agent.version} (${agent.package})` +
        (agent.args ? ` args="${agent.args}"` : '')
    );
  }

  if (config.default) {
    console.log(`Project default: ${config.default}${config.path ? ` (${config.path})` : ''}`);
  }
}

async function installAction(agentArg, options) {
  const config = await loadProjectConfig();
  const state = await readState();
  const target = resolveTarget(agentArg, config, state, { packageOverride: options.package });
  const { meta } = await ensureInstalled(target, { registry: options.registry });
  console.log(
    `Installed ${meta.name}@${meta.version} (${meta.package})` +
      (meta.args ? ` with args="${meta.args}"` : '')
  );
}

async function globalAction(agentArg, options) {
  const config = await loadProjectConfig();
  const state = await readState();
  const target = resolveTarget(agentArg, config, state, {
    packageOverride: options.package,
    argsOverride: options.args,
  });
  const { meta } = await ensureInstalled(target, { registry: options.registry });
  await setCurrent(meta);
  console.log(
    `Set global default to ${meta.name}@${meta.version} (${meta.package})` +
      (meta.args ? ` with args="${meta.args}"` : '')
  );
}

async function localAction(agentArg, options) {
  const config = await loadProjectConfig();
  const parsed = parseAgentSpec(agentArg);
  if (!parsed || !parsed.name) {
    throw new Error('Agent spec required. Example: codex or codex@0.45.1');
  }

  const name = normalizeAgentName(parsed.name);
  assertSupportedAgent(name);

  config.default = name;
  const agents = config.agents || {};
  if (!agents[name]) {
    agents[name] = {
      package: null,
      version: null,
      args: '',
    };
  }

  if (parsed.version) {
    agents[name].version = parsed.version;
  }

  if (options && typeof options.args === 'string') {
    agents[name].args = options.args;
  }

  config.agents = agents;

  const targetPath = config.path || path.join(process.cwd(), 'avm.config.json');
  await writeProjectConfig(config, targetPath);

  const versionPart = parsed.version ? `@${parsed.version}` : '';
  const argsPart = agents[name].args ? ` with args="${agents[name].args}"` : '';
  console.log(`Set local default to ${name}${versionPart} in ${targetPath}${argsPart}`);
}

async function currentAction() {
  const state = await readState();
  if (!state.current) {
    console.log('No active agent. Run `avm use <agent>`.');
    return;
  }
  const curr = state.current;
  const normalizedName = normalizeAgentName(curr.name);
  if (!SUPPORTED_AGENTS.has(normalizedName)) {
    console.log(
      `Current agent "${curr.name}" is not supported. Use one of: codex, claude, gemini.`
    );
    return;
  }
  console.log(
    `${normalizedName}@${curr.version} (${curr.package})` +
      (curr.args ? ` args="${curr.args}"` : '')
  );
}

async function runAction(agentArg, agentArgs, options) {
  const config = await loadProjectConfig();
  const state = await readState();
  const target = resolveTarget(agentArg, config, state, { packageOverride: options.package });
  const { meta, installPath } = await ensureInstalled(target, { registry: options.registry });
  await setCurrent(meta);

  const binPath = await findAgentBinary(installPath, meta.package);
  if (!binPath) {
    throw new Error(
      `Unable to find executable for ${meta.package}. ` +
        `Is the package's "bin" field set? Install path: ${installPath}`
    );
  }

  const combinedArgs = [...parseArgsString(meta.args), ...(agentArgs || [])];
  console.log(
    `> Running ${meta.name}@${meta.version} (${meta.package}) from ${installPath}` +
      (combinedArgs.length ? ` with args: ${combinedArgs.join(' ')}` : '')
  );
  await runCommand(binPath, combinedArgs, { stdio: 'inherit' });
}

async function selfUpdateAction(options) {
  const target = (options && options.to) || 'latest';
  const spec = `${pkg.name}@${target}`;
  console.log(`> Updating ${pkg.name} to ${target} via npm -g`);
  await runCommand('npm', ['install', '-g', spec], { stdio: 'inherit' });
}

function wrapAction(fn, { skipSelfUpdateCheck } = {}) {
  return async (...args) => {
    try {
      if (!skipSelfUpdateCheck) {
        await maybeNotifySelfUpdate();
      }
      await fn(...args);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      if (process.env.AVM_DEBUG) {
        console.error(err);
      }
      process.exit(1);
    }
  };
}

program
  .command('install')
  .description('Install an agent version into ~/.avm')
  .argument('<agent>', 'Agent spec, e.g. codex or codex@0.45.1')
  .option('-p, --package <name>', 'Override the npm package name')
  .option('-r, --registry <url>', 'Custom npm registry URL')
  .action(wrapAction(installAction));

program
  .command('global')
  .description('Set global default agent (installs if missing)')
  .argument('<agent>', 'Agent spec, e.g. codex or codex@0.45.1')
  .option('-p, --package <name>', 'Override the npm package name')
  .option('-r, --registry <url>', 'Custom npm registry URL')
  .option(
    '-a, --args <string>',
    'Default args for this agent when no avm.config.json args are set'
  )
  .action(wrapAction(globalAction));

program
  .command('local')
  .description('Set local project default agent (writes avm.config.json)')
  .argument('<agent>', 'Agent spec, e.g. codex or codex@0.45.1')
  .option(
    '-a, --args <string>',
    'Default args for this agent in avm.config.json'
  )
  .action(wrapAction(localAction));

program
  .command('list')
  .alias('ls')
  .description('List installed agents (use --remote for supported packages)')
  .option('--remote', 'List supported remote agents (including not installed)')
  .action(wrapAction(listAction));

program
  .command('current')
  .description('Show the active agent')
  .action(wrapAction(currentAction));

program
  .command('self-update')
  .description('Update avm itself via npm -g')
  .option('--to <version>', 'Target version (default: latest)')
  .action(wrapAction(selfUpdateAction, { skipSelfUpdateCheck: true }));

program
  .argument(
    '[agent]',
    'Agent to run (defaults to avm.config.json default or current)'
  )
  .argument('[agentArgs...]', 'Arguments forwarded to the agent')
  .option('-p, --package <name>', 'Override the npm package name')
  .option('-r, --registry <url>', 'Custom npm registry URL')
  .action(wrapAction(runAction));

program.parseAsync(process.argv);
