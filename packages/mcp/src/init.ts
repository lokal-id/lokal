// `lokal-mcp init` sets a project up from a profile, and `lokal-mcp check` says what its configuration does.
//
//   lokal-mcp init [--profile personal|team|strict] [--dry-run] [--force]
//   lokal-mcp check [folder]
//
// init writes only files that are not there yet (--force replaces .samaran.json); nothing else in the project is touched.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PiiType } from '@lokal-id/core';
import {
  DEFAULT_VAULT_TTL_MINUTES, loadConfig, localEndpoint, recordTrust, revokeTrust, trustDigests, trustedFiles, untrustedIgnore, type SamaranConfig,
} from './files.ts';
import { VERSION } from './version.ts';

export type Profile = 'personal' | 'team' | 'strict';
export const PROFILES: readonly Profile[] = ['personal', 'team', 'strict'];

const DOCS = 'https://github.com/lokal-id/lokal#policy-local-routing-and-the-audit-log';

/** What each profile puts in .samaran.json. */
export function profileConfig(profile: Profile): Record<string, unknown> {
  const base = { $comment: `Lokal profile "${profile}". What each key does: ${DOCS}`, custom: [], allow: [] };
  if (profile === 'personal') return { ...base, vaultTtlMinutes: 120 };
  if (profile === 'team') return { ...base, audit: true, vaultTtlMinutes: 60 };
  return {
    ...base,
    policy: { HEALTH: 'block', CRIMINAL_RECORD: 'block', BIOMETRIC: 'block' },
    audit: true,
    vaultTtlMinutes: 30,
    guard: 'strict',
  };
}

const IGNORE = `# Files that hold only made-up data, which Samaran should not flag or block (gitignore syntax).
# Keep real exports and dumps out of this list.
# test/fixtures/
# database/seeders/
# *.example.csv
`;

function workflow(profile: Profile): string {
  return `# Fails a pull request that adds Indonesian personal data (NIK, phone numbers, bank accounts, health data, …).
# Written by lokal-mcp init --profile ${profile}. Nothing leaves the runner; findings show masked values only.
name: PII
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: lokal-id/lokal@v${VERSION}
${profile === 'strict' ? '        with:\n          strict: true  # also fail on changed files that could not be read\n' : ''}`;
}

export interface PlannedFile {
  file: string;
  content: string;
  /** What happens to it: written, replaced, or kept because it is already there. */
  action: 'write' | 'replace' | 'keep';
}

/** The files a profile writes in `root`, and what would happen to each. */
export function planInit(root: string, profile: Profile, force = false): PlannedFile[] {
  const files: Array<{ file: string; content: string; replaceable?: boolean }> = [
    { file: '.samaran.json', content: `${JSON.stringify(profileConfig(profile), null, 2)}\n`, replaceable: true },
    { file: '.samaranignore', content: IGNORE },
  ];
  if (profile !== 'personal') files.push({ file: '.github/workflows/pii.yml', content: workflow(profile) });
  return files.map(({ file, content, replaceable }) => {
    const there = existsSync(path.join(root, file));
    return { file, content, action: !there ? 'write' : force && replaceable ? 'replace' : 'keep' };
  });
}

const NEXT: Record<Profile, string[]> = {
  personal: [
    'Claude Code: /plugin marketplace add lokal-id/lokal, then /plugin install lokal@lokal (skills, MCP server, guard).',
    'Other agents: see https://github.com/lokal-id/lokal#quick-start',
  ],
  team: [
    'Commit .samaran.json, .samaranignore, and .github/workflows/pii.yml so everyone gets the same rules.',
    'Each developer installs the Claude Code plugin, or the guard hook for their agent.',
    'The audit log goes to .lokal/audit.jsonl on each machine (kept out of git); read it with lokal-mcp audit.',
  ],
  strict: [
    'Commit .samaran.json, .samaranignore, and .github/workflows/pii.yml so everyone gets the same rules.',
    'The guard now blocks what it cannot check, for everyone in this repository, and read_file_masked refuses files with health, criminal, or biometric data.',
    'Add rules your team needs to "custom", and change "policy" to suit; lokal-mcp check shows the result.',
  ],
};

