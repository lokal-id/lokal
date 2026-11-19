import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import {
  closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync,
  renameSync, rmSync, statSync, writeFileSync, writeSync, type BigIntStats,
} from 'node:fs';
import path from 'node:path';
import {
  checkCustomRules, detectPii, partialMask, PII_TYPES, type CustomRule, type DetectOptions, type PiiMatch, type PiiType,
  type ScanStatus,
} from '@lokal-id/core';

/**
 * A value as the model may see it in a finding or a guard message. A NIK or KK shows only its last four digits
 * (************0001): partialMask's first four are the region, and with them eight of sixteen digits would reach the
 * model. Logs and admin screens keep partialMask, for people.
 */
export function previewForModel(type: PiiType, value: string): string {
  if (type === 'NIK' || type === 'KK') return `${'*'.repeat(12)}${value.replace(/\D/g, '').slice(-4)}`;
  return partialMask(type, value);
}
import { readDocx } from './docx.ts';
import { readPdf } from './pdf.ts';
import { readXlsx, type Sheet } from './xlsx.ts';

/** scan_pii and read_file_masked read files up to this size; detection is linear, about 0.15 s per MB. */
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
/** The guard hook has 10 seconds, so for bigger text files it checks this much from the start. */
export const GUARD_SAMPLE_BYTES = 5 * 1024 * 1024;
/** Spreadsheets, Word documents, and PDFs must be parsed whole; above this the guard reports them instead. */
export const GUARD_MAX_ZIP_BYTES = 20 * 1024 * 1024;

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', 'coverage', 'vendor',
  '__pycache__', '.venv', 'venv', '.turbo', '.cache', 'target',
]);

const outside = (root: string, abs: string): boolean => {
  const rel = path.relative(root, abs);
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
};

/** Where `abs` really leads: the real path of its deepest existing part, with the rest (a file to be written) added. */
function realTarget(abs: string): string {
  let existing = abs;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return abs;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realpathSync.native(existing), ...rest);
}

// The root's real path, taken once per root (the server takes it when it starts): a root swapped for a link later
// does not move the boundary with it.
const realRoots = new Map<string, string>();

/** The real path of `root`, as it was the first time it was asked for. */
export function realRoot(root: string): string {
  let real = realRoots.get(root);
  if (real === undefined) {
    real = realTarget(root);
    realRoots.set(root, real);
  }
  return real;
}

/**
 * Resolves `p` against `root` and refuses paths that escape it: by `..`, by an absolute path, or through a symbolic
 * link or junction inside the root that points outside it.
 */
export function resolveInRoot(root: string, p: string): string {
  const abs = path.resolve(root, p);
  if (outside(root, abs) || outside(realRoot(root), realTarget(abs))) {
    throw new Error(`Path is outside the allowed root (${root}): ${p}`);
  }
  return abs;
}

// The path checked above can change before it is used: a folder in it swapped for a junction or a symbolic link that
// leads out of the root (by another process, or by an agent running commands while it calls a tool). So a file is
// opened first, and then the file that was opened is checked: it must be the very file (same device and file ID) that
// the path leads to now, inside the root. A swap before the open, after it, or in between fails that check.

const sameFile = (a: BigIntStats, b: BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino;

/** Where the open file `fd` is, from the kernel (Linux), without following any path again; undefined elsewhere. */
function openedPath(fd: number): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    return readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return undefined;
  }
}

/** No part of `real` below `rootReal` is a link right now (a junction counts as one). */
function linkFree(rootReal: string, real: string): boolean {
  let at = rootReal;
  for (const part of path.relative(rootReal, real).split(path.sep).filter(Boolean)) {
    at = path.join(at, part);
    if (lstatSync(at).isSymbolicLink()) return false;
  }
  return true;
}

/** Removes the file with the identity `created` at the first of `paths` that still leads to it. */
function removeCreated(created: BigIntStats, paths: string[]): void {
  for (const candidate of paths) {
    try {
      const real = realpathSync.native(candidate);
      if (sameFile(created, statSync(real, { bigint: true }))) {
        rmSync(real);
        return;
      }
    } catch {
      // gone or swapped again: try the next path
    }
  }
}

