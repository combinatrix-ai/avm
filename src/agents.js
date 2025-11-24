const SUPPORTED_AGENTS = new Set(['codex', 'claude', 'gemini']);

const DEFAULT_PACKAGES = {
  codex: '@openai/codex',
  claude: '@anthropic-ai/claude-code',
  gemini: '@google/gemini-cli',
};

function normalizeAgentName(name) {
  return (name || '').trim().toLowerCase();
}

function assertSupportedAgent(name) {
  if (!SUPPORTED_AGENTS.has(name)) {
    const supported = Array.from(SUPPORTED_AGENTS).join(', ');
    throw new Error(
      `Unsupported agent "${name}". Supported agents: ${supported}.`,
    );
  }
}

function resolvePackageName(
  name,
  { packageOverride, configPackage, statePackage },
) {
  if (packageOverride) return packageOverride;
  if (configPackage) return configPackage;
  if (statePackage) return statePackage;
  const builtin = DEFAULT_PACKAGES[name];
  if (builtin) return builtin;
  throw new Error(
    `No npm package configured for agent "${name}". ` +
      `Specify with --package or configure it in avm.config.json.`,
  );
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

function resolveTarget(
  agentArg,
  config,
  state,
  { packageOverride, argsOverride } = {},
) {
  const parsed = parseAgentSpec(agentArg);
  const rawName = parsed?.name || config.default || state.current?.name;
  const name = normalizeAgentName(rawName);
  if (!name) {
    throw new Error(
      'No agent specified. Use avm <agent>, avm global <agent>, or configure avm.config.json.',
    );
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
  const version =
    parsed?.version ||
    fromConfig.version ||
    currentForAgent?.version ||
    'latest';
  const args = argsOverride || fromConfig.args || currentForAgent?.args || '';

  return {
    name,
    package: packageName,
    version,
    args,
  };
}

module.exports = {
  SUPPORTED_AGENTS,
  DEFAULT_PACKAGES,
  normalizeAgentName,
  assertSupportedAgent,
  resolvePackageName,
  parseAgentSpec,
  parseArgsString,
  resolveTarget,
};
