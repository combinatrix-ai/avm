#!/usr/bin/env node

const { Command } = require('commander');
const pkg = require('../package.json');

const {
  installAction,
  globalAction,
  localAction,
  listAction,
  currentAction,
  runAction,
  selfUpdateAction,
  wrapAction,
} = require('./commands');

const program = new Command();

program
  .name('avm')
  .description(
    'A minimal version manager for AI coding agents (npx/npm based).\n\nSupported agents: codex, claude, gemini.\nAgent spec: <name> or <name>@<version>, e.g. codex, codex@latest, codex@0.60.1.'
  )
  .version(pkg.version, '-v, -V, --version')
  .addHelpText(
    'after',
    `

Examples:
  $ avm install codex@latest
  $ avm install codex@0.60.1
  $ avm global claude@latest
  $ avm local gemini@latest
  $ avm codex@latest -- --help    # run an agent with extra args
`
  );

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