/** Opens `p` inside `root` and returns its descriptor, after checking that the open file is the one inside the root. */
function openChecked(root: string, p: string, abs: string, flags: string): number {
  const fd = openSync(abs, flags);
  const opened = fstatSync(fd, { bigint: true });
  try {
    const rootReal = realRoot(root);
    // Linux tells where the open file is. Elsewhere its path is resolved again, and stat follows that path once more:
    // a second swap in between could lead it back to the outside file, so the path must also hold no link afterwards.
    const viaFd = openedPath(fd);
    let real: string;
    let inside: boolean;
    if (viaFd !== undefined) {
      real = viaFd;
      inside = !outside(rootReal, real);
    } else {
      real = realpathSync.native(abs);
      inside = !outside(rootReal, real) && sameFile(opened, statSync(real, { bigint: true })) && linkFree(rootReal, real);
    }
    if (!inside) {
      // A file this call created (flag x) where a swap led it: remove it again, found by its identity, so not even an
      // empty file is left outside the root. Never a file this call did not create.
      if (flags.includes('x')) removeCreated(opened, [real, abs]);
      throw new Error(`Path is outside the allowed root (${root}): ${p}`);
    }
    // A hard link is the same file under a second name, and nothing in its path shows where the other name is.
    if (opened.isFile() && opened.nlink > 1n) {
      throw new Error(`${p} has more than one hard link, so it may be a file outside the root under a second name; it is not read or written.`);
    }
    return fd;
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}

/** Reads a whole file inside `root`, as a Document, from the descriptor that was checked (never by its path again). */
export function loadInRoot(root: string, p: string): { abs: string; doc: Document } {
  const abs = resolveInRoot(root, p);
  const fd = openChecked(root, p, abs, 'r');
  try {
    const size = Number(fstatSync(fd, { bigint: true }).size);
    if (size > MAX_FILE_BYTES) return { abs, doc: unsupported(`larger than ${mb(MAX_FILE_BYTES)}`) };
    return { abs, doc: loadBuffer(abs, readFileSync(fd)) };
  } finally {
    closeSync(fd);
  }
}

/**
 * Writes `data` to `p` inside `root`: into a new file with a random name next to it, checked like a read, then renamed
 * into place. A swap after the check can only move the new file, whose name nobody knows, and the rename then fails.
 */
export function writeInRoot(root: string, p: string, data: string, encoding: TextEncoding = 'utf8'): string {
  const abs = resolveInRoot(root, p);
  mkdirSync(path.dirname(abs), { recursive: true });
  // The name kept short enough that a file name the system allows (255) still has room for the random part.
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs).slice(0, 200)}.${randomBytes(8).toString('hex')}.tmp`);
  const fd = openChecked(root, p, tmp, 'wx');
  let written = false;
  try {
    writeSync(fd, encodeText(data, encoding));
    closeSync(fd);
    written = true;
    renameSync(tmp, abs);
  } catch (e) {
    if (!written) closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  return abs;
}

export type TextEncoding = 'utf8' | 'latin1' | 'utf16le' | 'utf16be';

// ignoreBOM: a BOM stays in the text, so the file is written back with it.
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * A text file's text. UTF-8 when it is valid UTF-8; otherwise read byte for byte as Latin-1, so an old export
 * ("José" saved in Windows-1252) keeps its letters instead of turning them into U+FFFD, and is written back the same.
 * A buffer cut in the middle of a character (a sample) is still UTF-8.
 */
export function decodeText(buf: Buffer, sample = false): { text: string; encoding?: TextEncoding } {
  const utf16 = utf16Of(buf.subarray(0, 8000));
  if (utf16) {
    // A BOM stays in the text (U+FEFF), so the file is written back with it; a sample keeps whole characters.
    const whole = buf.subarray(0, buf.length & ~1);
    return { text: new TextDecoder(utf16 === 'utf16le' ? 'utf-16le' : 'utf-16be', { ignoreBOM: true }).decode(whole), encoding: utf16 };
  }
  for (let cut = 0; cut <= (sample ? 3 : 0) && cut < buf.length; cut++) {
    if (cut && !unfinishedChar(buf.subarray(buf.length - cut))) continue;
    try {
      const text = UTF8.decode(buf.subarray(0, buf.length - cut));
      return { text: cut ? text + buf.subarray(buf.length - cut).toString('utf8') : text };
    } catch {
      // Not UTF-8 up to there either.
    }
  }
  if (!buf.length) return { text: '' };
  return { text: buf.toString('latin1'), encoding: 'latin1' };
}

/** The start of a UTF-8 character that needs more bytes than `tail` has: a lead byte, then only continuation bytes. */
function unfinishedChar(tail: Buffer): boolean {
  const lead = tail[0]!;
  const need = lead >= 0xf0 && lead <= 0xf4 ? 4 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xc2 && lead <= 0xdf ? 2 : 0;
  return need > tail.length && tail.subarray(1).every((b) => b >= 0x80 && b <= 0xbf);
}

/** Text as bytes in `encoding`; UTF-8 if it has a character Latin-1 cannot hold. */
export function encodeText(text: string, encoding: TextEncoding = 'utf8'): Buffer {
  if (encoding === 'utf16le') return Buffer.from(text, 'utf16le');
  if (encoding === 'utf16be') return Buffer.from(text, 'utf16le').swap16();
  if (encoding !== 'latin1') return Buffer.from(text, 'utf8');
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0xff) return Buffer.from(text, 'utf8');
  return Buffer.from(text, 'latin1');
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * UTF-16 text: a byte order mark, or (without one) a zero in every other byte of mostly-ASCII text. What Windows
 * PowerShell 5.1 writes with `>` and Out-File, and Notepad's "Unicode"; its zero bytes made it look binary.
 */
export function utf16Of(head: Buffer): 'utf16le' | 'utf16be' | undefined {
  if (head[0] === 0xff && head[1] === 0xfe) return 'utf16le';
  if (head[0] === 0xfe && head[1] === 0xff) return 'utf16be';
  const n = Math.min(head.length, 8000) & ~1;
  if (n < 8) return undefined;
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i < n; i += 2) {
    if (head[i] === 0) evenZero++;
    if (head[i + 1] === 0) oddZero++;
  }
  const pairs = n / 2;
  if (oddZero >= pairs * 0.9 && evenZero === 0) return 'utf16le';
  if (evenZero >= pairs * 0.9 && oddZero === 0) return 'utf16be';
  return undefined;
}

/** Binary data: NUL bytes early on that are not UTF-16 text. */
export function looksBinary(buf: Buffer): boolean {
  const head = buf.subarray(0, 8000);
  return head.includes(0) && !utf16Of(head);
}

/** Binary files have NUL bytes early on; text files (UTF-16 too) do not, apart from UTF-16's own. */
export function isTextFile(file: string): boolean {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(8000);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return !looksBinary(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
}

export function* walkFiles(dir: string, limit = 5000): Generator<string> {
  const stack = [dir];
  let count = 0;
  while (stack.length) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full);
      } else if (e.isFile()) {
        if (++count > limit) return;
        yield full;
      }
    }
  }
}

export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{' && glob.indexOf('}', i) > i) {
      // "*.{csv,json}"
      const close = glob.indexOf('}', i);
      re += `(?:${glob.slice(i + 1, close).split(',').map((alt) => globToRegExp(alt).source.slice(1, -1)).join('|')})`;
      i = close;
    } else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * What to do with a type of personal data: mask it (the default), let it through as it is, refuse what contains it,
 * or, in the proxy, send the request to a local model instead of the cloud.
 */
export type PolicyAction = 'mask' | 'allow' | 'block' | 'route';
export const POLICY_ACTIONS: readonly PolicyAction[] = ['mask', 'allow', 'block', 'route'];

/** `.samaran.json`: a team's own rules, the values it never wants masked, and what to do per type. */
export interface SamaranConfig {
  custom: CustomRule[];
  allow: string[];
  /** Per type, or per custom rule label: `{ "HEALTH": "block", "FINANCIAL": "allow" }`. Unlisted types are masked. */
  policy?: Record<string, PolicyAction>;
  /** Where the proxy sends requests with a `route` type: OpenAI- and Anthropic-compatible local endpoints. */
  route?: { openai?: string; anthropic?: string; model?: string };
  /** Absolute path of the audit log (JSON Lines), when the team turned it on. */
  audit?: string;
  /** The MCP server forgets its placeholders after this many minutes without use. */
  vaultTtlMinutes?: number;
  /** "strict": the guard blocks what it cannot check, for everyone who works in the repository. */
  guard?: 'strict';
  /** Names without a label or cue, from Lokal's NER model (@lokal-id/ner), in what the server and proxy mask. */
  ner?: boolean;
  /** Settings that would weaken protection and were left out, as the user has not approved this file (`lokal-mcp trust`). */
  untrusted?: string[];
}

/** Built-in types whose policy is `allow`: the model may see them. */
export function allowedTypes(config: SamaranConfig): PiiType[] {
  return Object.entries(config.policy ?? {})
    .filter(([key, action]) => action === 'allow' && PII_TYPES.includes(key as PiiType))
    .map(([key]) => key as PiiType);
}

/** The policy for a match: its custom label first, then its type. */
export function policyFor(config: SamaranConfig, m: { type: PiiType; label?: string }): PolicyAction {
  const policy = config.policy ?? {};
  return (m.label !== undefined ? policy[m.label] : undefined) ?? policy[m.type] ?? 'mask';
}

/** Counts of the matches whose policy is one of `actions`, by label or type; empty when there are none. */
export function underPolicy(
  config: SamaranConfig, matches: Iterable<{ type: PiiType; label?: string }>, actions: readonly PolicyAction[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of matches) {
    if (!actions.includes(policyFor(config, m))) continue;
    const name = m.label ?? m.type;
    out.set(name, (out.get(name) ?? 0) + 1);
  }
  return out;
}

/**
 * `.samaran.json` at the project root, or empty rules when there is none:
 *
 *   { "custom": [{ "label": "EMPLOYEE_ID", "pattern": "\\bEMP-\\d{6}\\b" }, { "label": "MEMBER", "fields": ["no_member"] }],
 *     "allow": ["0800-1-500-500"] }
 *
 * A file that is there but wrong throws: a rule that silently did nothing would mask less than the team expects.
 */
export function loadConfig(root: string, options: { trusted?: boolean } = {}): SamaranConfig {
  const file = path.join(root, '.samaran.json');
  if (!existsSync(file)) return { custom: [], allow: [] };
  return parseConfig(readFileSync(file, 'utf8'), root, options.trusted ?? trustedFiles(root).has('.samaran.json'));
}

/**
 * A `.samaran.json` from its text. What makes protection weaker (values allowed through, a type the model may see or
 * that goes to another endpoint, a longer vault) applies only when `trusted`: the user approved this very file on
 * their machine (`lokal-mcp trust`), or it is the reviewed version a scan compares with. A repository that was cloned,
 * or an agent that edited the file, cannot turn masking off. What makes it stricter always applies.
 */
export function parseConfig(text: string, root: string, trusted: boolean): SamaranConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    throw new Error(`.samaran.json is not valid JSON: ${(e as Error).message}`);
  }
  const fail = (why: string): never => {
    throw new Error(`.samaran.json: ${why}`);
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('expected an object with "custom" and "allow"');
  const { custom = [], allow = [], policy, route, audit, vaultTtlMinutes, guard, ner, ...rest } = raw as Record<string, unknown>;
  const unknownKeys = Object.keys(rest).filter((k) => !k.startsWith('$'));
  if (unknownKeys.length) {
    fail(`unknown key ${unknownKeys.map((k) => `"${k}"`).join(', ')} (expected "custom", "allow", "policy", "route", "audit", "vaultTtlMinutes", "guard", or "ner")`);
  }
  if (!Array.isArray(custom)) fail('"custom" must be a list of rules');
  if (!Array.isArray(allow) || !allow.every((a) => typeof a === 'string')) fail('"allow" must be a list of strings');
  const rules = (custom as unknown[]).map((r, i): CustomRule => {
    if (!r || typeof r !== 'object') fail(`custom[${i}] must be an object`);
    const { label, pattern, fields, ...extra } = r as Record<string, unknown>;
    if (Object.keys(extra).length) fail(`custom[${i}]: unknown key ${Object.keys(extra).map((k) => `"${k}"`).join(', ')}`);
    if (typeof label !== 'string') fail(`custom[${i}] needs a "label"`);
    if (pattern !== undefined && typeof pattern !== 'string') fail(`custom[${i}].pattern must be a string`);
    if (fields !== undefined && (!Array.isArray(fields) || !fields.every((f) => typeof f === 'string' && f.trim()))) {
      fail(`custom[${i}].fields must be a list of field names`);
    }
    return {
      label: label as string,
      ...(pattern !== undefined ? { pattern: pattern as string } : {}),
      ...(fields !== undefined ? { fields: fields as string[] } : {}),
    };
  });
  try {
    checkCustomRules(rules);
  } catch (e) {
    fail((e as Error).message);
  }
  const config: SamaranConfig = { custom: rules, allow: allow as string[] };

  if (policy !== undefined) {
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) fail('"policy" must be an object such as { "HEALTH": "block" }');
    const labels = new Set(rules.map((r) => r.label));
    for (const [key, action] of Object.entries(policy as Record<string, unknown>)) {
      if (!PII_TYPES.includes(key as PiiType) && !labels.has(key)) {
        fail(`policy: "${key}" is neither a type (${PII_TYPES.join(', ')}) nor a label in "custom"`);
      }
      if (!POLICY_ACTIONS.includes(action as PolicyAction)) fail(`policy.${key} must be one of ${POLICY_ACTIONS.map((a) => `"${a}"`).join(', ')}`);
      // A rule the model may see is a rule that does nothing: say so rather than keep it.
      if (action === 'allow' && labels.has(key)) fail(`policy.${key}: "allow" for a custom rule; remove the rule from "custom" instead`);
    }
    config.policy = policy as Record<string, PolicyAction>;
  }

  if (route !== undefined) {
    if (!route || typeof route !== 'object' || Array.isArray(route)) fail('"route" must be an object such as { "openai": "http://127.0.0.1:11434/v1" }');
    const { openai, anthropic, model, ...extra } = route as Record<string, unknown>;
    if (Object.keys(extra).length) fail(`route: unknown key ${Object.keys(extra).map((k) => `"${k}"`).join(', ')}`);
    for (const [k, v] of Object.entries({ openai, anthropic })) {
      if (v === undefined) continue;
      if (typeof v !== 'string' || !/^https?:\/\//.test(v)) fail(`route.${k} must be an http(s) URL`);
      // Routed requests go unmasked: only to a model on this machine or the local network.
      if (!localEndpoint(v as string)) fail(`route.${k} must be on this machine or the local network (localhost, 127.0.0.1, 10.x, 192.168.x, *.local), not ${v}`);
    }
    if (model !== undefined && typeof model !== 'string') fail('route.model must be a string');
    config.route = { openai: openai as string | undefined, anthropic: anthropic as string | undefined, model: model as string | undefined };
  }
  if (Object.values(config.policy ?? {}).includes('route') && !config.route?.openai && !config.route?.anthropic) {
    fail('"route" in policy needs a local endpoint: add "route": { "openai": "http://127.0.0.1:11434/v1" }');
  }

  if (audit !== undefined && audit !== false) {
    if (audit !== true && (typeof audit !== 'string' || !audit.trim())) fail('"audit" must be true or a file path');
    config.audit = path.resolve(root, audit === true ? '.lokal/audit.jsonl' : (audit as string));
    if (outside(path.resolve(root), config.audit)) fail('"audit" must be a file inside the project');
  }
  if (vaultTtlMinutes !== undefined) {
    if (typeof vaultTtlMinutes !== 'number' || !(vaultTtlMinutes > 0)) fail('"vaultTtlMinutes" must be a positive number');
    config.vaultTtlMinutes = vaultTtlMinutes as number;
  }
  if (guard !== undefined) {
    // Only stricter: a repository must not be able to turn the guard off for whoever clones it.
    if (guard !== 'strict') fail('"guard" can only be "strict" (SAMARAN_GUARD=off on your own machine turns the guard off)');
    config.guard = 'strict';
  }
  if (ner !== undefined) {
    if (typeof ner !== 'boolean') fail('"ner" must be true or false');
    if (ner) config.ner = true;
  }
  return trusted ? config : withoutWeakening(config);
}

/** The vault is forgotten after this long without use, unless the project's approved config says otherwise. */
export const DEFAULT_VAULT_TTL_MINUTES = 60;

/** A config with what would weaken protection taken out, listing what was left out in `untrusted`. */
function withoutWeakening(config: SamaranConfig): SamaranConfig {
  const left: string[] = [];
  const out: SamaranConfig = { ...config };
  if (config.allow.length) {
    left.push('"allow"');
    out.allow = [];
  }
  if (config.policy) {
    const weak = Object.entries(config.policy).filter(([, action]) => action === 'allow' || action === 'route');
    if (weak.length) {
      left.push(...weak.map(([key, action]) => `policy ${key}: "${action}"`));
      out.policy = Object.fromEntries(Object.entries(config.policy).filter(([, action]) => action !== 'allow' && action !== 'route'));
    }
  }
  if (config.route) {
    left.push('"route"');
    delete out.route;
  }
  if (config.vaultTtlMinutes !== undefined && config.vaultTtlMinutes > DEFAULT_VAULT_TTL_MINUTES) {
    left.push(`"vaultTtlMinutes": ${config.vaultTtlMinutes}`);
    delete out.vaultTtlMinutes;
  }
  if (left.length) out.untrusted = left;
  return out;
}

/**
 * Why a tool must not write to `abs`, or undefined: Lokal's own settings and records, git's internals and hooks, and
 * the agent's settings. Real values have no place there, and writing them is how an agent would switch protection off.
 */
export function protectedPath(root: string, abs: string): string | undefined {
  const rel = toPosix(path.relative(root, abs));
  const [first] = rel.split('/');
  const name = path.basename(abs).toLowerCase();
  if (name === '.samaran.json' || name === '.samaranignore') return `${rel} is Lokal's configuration`;
  if (first === '.lokal') return `${rel} is Lokal's own record`;
  if (first === '.git') return `${rel} is inside git's folder (hooks run commands)`;
  if (first === '.claude' || first === '.cursor' || first === '.gemini' || first === '.codex') return `${rel} holds the agent's settings`;
  return undefined;
}

