const fs = require('fs/promises');
const path = require('path');
const { AGENTS_DIR, pathExists, readJson, writeJson } = require('./state');

async function ensureBaseDirs() {
  await fs.mkdir(AGENTS_DIR, { recursive: true });
}

function sanitizeName(name) {
  return name.replace(/[\\/]/g, '__');
}

function unsanitizeName(name) {
  return name.replace(/__/g, '/');
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
  const { spawn } = require('child_process');

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

module.exports = {
  listInstalledAgents,
  ensureInstalled,
  findAgentBinary,
  runCommand,
};
