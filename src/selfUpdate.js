const https = require('https');
const pkg = require('../package.json');
const { readState, writeState } = require('./state');
const { runCommand } = require('./install');

const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day

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
            new Error(
              `Unexpected status code ${res.statusCode} from npm registry`,
            ),
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
      },
    );
    req.on('error', (err) => reject(err));
    req.setTimeout(3000, () => {
      req.destroy(
        new Error('Timeout while checking npm registry for avm updates'),
      );
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
        console.warn(
          `Warning: failed to check for avm updates: ${err.message}`,
        );
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
        `A new version of avm is available: ${pkg.version} → ${latestVersion}.`,
      );
      console.log(
        `Update with: npm install -g ${pkg.name}@latest    # or: avm self-update`,
      );
    }
  } catch (err) {
    if (process.env.AVM_DEBUG) {
      console.warn(`Warning: self-update check failed: ${err.message}`);
    }
  }
}

async function selfUpdateAction(options) {
  const target = (options && options.to) || 'latest';
  const spec = `${pkg.name}@${target}`;
  console.log(`> Updating ${pkg.name} to ${target} via npm -g`);
  await runCommand('npm', ['install', '-g', spec], { stdio: 'inherit' });
}

module.exports = {
  maybeNotifySelfUpdate,
  selfUpdateAction,
};