/**
 * A name Windows keeps for a device (CON, NUL, COM1, …, with any extension), or one it changes (a trailing dot or
 * space, a stream after ":"): writing there does not make the file asked for, so it is refused on every OS.
 */
export function reservedName(abs: string): string | undefined {
  const name = path.basename(abs);
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(name)) return `${name} is a device name on Windows, not a file`;
  if (/[. ]$/.test(name) || name.includes(':')) return `${name} is not a plain file name (a trailing dot or space, or a ":" stream)`;
  return undefined;
}

/** localhost, a loopback or private address, or a .local / .internal name: a model on this machine or network. */
export function localEndpoint(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return false;
  }
  // A name without a dot (a Docker Compose service such as "ollama") resolves only on the local network.
  return host === 'localhost' || host === '::1' || host === '0.0.0.0' || !host.includes('.') || /\.(?:local|internal|localhost)$/.test(host)
    || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)
    || /^f[cd][0-9a-f]{2}:/.test(host);
}

// ------------------------------------------------------------------------------------------------ trust
//
// What a repository's .samaran.json and .samaranignore may relax applies only once the user approved those very
// files on their machine: `lokal-mcp trust` records their SHA-256 in the user's cache, and any change to a file (by a
// pull, or by an agent) needs approval again. The guard does not let an agent run `trust` or write the record.