const INIT_USAGE = `Usage: lokal-mcp init [--profile personal|team|strict] [--dry-run] [--force]

Sets up Samaran in this folder:
  personal (default)  .samaran.json (vault forgotten after 2 hours) and .samaranignore
  team                ...plus the audit log, a 1-hour vault, and a GitHub workflow that fails pull requests with
                      personal data
  strict              ...plus a guard that blocks what it cannot check, health, criminal, and biometric data
                      refused even masked, and a 30-minute vault

  --dry-run   Show what would be written, and write nothing
  --force     Replace an existing .samaran.json (other files are never replaced)`;

export function runInit(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${INIT_USAGE}\n`);
    return;
  }
  const at = args.indexOf('--profile');
  const profile = (at >= 0 ? args[at + 1] : 'personal') as Profile;
  if (!PROFILES.includes(profile)) {
    process.stderr.write(`Unknown profile ${profile ?? ''}. Choose personal, team, or strict.\n\n${INIT_USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  const root = process.cwd();
  const dryRun = args.includes('--dry-run');
  const plan = planInit(root, profile, args.includes('--force'));
  const out: string[] = [`${dryRun ? 'Would set up' : 'Setting up'} Samaran with the "${profile}" profile in ${root}:`];
  for (const p of plan) {
    const verb = { write: dryRun ? 'would write' : 'wrote', replace: dryRun ? 'would replace' : 'replaced', keep: 'kept (already there)' }[p.action];
    out.push(`  ${p.file.padEnd(28)} ${verb}`);
    if (!dryRun && p.action !== 'keep') {
      mkdirSync(path.dirname(path.join(root, p.file)), { recursive: true });
      writeFileSync(path.join(root, p.file), p.content, 'utf8');
    }
  }
  if (dryRun) {
    for (const p of plan.filter((f) => f.action !== 'keep')) out.push('', `--- ${p.file}`, p.content.trimEnd());
  } else {
    // Approve only the files init wrote itself: a .samaran.json or .samaranignore that was already there (from a
    // cloned repository, or written by an agent) is the user's to read and approve with `trust`.
    const wrote = plan.filter((p) => p.action !== 'keep').map((p) => p.file);
    const approved = recordTrust(root, wrote);
    if (approved.length) out.push('', `Approved ${approved.join(' and ')} on this machine (lokal-mcp trust).`);
    const kept = plan.filter((p) => p.action === 'keep' && ['.samaran.json', '.samaranignore'].includes(p.file) && !trustedFiles(root).has(p.file));
    if (kept.length) {
      out.push('', `${kept.map((p) => p.file).join(' and ')} was already here and is not approved: read it, then run lokal-mcp trust in your terminal.`);
    }
    out.push('', 'Next:', ...NEXT[profile].map((l) => `  - ${l}`), '  - lokal-mcp check shows what the configuration does.');
  }
  process.stdout.write(`${out.join('\n')}\n`);
}

// --- check -----------------------------------------------------------------------------------------------------

/** Types that identify someone on their own: letting the model see them is worth a second look. */
const IDENTIFIERS: PiiType[] = ['NIK', 'KK', 'NPWP', 'PASSPORT', 'SIM', 'NIP', 'NISN', 'AKTA', 'BANK_ACCOUNT', 'BPJS', 'CARD'];


/** What a configuration does, as lines, and the warnings worth reading. */
export function describeConfig(root: string, config: SamaranConfig, env: NodeJS.ProcessEnv = process.env): { lines: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const guard = env.SAMARAN_GUARD === 'off'
    ? 'off (SAMARAN_GUARD=off on this machine)'
    : env.SAMARAN_GUARD === 'strict'
      ? 'strict (SAMARAN_GUARD=strict)'
      : config.guard === 'strict'
        ? env.SAMARAN_GUARD ? `default (SAMARAN_GUARD=${env.SAMARAN_GUARD} overrides "guard": "strict")` : 'strict ("guard": "strict")'
        : 'default (asks about what it cannot check)';
  const policy = Object.entries(config.policy ?? {});
  const ignore = existsSync(path.join(root, '.samaranignore'))
    ? readFileSync(path.join(root, '.samaranignore'), 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'))
    : undefined;
  const lines = [
    `.samaran.json   ${existsSync(path.join(root, '.samaran.json')) ? 'valid' : 'not found (the defaults below apply)'}`,
    `guard           ${guard}`,
    `custom rules    ${config.custom.length ? config.custom.map((r) => r.label).join(', ') : 'none'}`,
    `allow list      ${config.allow.length} value(s)`,
    `policy          ${policy.length ? `${policy.map(([k, a]) => `${k}=${a}`).join(', ')}; everything else is masked` : 'everything is masked'}`,
    `route           ${config.route ? [config.route.openai && `openai ${config.route.openai}`, config.route.anthropic && `anthropic ${config.route.anthropic}`, config.route.model && `model ${config.route.model}`].filter(Boolean).join(', ') : 'none'}`,
    `audit log       ${config.audit ? path.relative(root, config.audit) || config.audit : 'off'}`,
    `vault           ${env.LOKAL_VAULT_TTL_MINUTES ? `forgotten after ${env.LOKAL_VAULT_TTL_MINUTES} min (LOKAL_VAULT_TTL_MINUTES)` : `forgotten after ${config.vaultTtlMinutes ?? DEFAULT_VAULT_TTL_MINUTES} min without use${config.vaultTtlMinutes ? '' : ' (the default)'}`}`,
    `.samaranignore  ${ignore ? `${ignore.length} pattern(s)` : 'not found'}`,
  ];
  if (env.SAMARAN_GUARD === 'off') warnings.push('The guard is off on this machine: prompts and file reads are not checked.');
  const allowedIds = policy.filter(([k, a]) => a === 'allow' && IDENTIFIERS.includes(k as PiiType)).map(([k]) => k);
  if (allowedIds.length) warnings.push(`policy allows ${allowedIds.join(', ')}: the model sees these identity numbers unmasked.`);
  for (const [kind, url] of Object.entries({ openai: config.route?.openai, anthropic: config.route?.anthropic })) {
    if (url && !localEndpoint(url)) warnings.push(`route.${kind} (${url}) is not on this machine or a private network: routed requests are sent there unmasked.`);
  }
  if (config.audit && path.relative(root, config.audit).split(path.sep)[0] !== '.lokal' && !path.relative(root, config.audit).startsWith('..')) {
    warnings.push(`The audit log ${path.relative(root, config.audit)} is inside the project: keep it out of git (it lists file names).`);
  }
  const risky = (ignore ?? []).filter((l) => /^\*+$|^\/?\*\*?\/?$|^\.$|^\*\.(csv|xlsx|json|sql|log)$/i.test(l.trim()));
  if (risky.length) warnings.push(`.samaranignore has ${risky.map((l) => `"${l.trim()}"`).join(', ')}, which skips real data files too.`);
  return { lines, warnings };
}

export function runCheck(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('Usage: lokal-mcp check [folder]\n\nValidates .samaran.json and .samaranignore and shows what they do. Exits with 1 when .samaran.json is wrong.\n');
    return;
  }
  const root = path.resolve(args.find((a) => !a.startsWith('-')) ?? '.');
  let config: SamaranConfig;
  try {
    config = loadConfig(root);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exitCode = 1;
    return;
  }
  const { lines, warnings } = describeConfig(root, config);
  const out = [`Samaran configuration in ${root}`, '', ...lines, ...trustLines(root, config)];
  if (warnings.length) out.push('', 'Warnings:', ...warnings.map((w) => `  - ${w}`));
  process.stdout.write(`${out.join('\n')}\n`);
}

/** What `check` and `trust --status` say about the approval of the project's files. */
function trustLines(root: string, config: SamaranConfig): string[] {
  const out: string[] = [];
  const present = ['.samaran.json', '.samaranignore'].filter((f) => existsSync(path.join(root, f)));
  if (!present.length) return out;
  const trusted = trustedFiles(root);
  out.push(`approved        ${present.map((f) => `${f} ${trusted.has(f) ? 'yes' : 'no'}`).join(', ')}`);
  if (config.untrusted?.length) out.push(`left out        ${config.untrusted.join(', ')} (not approved: run lokal-mcp trust)`);
  if (untrustedIgnore(root)) out.push('                .samaranignore is not applied until approved (lokal-mcp trust)');
  return out;
}

const TRUST_USAGE = `Usage: lokal-mcp trust [folder] [--status | --revoke]

Approves this project's .samaran.json and .samaranignore on this machine, as they are now. Until then, what they
would relax does not apply: values on the allow list, types with policy "allow" or "route", "route" itself, a vault
kept longer than ${DEFAULT_VAULT_TTL_MINUTES} minutes, and the files .samaranignore leaves out. A change to either file
needs approval again. It shows the settings and asks you to type "yes", in a terminal only: an agent or a script
cannot approve them.

  --status   show what is approved, and what is left out
  --revoke   withdraw the approval`;

/** How `trust` asks the user: only in a terminal, where an agent's shell (no terminal) cannot answer. */
export interface TrustPrompt {
  interactive: boolean;
  ask(question: string): Promise<string>;
}

async function askInTerminal(question: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

const TERMINAL_PROMPT: TrustPrompt = {
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  ask: askInTerminal,
};

export async function runTrust(args: string[], prompt: TrustPrompt = TERMINAL_PROMPT): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${TRUST_USAGE}\n`);
    return;
  }
  const root = path.resolve(args.find((a) => !a.startsWith('-')) ?? '.');
  if (args.includes('--revoke')) {
    revokeTrust(root);
    process.stdout.write(`Approval withdrawn for ${root}.\n`);
    return;
  }
  let full: SamaranConfig;
  try {
    full = loadConfig(root, { trusted: true });
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exitCode = 1;
    return;
  }
  const { lines, warnings } = describeConfig(root, full);
  const out = [`Samaran configuration in ${root}`, '', ...lines];
  if (warnings.length) out.push('', 'Warnings:', ...warnings.map((w) => `  - ${w}`));
  if (args.includes('--status')) {
    out.push('', ...trustLines(root, loadConfig(root)));
    process.stdout.write(`${out.join('\n')}\n`);
    return;
  }
  // What is approved is what the user was shown: the files' hashes now, checked again after they answer.
  const shown = trustDigests(root);
  if (!Object.keys(shown).length) {
    process.stdout.write(`${[...out, '', 'Nothing to approve: no .samaran.json or .samaranignore here.'].join('\n')}\n`);
    return;
  }
  if (!prompt.interactive) {
    process.stdout.write(`${out.join('\n')}\n`);
    process.stderr.write([
      '',
      'lokal-mcp trust asks before it approves, and only in a terminal: run it yourself in your own terminal, not through',
      'an agent or a script. Nothing was approved.',
      '',
    ].join('\n'));
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${out.join('\n')}\n\n`);
  const question = `Approve ${Object.keys(shown).join(' and ')} as shown above? Type "yes" to approve: `;
  const answer = (await prompt.ask(question)).trim().toLowerCase();
  if (answer !== 'yes' && answer !== 'ya') {
    process.stdout.write('Nothing was approved.\n');
    process.exitCode = 1;
    return;
  }
  const approved = recordTrust(root, undefined, shown);
  const changed = Object.keys(shown).filter((f) => !approved.includes(f));
  if (changed.length) {
    process.stderr.write(`${changed.join(' and ')} changed while you read it and was not approved: run lokal-mcp trust again.\n`);
    process.exitCode = 1;
  }
  if (approved.length) {
    process.stdout.write(`Approved ${approved.join(' and ')} on this machine. A change to either needs approval again.\n`);
  }
}
