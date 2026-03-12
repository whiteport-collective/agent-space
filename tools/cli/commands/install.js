#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { createInterface } = require('node:readline');

function prompt(question, defaultValue) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

async function action(options) {
  const projectDir = options.dir || process.cwd();
  const packageRoot = path.resolve(__dirname, '../../..');

  console.log('\n  Agent Space');
  console.log('  Multi-agent communication, knowledge capture, and work order coordination\n');

  // 1. Gather configuration
  const spaceName = await prompt('What do you want to call your agent space?', 'Agent Space');
  const installDir = await prompt('Install directory?', '_agent-space');
  const ide = await prompt('Which IDE? (claude-code, codex, gemini, other)', 'claude-code');

  const targetDir = path.resolve(projectDir, installDir);

  // 2. Create directory structure
  console.log(`\n  Installing to ${installDir}/...`);
  fs.mkdirSync(path.join(targetDir, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(targetDir, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(targetDir, 'data'), { recursive: true });

  // 3. Copy skills
  const skillsSrc = path.join(packageRoot, 'src', 'skills');
  const skillsDest = path.join(targetDir, 'skills');
  copyDirSync(skillsSrc, skillsDest);
  console.log('  Copied skills (work order command)');

  // 4. Copy agent runtime for selected IDE
  const agentSrc = path.join(packageRoot, 'src', 'agents', ide);
  const agentDest = path.join(targetDir, 'agents', ide);
  if (fs.existsSync(agentSrc)) {
    copyDirSync(agentSrc, agentDest);
    console.log(`  Copied ${ide} agent runtime`);
  }

  // 5. Copy data guides
  const dataSrc = path.join(packageRoot, 'src', 'data');
  const dataDest = path.join(targetDir, 'data');
  if (fs.existsSync(dataSrc)) {
    copyDirSync(dataSrc, dataDest);
    console.log('  Copied data guides');
  }

  // 6. Write config
  const config = {
    space_name: spaceName,
    ide,
    installed_at: new Date().toISOString(),
    version: require('../../../package.json').version,
  };
  fs.writeFileSync(
    path.join(targetDir, 'config.json'),
    JSON.stringify(config, null, 2)
  );

  // 7. IDE-specific setup
  if (ide === 'claude-code') {
    setupClaudeCode(projectDir, targetDir, spaceName);
  } else if (ide === 'codex') {
    setupCodex(projectDir, targetDir, spaceName);
  } else if (ide === 'gemini') {
    setupGemini(projectDir, targetDir, spaceName);
  }

  // 8. Create .env template if not exists
  const envPath = path.join(projectDir, '.env');
  const envExamplePath = path.join(projectDir, '.env.example');
  if (!fs.existsSync(envPath)) {
    const envContent = [
      '# Agent Space credentials',
      '# Get these from your Supabase project: supabase.com/dashboard',
      'AGENT_SPACE_URL=https://YOUR-PROJECT.supabase.co',
      'AGENT_SPACE_ANON_KEY=your-anon-key',
      '',
      '# Optional: enables semantic search',
      '# OPENROUTER_API_KEY=your-key',
      '',
    ].join('\n');
    fs.writeFileSync(envPath, envContent);
    console.log('  Created .env template — fill in your Supabase credentials');
  }
  if (!fs.existsSync(envExamplePath)) {
    fs.copyFileSync(
      path.join(packageRoot, '.env.example'),
      envExamplePath
    );
  }

  // 9. Ensure .env is gitignored
  const gitignorePath = path.join(projectDir, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const gitignore = fs.readFileSync(gitignorePath, 'utf8');
    if (!gitignore.includes('.env')) {
      fs.appendFileSync(gitignorePath, '\n.env\n.env.*\n!.env.example\n');
      console.log('  Added .env to .gitignore');
    }
  }

  console.log(`\n  ${spaceName} installed!\n`);
  console.log('  Next steps:');
  console.log('  1. Fill in .env with your Supabase URL and anon key');
  console.log('  2. Set OPENROUTER_API_KEY in Supabase Dashboard (optional, for search)');
  console.log(`  3. Use /work to claim and deliver work orders\n`);
}

// ---- IDE Setup Functions ----

function setupClaudeCode(projectDir, targetDir, spaceName) {
  // Install /work as a Claude Code skill
  const skillsDir = path.join(projectDir, '.claude', 'commands');
  fs.mkdirSync(skillsDir, { recursive: true });

  const workSkill = path.join(targetDir, 'skills', 'work.md');
  const workDest = path.join(skillsDir, 'work.md');

  if (fs.existsSync(workSkill) && !fs.existsSync(workDest)) {
    fs.copyFileSync(workSkill, workDest);
    console.log('  Installed /work command for Claude Code');
  } else if (fs.existsSync(workDest)) {
    console.log('  /work command already exists — skipping');
  }
}

function setupCodex(projectDir, targetDir, spaceName) {
  // Copy Codex guides to .codex/
  const codexDir = path.join(projectDir, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });

  const agentsmd = path.join(targetDir, 'agents', 'codex', 'AGENTS.md');
  const agentsDest = path.join(projectDir, 'AGENTS.md');

  if (fs.existsSync(agentsmd) && !fs.existsSync(agentsDest)) {
    fs.copyFileSync(agentsmd, agentsDest);
    console.log('  Installed AGENTS.md for Codex');
  }

  // Copy runtime scripts
  const scripts = ['design_space.py', 'session_start.py', 'poll_messages.py', 'capture_insight.py', 'session_end.py'];
  for (const script of scripts) {
    const src = path.join(targetDir, 'agents', 'codex', script);
    const dest = path.join(codexDir, script);
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      fs.copyFileSync(src, dest);
    }
  }
  console.log('  Installed Codex runtime scripts to .codex/');
}

function setupGemini(projectDir, targetDir, spaceName) {
  const agentsmd = path.join(targetDir, 'agents', 'gemini', 'AGENTS.md');
  const agentsDest = path.join(projectDir, 'AGENTS.md');

  if (fs.existsSync(agentsmd) && !fs.existsSync(agentsDest)) {
    fs.copyFileSync(agentsmd, agentsDest);
    console.log('  Installed AGENTS.md for Gemini');
  }
}

// ---- Utilities ----

function copyDirSync(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

module.exports = {
  command: 'install',
  description: 'Install Agent Space into your project',
  options: [
    ['--dir <path>', 'Project directory (default: current directory)'],
  ],
  action,
};