const TRUSTABLE = ['.samaran.json', '.samaranignore'] as const;

/** Lokal's folder in the user's cache: LOKAL_CACHE_DIR, %LOCALAPPDATA%, or ~/.cache. */
export function cacheDir(): string {
  const base = process.env.LOKAL_CACHE_DIR ?? (process.platform === 'win32'
    ? (process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local'))
    : (process.env.XDG_CACHE_HOME ?? path.join(homedir(), '.cache')));
  return path.join(base, 'lokal-id');
}

/** A key for a project: the hash of its real path. */
function projectKey(root: string): string {
  let real = root;
  try {
    real = realpathSync.native(root);
  } catch {
    // a root that does not exist yet keeps its own path
  }
  return createHash('sha256').update(process.platform === 'win32' ? real.toLowerCase() : real).digest('hex').slice(0, 32);
}

export const trustStore = () => path.join(cacheDir(), 'trust.json');

function digest(root: string, name: string): string | undefined {
  try {
    return createHash('sha256').update(readFileSync(path.join(root, name))).digest('hex');
  } catch {
    return undefined;
  }
}

function readTrust(): Record<string, Record<string, string>> {
  try {
    const all = JSON.parse(readFileSync(trustStore(), 'utf8')) as unknown;
    return all && typeof all === 'object' && !Array.isArray(all) ? (all as Record<string, Record<string, string>>) : {};
  } catch {
    return {};
  }
}

/** Which of .samaran.json and .samaranignore the user approved as they are now. */
export function trustedFiles(root: string): Set<string> {
  const record = readTrust()[projectKey(root)] ?? {};
  return new Set(TRUSTABLE.filter((name) => {
    const now = digest(root, name);
    return now !== undefined && record[name] === now;
  }));
}

/** The SHA-256 of the project's .samaran.json and .samaranignore as they are now (the ones that exist). */
export function trustDigests(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of TRUSTABLE) {
    const now = digest(root, name);
    if (now !== undefined) out[name] = now;
  }
  return out;
}

