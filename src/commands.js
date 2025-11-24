const fs = require('fs/promises');
const path = require('path');
const { readState, writeState, pathExists } = require('./state');
const {
  listInstalledAgents,
  ensureInstalled,
  findAgentBinary,
  runCommand,
} = require('./install');
const { maybeNotifySelfUpdate, selfUpdateAction } = require('./selfUpdate');
const {
  SUPPORTED_AGENTS,
  normalizeAgentName,
  assertSupportedAgent,
  resolvePackageName,
  parseAgentSpec,
  parseArgsString,
  resolveTarget,
} = require('./agents');

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
    if (
      parsed.default &&
      typeof parsed.default === 'object' &&
      parsed.default.name
    ) {
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
        .filter((name) => SUPPORTED_AGENTS.has(name)),
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
        `${marker} ${name} (${packageName})` +
          (isInstalled ? ' [installed]' : ''),
      );
    }
    return;
  }

  const current = state.current
    ? { ...state.current, name: normalizeAgentName(state.current.name) }
    : null;
  const supportedInstalled = installed.filter((agent) =>
    SUPPORTED_AGENTS.has(normalizeAgentName(agent.name)),
  );
  if (!supportedInstalled.length) {
    console.log(
      'No supported agents installed yet (codex, claude, gemini). Try `avm install codex`.',
    );
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
        (agent.args ? ` args="${agent.args}"` : ''),
    );
  }

  if (config.default) {
    console.log(
      `Project default: ${config.default}${config.path ? ` (${config.path})` : ''}`,
    );
  }
}

async function installAction(agentArg, options) {
  const config = await loadProjectConfig();
  const state = await readState();
  const target = resolveTarget(agentArg, config, state, {
    packageOverride: options.package,
  });
  const { meta } = await ensureInstalled(target, {
    registry: options.registry,
  });
  console.log(
    `Installed ${meta.name}@${meta.version} (${meta.package})` +
      (meta.args ? ` with args="${meta.args}"` : ''),
  );
}

async function globalAction(agentArg, options) {
  const config = await loadProjectConfig();
  const state = await readState();
  const target = resolveTarget(agentArg, config, state, {
    packageOverride: options.package,
    argsOverride: options.args,
  });
  const { meta } = await ensureInstalled(target, {
    registry: options.registry,
  });
  await setCurrent(meta);
  console.log(
    `Set global default to ${meta.name}@${meta.version} (${meta.package})` +
      (meta.args ? ` with args="${meta.args}"` : ''),
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
  console.log(
    `Set local default to ${name}${versionPart} in ${targetPath}${argsPart}`,
  );
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
      `Current agent "${curr.name}" is not supported. Use one of: codex, claude, gemini.`,
    );
    return;
  }
  console.log(
    `${normalizedName}@${curr.version} (${curr.package})` +
      (curr.args ? ` args="${curr.args}"` : ''),
  );
}

async function runAction(agentArg, agentArgs, options) {
  const config = await loadProjectConfig();
  const state = await readState();
  const target = resolveTarget(agentArg, config, state, {
    packageOverride: options.package,
  });
  const { meta, installPath } = await ensureInstalled(target, {
    registry: options.registry,
  });
  await setCurrent(meta);

  const binPath = await findAgentBinary(installPath, meta.package);
  if (!binPath) {
    throw new Error(
      `Unable to find executable for ${meta.package}. ` +
        `Is the package's "bin" field set? Install path: ${installPath}`,
    );
  }

  const combinedArgs = [...parseArgsString(meta.args), ...(agentArgs || [])];
  console.log(
    `> Running ${meta.name}@${meta.version} (${meta.package}) from ${installPath}` +
      (combinedArgs.length ? ` with args: ${combinedArgs.join(' ')}` : ''),
  );
  await runCommand(binPath, combinedArgs, { stdio: 'inherit' });
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

module.exports = {
  installAction,
  globalAction,
  localAction,
  listAction,
  currentAction,
  runAction,
  selfUpdateAction,
  wrapAction,
};
