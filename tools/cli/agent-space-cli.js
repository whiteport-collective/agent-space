#!/usr/bin/env node
'use strict';

const { program } = require('commander');
const path = require('node:path');

const packageJson = require('../../package.json');
const installCommand = require('./commands/install');

program
  .version(packageJson.version)
  .description('Agent Space — multi-agent communication, knowledge capture, and work order coordination');

const cmd = program.command(installCommand.command).description(installCommand.description);
for (const option of installCommand.options || []) {
  cmd.option(...option);
}
cmd.action(installCommand.action);

program.parse(process.argv);

if (process.argv.slice(2).length === 0) {
  program.outputHelp();
}