/**
 * Approves the project's .samaran.json and .samaranignore as they are now; returns the files approved. `only` limits
 * it to some of them (init approves what it wrote, not a file that was already there); `expected` approves a file only
 * if it is still what the user was shown (a file changed while they read it is not approved). Other approvals stay.
 */
export function recordTrust(root: string, only?: readonly string[], expected?: Record<string, string>): string[] {
  const all = readTrust();
  const key = projectKey(root);
  const now = trustDigests(root);
  const record: Record<string, string> = {};
  // Earlier approvals of the files left alone stay while those files are unchanged.
  for (const [name, hash] of Object.entries(all[key] ?? {})) {
    if (only && !only.includes(name) && now[name] === hash) record[name] = hash;
  }
  const approved: string[] = [];
  for (const name of TRUSTABLE) {
    if (only && !only.includes(name)) continue;
    const hash = now[name];
    if (hash === undefined || (expected && expected[name] !== hash)) continue;
    record[name] = hash;
    approved.push(name);
  }
  all[key] = record;
  mkdirSync(path.dirname(trustStore()), { recursive: true });
  writeFileSync(trustStore(), `${JSON.stringify(all, null, 2)}\n`);
  return approved;
}

/** Withdraws the approval for a project. */
export function revokeTrust(root: string): void {
  const all = readTrust();
  delete all[projectKey(root)];
  mkdirSync(path.dirname(trustStore()), { recursive: true });
  writeFileSync(trustStore(), `${JSON.stringify(all, null, 2)}\n`);
}

