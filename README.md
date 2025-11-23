# avm

A version manager for AI coding agents.
Think `nvm` for AI coding agents. **avm** provides reproducible agent execution environments, project-level configuration, and isolated agent runtimes.

## Features

* Install specific versions of AI coding agents
* Use different agent versions per project
* `avm.config.json` project configuration
* Reproducible agent environments under `~/.avm`

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
```

### Project Configuration

You can manage project defaults via `avm.config.json`. Create/update it manually or via:

```bash
avm local codex@0.60.1    # writes or updates avm.config.json in this directory
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

When you run `avm` inside the project, it will prefer the agent specified in `avm.config.json`. (Shell auto-switch hooks are not implemented yet.)

#### Config format

- File name: `avm.config.json`
- Location: searched from the current directory upward until found; the nearest one wins.
- Shape:

```json
{
  "default": {
    "name": "<agent-name>"        // e.g. "codex", "claude", "gemini"
  },
  "<agent-name>": {
    "package": "<npm-package-name>", // optional, defaults to built-in mapping
    "version": "<version-or-tag>",   // optional, defaults to "latest"
    "args": "<agent-args-string>"    // optional, split on spaces before CLI args
  }
}
```

Resolution rules (in order of precedence):

- Package name:
  1. CLI `--package`
  2. `avm.config.json` (`"<agent-name>".package`)
  3. Previously used package for that agent in `~/.avm/state.json`
  4. Built-in defaults (`codex` → `@openai/codex`, etc.)
- Version:
  1. `<agent>@<version>` CLI spec (e.g. `codex@0.60.1`)
  2. `avm.config.json` (`"<agent-name>".version`)
  3. Previously used version for that agent in `~/.avm/state.json`
  4. `"latest"`
- Args:
  1. `avm global <agent> --args "<agent-args-string>"`
  2. `avm.config.json` (`"<agent-name>".args`)
  3. Previously used args for that agent in `~/.avm/state.json`

  Args are stored per installation and prepended to the agent process arguments before any extra CLI arguments you pass to `avm`.

### How it works

* Agents install into `~/.avm/agents/<name>/<version>` via `npm install --prefix`.
* Binaries are resolved from the package `bin` field (fallback to `node_modules/.bin/<package>`).
* State is stored in `~/.avm/state.json` and updated when you `global` or run an agent.

## Roadmap

* Optional fully-managed Node runtimes
* Agent marketplace / registry
* Lockfile for full reproducibility
* Agent diff / compare functionality
