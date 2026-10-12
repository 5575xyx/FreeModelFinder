import chalk from 'chalk';
import { Command } from 'commander';
import inquirer from 'inquirer';
import {
  assertAdminPasswordUsable,
  hashAdminPassword,
  loadConfig,
  MIN_ADMIN_PASSWORD_LENGTH,
  updateConfig,
} from '@freemodelfinder/core';

type Prompt = <T>(questions: unknown[]) => Promise<T>;

interface AdminCommandDependencies {
  loadConfig: typeof loadConfig;
  updateConfig: typeof updateConfig;
  prompt: Prompt;
}

const PROMPT_MESSAGE = `Choose a management password (min ${MIN_ADMIN_PASSWORD_LENGTH} chars): `;

export function adminCommand(dependencies: Partial<AdminCommandDependencies> = {}): Command {
  const readConfig = dependencies.loadConfig ?? loadConfig;
  const writeConfig = dependencies.updateConfig ?? updateConfig;
  const prompt: Prompt =
    dependencies.prompt ??
    ((questions) => inquirer.prompt(questions as never) as Promise<unknown> as never);

  /**
   * The one thing that must never fail halfway: read the password twice, then
   * write. A rejected write would leave a server with a password nobody knows.
   */
  async function setNewPassword(): Promise<void> {
    const { password } = await prompt<{ password: string }>([
      { type: 'password', name: 'password', mask: '*', message: PROMPT_MESSAGE },
    ]);
    const { confirm } = await prompt<{ confirm: string }>([
      { type: 'password', name: 'confirm', mask: '*', message: 'Type it again: ' },
    ]);
    try {
      assertAdminPasswordUsable(password);
    } catch (err) {
      console.log(chalk.red(err instanceof Error ? err.message : 'invalid password'));
      return;
    }
    if (password !== confirm) {
      console.log(chalk.red('passwords do not match, aborted'));
      return;
    }
    const adminAuth = await hashAdminPassword(password);
    await writeConfig((cfg) => {
      cfg.adminAuth = adminAuth;
      return cfg;
    });
    console.log(chalk.green('✓ management password saved'));
    console.log(
      chalk.gray('  Sign in from the browser. FREEMODELFINDER_TRUST_UI no longer grants access.'),
    );
  }

  const cmd = new Command('admin').description('Manage the management-panel password');

  cmd
    .command('status')
    .description('Show whether a management password is set')
    .action(async () => {
      const cfg = await readConfig();
      if (cfg.adminAuth) {
        console.log(chalk.green('management password is set'));
        console.log(chalk.gray(`  configured ${new Date(cfg.adminAuth.createdAt).toISOString()}`));
      } else {
        console.log(chalk.yellow('no management password is set'));
        console.log(chalk.gray('  the panel is reachable from the loopback address only'));
      }
    });

  cmd
    .command('set-password')
    .description('Set the management-panel password')
    .action(async () => {
      await setNewPassword();
    });

  cmd
    .command('reset-password')
    .description('Replace the management-panel password (recovery from a forgotten one)')
    .action(async () => {
      await setNewPassword();
    });

  cmd
    .command('clear-password')
    .description('Remove the management-panel password and disable sign-in')
    .action(async () => {
      const cfg = await readConfig();
      if (!cfg.adminAuth) {
        console.log(chalk.yellow('no management password is set'));
        return;
      }
      const { ok } = await prompt<{ ok: boolean }>([
        {
          type: 'confirm',
          name: 'ok',
          message: 'Disable the management-panel password?',
          default: false,
        },
      ]);
      if (!ok) {
        console.log(chalk.gray('aborted'));
        return;
      }
      await writeConfig((next) => {
        delete next.adminAuth;
        return next;
      });
      console.log(chalk.green('✓ management password removed'));
      console.log(
        chalk.yellow(
          '  The panel is back to loopback-only. Set it again before exposing this port.',
        ),
      );
    });

  return cmd;
}