/** Whether the project has a .samaranignore the user has not approved (it is then not applied). */
export function untrustedIgnore(root: string): boolean {
  return existsSync(path.join(root, '.samaranignore')) && !trustedFiles(root).has('.samaranignore');
}

/** detectPii with the project's own rules, minus the values it allows. */
export function detectConfigured(text: string, options: DetectOptions, config: SamaranConfig): PiiMatch[] {
  const allowed = allowedTypes(config);
  const exclude = allowed.length ? [...(options.exclude ?? []), ...allowed] : options.exclude;
  const found = detectPii(text, { ...options, custom: config.custom, ...(exclude ? { exclude } : {}) });
  return config.allow.length ? found.filter((m) => !config.allow.includes(m.value)) : found;
}

// The files write_file_unmasked wrote with real values, relative to the root: the guard checks them like data files
// whatever their extension, so real data written to docs/notes.md or src/fixtures.ts cannot be read back by `Read`.
// Only paths, never contents; in .lokal/, which is kept out of git.
const UNMASKED_LIST = path.join('.lokal', 'unmasked.json');

function legacyUnmaskedCopy(root: string): string {
  return path.join(cacheDir(), 'unmasked', `${projectKey(root)}.json`);
}

export function unmaskedRecordDirs(root: string): { project: string; cache: string } {
  return {
    project: path.join(root, '.lokal', 'unmasked'),
    cache: path.join(cacheDir(), 'unmasked', projectKey(root)),
  };
}

export function isUnmaskedRegistryPath(root: string, file: string): boolean {
  const dirs = unmaskedRecordDirs(root);
  return [path.join(root, UNMASKED_LIST), legacyUnmaskedCopy(root)].some((legacy) => path.relative(legacy, file) === '')
    || [dirs.project, dirs.cache].some((dir) => !outside(dir, file));
}

function readList(file: string, root: string): string[] {
  try {
    const list = JSON.parse(readFileSync(file, 'utf8')) as { files?: unknown };
    if (!Array.isArray(list.files)) return [];
    return list.files
      .filter((f): f is string => typeof f === 'string' && f !== '' && !path.isAbsolute(f))
      .map((f) => path.resolve(root, f))
      .filter((f) => f !== root && !outside(root, f));
  } catch {
    return [];
  }
}

function readUnmaskedRecords(dir: string, root: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name))
      .flatMap((entry) => readList(path.join(dir, entry.name), root));
  } catch {
    return [];
  }
}

/** Union of both record directories and lists written by earlier versions. */
export function loadUnmasked(root: string): string[] {
  const dirs = unmaskedRecordDirs(root);
  return [...new Set([
    ...readList(path.join(root, UNMASKED_LIST), root),
    ...readList(legacyUnmaskedCopy(root), root),
    ...readUnmaskedRecords(dirs.project, root),
    ...readUnmaskedRecords(dirs.cache, root),
  ])];
}

/** One atomic record per output so independent writers cannot drop each other's paths. */
export function recordUnmasked(root: string, file: string): boolean {
  const abs = path.resolve(root, file);
  if (path.relative(root, abs) === '' || outside(root, abs)) return false;
  const rel = toPosix(path.relative(root, abs));
  const key = process.platform === 'win32' ? rel.toLowerCase() : rel;
  const name = `${createHash('sha256').update(key).digest('hex')}.json`;
  const text = `${JSON.stringify({ files: [rel] })}\n`;
  const dirs = unmaskedRecordDirs(root);
  let recorded = false;
  try {
    const dir = path.join(root, '.lokal');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      writeInRoot(root, path.join(dir, '.gitignore'), '*\n');
    }
    writeInRoot(root, path.join(dirs.project, name), text);
    recorded = true;
  } catch (e) {
    process.stderr.write(`lokal: could not record the unmasked output in the project: ${(e as Error).message}\n`);
  }
  try {
    const cache = cacheDir();
    mkdirSync(cache, { recursive: true });
    writeInRoot(cache, path.join(dirs.cache, name), text);
    recorded = true;
  } catch (e) {
    process.stderr.write(`lokal: could not record the unmasked output in the cache: ${(e as Error).message}\n`);
  }
  return recorded;
}

