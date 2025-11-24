# avm

A version manager for AI coding agents.
Think `nvm` for AI coding agents. **avm** provides reproducible agent execution environments, project-level configuration, and isolated agent runtimes.

## Features

- Install specific versions of AI coding agents
- Use different agent versions per project
- `avm.config.json` project configuration
- Reproducible agent environments under `~/.avm`

## Supported Agents

- @openai/codex
- @anthropic-ai/claude-code
- @google/gemini-cli

## Getting Started

### Install the CLI

```bash
npm install -g @combinatrix-ai/avm
```

### Installing an Agent

```bash
avm install codex                # installs latest @openai/codex
avm install codex@0.45.1         # installs @openai/codex@0.45.1
avm install claude               # installs @anthropic-ai/claude-code
avm install gemini               # installs @google/gemini-cli

# override package if needed
avm install codex --package @your-scope/codex-cli
avm install codex --registry https://registry.npmjs.org     # custom registry
```

### Listing Agents

Installed

```bash
avm list
```

Remote (including not installed)

```bash
avm list --remote # list npm packages of coding agents
```

### Using an Agent

```bash
avm global codex@0.60.1   # set global default when no avm.config.json
avm                       # start default agent (global or from avm.config.json)
avm -v                    # show avm CLI version
avm self-update           # update avm itself via npm -g
```

### avm self-update and update checks

- `avm self-update` runs `npm install -g @combinatrix-ai/avm@latest` under the hood (or `--to <version>` for a specific version).
- `avm` will periodically check the npm registry (at most once per day) and print a message if a newer version of `avm` is available.
- Set `AVM_NO_UPDATE_CHECK=1` to disable the automatic update check.

## Configuration & state

You configure per-project defaults via `avm.config.json`, and avm keeps global installation and “current agent” state under `~/.avm`.

### `avm.config.json` (project config)

- File name: `avm.config.json`
- Location: searched from the current directory upward until found; the nearest one wins.
- Purpose: define project-level defaults for which agent to run, which package/version to use, and what default args to prepend.

You can create or update it manually, or via:

```bash
avm local codex@0.60.1    # writes or updates avm.config.json in this directory
avm local codex -a "--dangerously-bypass-approvals-and-sandbox"  # set default args in avm.config.json
```

Example `avm.config.json`:

```json
{
  "default": {
    "name": "codex"
  },
  "codex": {
    "version": "0.45.1",
    "args": "resume"
  },
  "claude": {
    "args": "resume"
  },
  "gemini": {
    "package": "@your-scope/gemini-cli"
  }
}
```

```bash
avm # Start codex with args provided
avm claude           # Start claude with its args from avm.config.json
```

When you run `avm` inside the project, it will prefer the agent specified in the nearest `avm.config.json`.

### How it works

- Agents install into `~/.avm/agents/<name>/<version>` via `npm install --prefix`.
- Binaries are resolved from the package `bin` field (fallback to `node_modules/.bin/<package>`).
- State is stored in `~/.avm/state.json` and updated when you `global` or run an agent.

#### Files under `~/.avm`

**Files**

- `~/.avm/agents/<name>/<version>/.meta.json`
  - Written by `avm install <agent>`, `avm global <agent>`, and when running an agent.
  - Stores installation metadata: `{ name, package, version, args, installedAt }`.
- `~/.avm/state.json`
  - Updated by `avm global <agent>` and whenever you run an agent via `avm ...`.
  - Stores the current agent under `current` (plus timestamps and any future state).

**What each command updates**

- `avm install <agent>`:
  - Ensures the agent is installed under `~/.avm/agents/<name>/<version>` and writes/updates `.meta.json` there.
  - Does **not** modify `~/.avm/state.json` or any `avm.config.json`.
- `avm global <agent> [--args "<agent-args>"]`:
  - Ensures the agent is installed and updates the corresponding `.meta.json` (including `args` when provided).
  - Updates `~/.avm/state.json` (the `current` agent: name, package, version, args).
  - Does **not** touch `avm.config.json`.
- `avm local <agent> [--args "<agent-args>"]`:
  - Creates or updates `avm.config.json` (nearest in the directory tree): sets `"default.name"` and per-agent `version` / `args`.
  - Does **not** install the agent or change `~/.avm/state.json` or any `.meta.json`.

**Resolution rules when running `avm`**

When `avm` decides what to run, it combines CLI input, project config, and saved state:

- Agent name:
  1. CLI `<agent>` / `<agent>@<version>` (e.g. `avm codex@0.60.1`)
  2. `avm.config.json.default.name` (nearest config in the directory tree)
  3. `~/.avm/state.json.current.name` (last used / global default)
- Package name:
  1. CLI `--package`
  2. `avm.config.json["<agent-name>"].package`
  3. `~/.avm/state.json.current.package` for that agent
  4. Built-in defaults (`codex` → `@openai/codex`, etc.)
- Version:
  1. `<agent>@<version>` in the CLI (e.g. `codex@0.60.1`)
  2. `avm.config.json["<agent-name>"].version`
  3. `~/.avm/state.json.current.version` for that agent
  4. `"latest"`
- Default args:
  1. `avm.config.json["<agent-name>"].args` (project-scoped defaults)
  2. `~/.avm/state.json.current.args` / `.meta.json` for that agent (set via `avm global <agent> --args "..."` or previous runs)
  3. No default args

Default args are prepended to the agent process arguments before any extra CLI arguments you pass after the agent name (e.g. `avm codex -- extra flags`).

## Roadmap

- Optional fully-managed Node runtimes
- Agent marketplace / registry
- Lockfile for full reproducibility
- Agent diff / compare functionality

## Development & Release

Basic release flow (handled by GitHub Actions):

1. Make code changes and ensure tests pass: `npm test`
2. Bump the version with npm (do not edit `package.json` manually):

   ```bash
   npm version patch   # or: minor / major
   ```

   This updates `package.json`, creates a commit, and tags `vX.Y.Z`.

3. Push the branch and tags:

   ```bash
   git push origin main --follow-tags
   ```

4. The `Publish Package` workflow (triggered by the `v*` tag) runs tests and publishes `@combinatrix-ai/avm` to npm.

Avoid running `npm publish` locally; prefer the CI-based publish flow above.
