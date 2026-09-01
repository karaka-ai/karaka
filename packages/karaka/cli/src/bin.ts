#!/usr/bin/env node

import { Command } from 'commander'
import { initKarakaProject, karakaVersion, startKarakaProject } from './index.ts'

const program = new Command()
  .name('karaka')
  .description('Create and run a Karaka agent workspace')
  .version(karakaVersion)

program.command('init')
  .option('--dir <path>', 'agent workspace directory', 'apps/agents')
  .action((options: { dir: string }) => {
    process.stdout.write(`${initKarakaProject(options.dir)}\n`)
  })

program.command('start')
  .option('--config <path>', 'Cordis patch file', 'karaka.cordis.yml')
  .action(async (options: { config: string }) => {
    process.exitCode = await startKarakaProject(options.config)
  })

await program.parseAsync()