/**
 * `.samaranignore` at the project root: gitignore-like patterns for files known to hold
 * only fake data (test fixtures, seeders). Patterns without "/" match the file name anywhere.
 */
export function loadIgnore(root: string, options: { trusted?: boolean; text?: string } = {}): (absPath: string) => boolean {
  const file = path.join(root, '.samaranignore');
  const text = options.text ?? (existsSync(file) ? readFileSync(file, 'utf8') : undefined);
  if (text === undefined) return () => false;
  // Files left out of every check: only when the user approved this list (`lokal-mcp trust`), or it is the reviewed
  // version a scan compares with. A cloned repository or an agent cannot add `*` to it.
  if (!(options.trusted ?? trustedFiles(root).has('.samaranignore'))) return () => false;
  const rules = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((pattern) => {
      const dirOnly = pattern.endsWith('/');
      const clean = pattern.replace(/^\/|\/$/g, '');
      return { re: globToRegExp(clean), dirOnly, anchored: pattern.replace(/\/$/, '').includes('/') };
    });

  return (absPath: string) => {
    const rel = toPosix(path.relative(root, absPath));
    if (rel.startsWith('..')) return false;
    const segments = rel.split('/');
    return rules.some(({ re, dirOnly, anchored }) => {
      if (anchored) {
        // Match the path itself or any of its parent directories.
        for (let i = segments.length; i >= 1; i--) {
          if (dirOnly && i === segments.length) continue;
          if (re.test(segments.slice(0, i).join('/'))) return true;
        }
        return false;
      }
      const candidates = dirOnly ? segments.slice(0, -1) : segments;
      return candidates.some((s) => re.test(s));
    });
  };
}

export type Document =
  /** `sampled`: only the first `sampleBytes`, cut at a line break. */
  /** `encoding`: 'latin1' for a file that is not UTF-8 (an old export in Windows-1252 or ISO-8859-1), read byte for byte. */
  | { kind: 'text'; text: string; sampled?: boolean; encoding?: TextEncoding }
  /**
   * Spreadsheet sheets, a Word document's text and tables (`unit: 'part'`), or a PDF's pages (`unit: 'page'`).
   * `unscanned` says what could not be read, such as scanned pages in an otherwise text-based PDF.
   */
  | { kind: 'sheets'; sheets: Sheet[]; unit?: 'sheet' | 'part' | 'page'; unscanned?: string }
  /** `status`: unsupported (a kind of file Lokal does not read) or failed (a kind it reads, but this one would not). */
  | { kind: 'skipped'; status: 'unsupported' | 'failed'; reason: string; dataBearing: boolean };

/** How much of a loaded document a check saw. */
export function documentStatus(doc: Document): ScanStatus {
  if (doc.kind === 'skipped') return doc.status;
  if ((doc.kind === 'text' && doc.sampled) || (doc.kind === 'sheets' && doc.unscanned)) return 'partial';
  return 'scanned';
}

const unsupported = (reason: string, dataBearing = true): Document => ({ kind: 'skipped', status: 'unsupported', reason, dataBearing });
const failed = (reason: string): Document => ({ kind: 'skipped', status: 'failed', reason, dataBearing: true });

export interface LoadOptions {
  /** Read only this many bytes of a larger text file (the guard's time budget). */
  sampleBytes?: number;
  /** Skip spreadsheets and documents above this size instead of unzipping them. */
  maxZipBytes?: number;
}

function readHead(file: string, bytes: number): string {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    const text = decodeText(buf.subarray(0, n), true).text;
    const lastBreak = text.lastIndexOf('\n');
    return lastBreak > 0 ? text.slice(0, lastBreak) : text;
  } finally {
    closeSync(fd);
  }
}

const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

/** "2, 4-6, 9" */
function pageList(pages: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < pages.length; ) {
    let j = i;
    while (j + 1 < pages.length && pages[j + 1] === pages[j]! + 1) j++;
    out.push(j > i ? `${pages[i]}-${pages[j]}` : `${pages[i]}`);
    i = j + 1;
  }
  return out.join(', ');
}

// Formats that commonly hold personal data but cannot be read yet: they must be reported, not ignored.
const UNSUPPORTED_DATA: Record<string, string> = {
  '.xls': 'Excel 97-2003 (.xls) is not supported; save it as .xlsx or .csv',
  '.doc': 'Word 97-2003 (.doc) is not supported; save it as .docx',
  '.ods': 'OpenDocument spreadsheets are not supported yet',
  '.db': 'database file',
  '.sqlite': 'database file',
  '.sqlite3': 'database file',
  '.zip': 'archive',
  '.gz': 'archive',
  '.rar': 'archive',
  '.7z': 'archive',
  '.jpg': 'image (may be a KTP or selfie photo)',
  '.jpeg': 'image (may be a KTP or selfie photo)',
  '.png': 'image (may be a KTP or selfie photo)',
  '.heic': 'image (may be a KTP or selfie photo)',
  '.webp': 'image (may be a KTP or selfie photo)',
};

const PARSED_WHOLE = new Set(['.xlsx', '.xlsm', '.docx', '.pdf']);

/** Spreadsheets, Word documents, and PDFs: parsed as a whole into sheets, parts, or pages. */
function parseWhole(ext: string, buf: Buffer): Document {
  if (ext === '.xlsx' || ext === '.xlsm') {
    try {
      return { kind: 'sheets', sheets: readXlsx(buf) };
    } catch (e) {
      return failed(`unreadable spreadsheet: ${(e as Error).message}`);
    }
  }
  if (ext === '.docx') {
    try {
      return { kind: 'sheets', sheets: readDocx(buf), unit: 'part' };
    } catch (e) {
      return failed(`unreadable Word document: ${(e as Error).message}`);
    }
  }
  try {
    const { pages, scanned, damaged, total } = readPdf(buf);
    if (!pages.length && (scanned.length || damaged.length)) {
      return damaged.length ? failed('damaged PDF: no readable text') : unsupported('PDF without a text layer (scanned); needs OCR');
    }
    const notes: string[] = [];
    if (scanned.length) {
      const one = scanned.length === 1;
      notes.push(`${one ? 'page' : 'pages'} ${pageList(scanned)} of ${total} ${one ? 'has' : 'have'} no text layer (scanned) and need${one ? 's' : ''} OCR`);
    }
    if (damaged.length) {
      const one = damaged.length === 1;
      notes.push(`${one ? 'page' : 'pages'} ${pageList(damaged)} of ${total} ${one ? 'is' : 'are'} damaged and could not be read`);
    }
    return { kind: 'sheets', sheets: pages, unit: 'page', unscanned: notes.join('; ') || undefined };
  } catch (e) {
    const message = (e as Error).message;
    return failed(/encrypted/.test(message) ? 'encrypted PDF (password-protected)' : `unreadable PDF: ${message.replace(/\.$/, '')}`);
  }
}

/** Loads a file for scanning: as text, as spreadsheet sheets, or as an explicit skip with a reason. */
/**
 * A gzipped text file ("export.csv.gz", what `zcat` prints): its text, unpacked up to MAX_FILE_BYTES so a small file
 * that unpacks to gigabytes stops there. Archives of several files (.tar.gz) stay unsupported.
 */
function gunzipText(buf: Buffer, sampleBytes?: number): Document {
  let text: Buffer;
  try {
    text = gunzipSync(buf, { maxOutputLength: MAX_FILE_BYTES });
  } catch (e) {
    return unsupported(/maxOutputLength|buffer length/i.test((e as Error).message) ? `unpacks to more than ${mb(MAX_FILE_BYTES)}` : 'damaged gzip file');
  }
  if (looksBinary(text)) return unsupported('archive');
  if (sampleBytes !== undefined && text.length > sampleBytes) {
    return { kind: 'text', text: decodeText(text.subarray(0, sampleBytes), true).text.replace(/\n[^\n]*$/, '\n'), sampled: true };
  }
  return { kind: 'text', ...decodeText(text) };
}
const GZIPPED_TEXT = /\.gz$/i;
const isGzippedText = (file: string) => GZIPPED_TEXT.test(file) && !/\.tar\.gz$/i.test(file);

export function loadDocument(file: string, options: LoadOptions = {}): Document {
  const ext = path.extname(file).toLowerCase();
  const st = statSync(file);
  if (st.size > MAX_FILE_BYTES) return unsupported(`larger than ${mb(MAX_FILE_BYTES)}`);
  if (isGzippedText(file)) return gunzipText(readFileSync(file), options.sampleBytes);
  if (PARSED_WHOLE.has(ext)) {
    if (options.maxZipBytes !== undefined && st.size > options.maxZipBytes) {
      return unsupported(`larger than ${mb(options.maxZipBytes)}`);
    }
    return parseWhole(ext, readFileSync(file));
  }
  const why = UNSUPPORTED_DATA[ext];
  if (why) return unsupported(why);
  if (!isTextFile(file)) return unsupported('binary file', false);
  if (options.sampleBytes !== undefined && st.size > options.sampleBytes) {
    return { kind: 'text', text: readHead(file, options.sampleBytes), sampled: true };
  }
  return { kind: 'text', ...decodeText(readFileSync(file)) };
}

/** Like loadDocument, for content that is not on disk, such as a file staged in git. */
export function loadBuffer(name: string, buf: Buffer): Document {
  const ext = path.extname(name).toLowerCase();
  if (buf.length > MAX_FILE_BYTES) return unsupported(`larger than ${mb(MAX_FILE_BYTES)}`);
  if (isGzippedText(name)) return gunzipText(buf);
  if (PARSED_WHOLE.has(ext)) return parseWhole(ext, buf);
  const why = UNSUPPORTED_DATA[ext];
  if (why) return unsupported(why);
  if (looksBinary(buf)) return unsupported('binary file', false);
  return { kind: 'text', ...decodeText(buf) };
}
