// Which data files a shell command would print into the conversation, and which part of them.
//
// The guard only needs the common ways an agent looks at a file: `cat`, `head -5`, `grep … | sort`,
// `Get-Content x -Tail 20`, `Import-Csv x | Select-Object -First 3`. Anything it does not recognize
// (`node dedupe.js data.csv`, `python clean.py`) is allowed: running a script on the real data is the
// private way to process it, and what the script prints is the script author's choice.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { globToRegExp, localEndpoint } from './files.ts';

/** Text data formats, and PDF for `pdftotext x.pdf -`; spreadsheets are binary and print nothing readable through `cat`. */
export const SHELL_DATA_FILE = /\.(csv|tsv|json|jsonl|ndjson|log|txt|sql|xml|ya?ml|dump|bak|out|pdf)(\.\d+)?(\.gz)?$/i;
// A dotenv file (.env, .env.local, .env.production): configuration that may hold anything.
const ENV_FILE = /^\.env(?:\.[\w.-]+)?$/i;

// Files write_file_unmasked wrote with real values, whatever their extension (docs/notes.md, src/fixtures.ts).
let marked: ReadonlySet<string> = new Set();

/** Files to treat as data from now on in this process, as absolute paths: the guard passes what write_file_unmasked wrote. */
export function markDataFiles(files: Iterable<string>): void {
  marked = new Set([...files].map((f) => path.resolve(f)));
}

/**
 * Whether a file's contents count as data when a command prints it: a data format (gzipped too), a dotenv file, a file
 * with no extension (an export called `customers`), or a file write_file_unmasked wrote. Source code is not.
 */
export function isShellDataFile(file: string): boolean {
  const name = path.basename(plainPath(file));
  // An NTFS stream ("x.txt:hidden") is a second content under a name; whatever was put there is checked.
  const stream = process.platform === 'win32' && /^[^:]+:[^:$]/.test(path.basename(file));
  return SHELL_DATA_FILE.test(name) || ENV_FILE.test(name) || (!name.includes('.') && name.length > 0) || stream || marked.has(path.resolve(plainPath(file)));
}

/**
 * The file Windows opens for a path: without a "::$DATA" (or ":$DATA") stream suffix, and without the dots and spaces
 * it drops from the end of a name. "pelanggan.csv::$DATA" and "pelanggan.csv." open pelanggan.csv there.
 */
export function plainPath(p: string): string {
  if (process.platform !== 'win32') return p;
  return p.replace(/:{1,2}\$DATA$/i, '').replace(/[. ]+$/, (tail, at: number) => (p[at - 1] === '\\' || p[at - 1] === '/' ? tail : ''));
}

/** Folders whose files hold sample values on purpose: tests, fixtures, mocks, and examples. */
const SAMPLE_PATH = /(?:^|[\\/])(?:tests?|__tests__|spec|specs|fixtures?|__fixtures__|mocks?|__mocks__|examples?|testdata)[\\/]|\.(?:test|spec)\.[^\\/]+$/i;

/** A file that holds sample values on purpose (a test, a fixture), never treated as data for its numbers. */
export const isSampleFile = (file: string): boolean => SAMPLE_PATH.test(file);

export interface ShellRead {
  /** The file, or for output the guard produced itself, what produced it ("git show HEAD:data.csv"). */
  file: string;
  /** Narrows the file's text to what the command prints. */
  select: (text: string) => string;
  /** What a read-only command printed when the guard ran it (git, unzip -p, tar -O): no file holds it. */
  text?: string;
  /** Not a data file (notes, code, a page): it counts as data when it shows identity numbers (identityThreshold). */
  other?: boolean;
}

type Select = (text: string) => string;
const all: Select = (t) => t;

// Programs that print the files they are given (or their stdin).
const READERS = new Set([
  'cat', 'type', 'gc', 'get-content', 'more', 'less', 'bat', 'batcat', 'head', 'tail', 'nl', 'tac', 'sed', 'awk',
  'gawk', 'cut', 'sort', 'uniq', 'column', 'jq', 'yq', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'select-string', 'sls',
  'import-csv', 'ipcsv', 'xxd', 'od', 'strings', 'csvlook', 'csvcut', 'mlr', 'paste', 'findstr', 'pdftotext',
  'diff', 'comm', 'join', 'base64', 'base32', 'hexdump', 'iconv', 'rev', 'shuf', 'fold', 'fmt', 'expand', 'pr', 'curl',
  'zcat', 'gzcat', 'zless', 'zmore', 'zgrep', 'zegrep',
  // `done < data.csv` feeds the file to a `while read` loop, whose body prints what it reads.
  'done',
]);
// Programs that pass their stdin through to the screen, reshaped. `read` is the stdin of `… | while read l; do …`.
const FILTERS = new Set([
  ...READERS, 'tr', 'tee', 'select-object', 'select', 'format-table', 'ft', 'format-list', 'fl', 'out-string', 'out-host',
  'convertto-json', 'convertto-csv', 'where-object', 'where', '?', 'sort-object', 'group-object', 'write-output', 'echo',
  'read',
]);
const WRITE_SINKS = new Set(['out-file', 'set-content', 'add-content', 'export-csv', 'out-null']);
const PREFIXES = new Set(['command', 'time', 'nohup', 'exec', '&']);
// Programs that run the command after their own options: the options that take a value, and how many words come
// before the command (the duration of `timeout`).
const WRAPPERS: Record<string, { valued: string[]; fixed: number }> = {
  sudo: { valued: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U'], fixed: 0 },
  doas: { valued: ['-u', '-C'], fixed: 0 },
  env: { valued: ['-u', '-C', '-S', '--unset', '--chdir'], fixed: 0 },
  nice: { valued: ['-n', '--adjustment'], fixed: 0 },
  ionice: { valued: ['-c', '-n', '-p', '-P', '-u'], fixed: 0 },
  timeout: { valued: ['-s', '-k', '--signal', '--kill-after'], fixed: 1 },
  stdbuf: { valued: ['-i', '-o', '-e'], fixed: 0 },
  taskset: { valued: [], fixed: 1 },
  chrt: { valued: [], fixed: 1 },
  setsid: { valued: [], fixed: 0 },
  unbuffer: { valued: [], fixed: 0 },
  caffeinate: { valued: [], fixed: 0 },
};
// Shell words that come before a command: `if grep …; then cat …; else …`, `while read l; do echo "$l"; done`.
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '(']);
// Folder changes: `cd data && cat x.csv` reads data/x.csv.
const CD = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location']);
// Copies whose destination a later command can print: `cp x.csv /tmp/y && cat /tmp/y`.
const COPIES = new Set(['cp', 'copy', 'copy-item', 'cpi', 'mv', 'move', 'move-item', 'mi', 'ln', 'install', 'rsync']);
// Query tools that load a data file named anywhere in their arguments and print the results.
const QUERY_TOOLS = new Set(['sqlite3', 'duckdb', 'csvsql', 'csvq', 'q', 'textql', 'trdsql']);
// Commands whose output can be a list of file names for `xargs cat`.
const LISTERS = new Set(['ls', 'dir', 'find', 'fd', 'gci', 'get-childitem', 'echo', 'printf']);
// Shells that run the code after these options: `bash -c "cat x.csv"`, `cmd /c type x.csv`. cmd is read like
// PowerShell, where a backslash separates folders instead of escaping.
const SHELLS: Record<string, { flags: string[]; powershell: boolean }> = {
  bash: { flags: ['-c'], powershell: false }, sh: { flags: ['-c'], powershell: false }, zsh: { flags: ['-c'], powershell: false },
  dash: { flags: ['-c'], powershell: false }, ksh: { flags: ['-c'], powershell: false }, cmd: { flags: ['/c', '/k'], powershell: true },
  pwsh: { flags: ['-c', '-command'], powershell: true }, powershell: { flags: ['-c', '-command'], powershell: true },
};
// Searches. rg and ag go into folders by default; grep with -r. zgrep searches gzipped files.
const GREPS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'zgrep', 'zegrep']);
const RECURSIVE_GREPS = new Set(['rg', 'ag']);
/** A search into folders is checked in this many data files, as the Grep tool is. */
const MAX_SEARCHED_FILES = 300;
/** Shell scripts are followed into, up to this depth; bigger scripts are not read. */
const MAX_DEPTH = 3;
const MAX_SCRIPT_BYTES = 256 * 1024;

interface Word {
  text: string;
  quoted: boolean;
}

/** Heredoc and here-string bodies are file contents being written, not commands. */
function stripHeredocs(command: string): string {
  return command
    .replace(/(<<-?[ \t]*(['"]?)(\w+)\2)[^\n]*\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\r?\n|$)/g, '$1')
    .replace(/@(['"])\r?\n[\s\S]*?\r?\n\1@/g, "''");
}

/**
 * Splits a command line into pipelines of segments of words. Quotes are honored; `$(…)` is not
 * expanded. In PowerShell a backslash is a path separator and the backtick escapes.
 */
function parse(command: string, powershell: boolean): Word[][][] {
  const escape = powershell ? '`' : '\\';
  const pipelines: Word[][][] = [];
  let segments: Word[][] = [];
  let words: Word[] = [];
  let cur = '';
  let quoted = false;
  let started = false;
  const endWord = () => {
    if (started) words.push({ text: cur, quoted });
    cur = '';
    quoted = false;
    started = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };
  const endPipeline = () => {
    endSegment();
    if (segments.length) pipelines.push(segments);
    segments = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === "'" || c === '"') {
      const close = command.indexOf(c, i + 1);
      const end = close === -1 ? command.length : close;
      cur += command.slice(i + 1, end);
      quoted = started = true;
      i = end;
    } else if (c === escape && i + 1 < command.length && command[i + 1] !== '\n') {
      cur += command[++i];
      started = true;
    } else if (c === '\n' || c === ';' || (c === '&' && command[i + 1] === '&') || (c === '|' && command[i + 1] === '|')) {
      endPipeline();
      if (c !== '\n' && c !== ';') i++;
    } else if (c === '|') {
      endSegment();
    } else if (c === '>' || c === '<') {
      // Redirections become their own words: ">", ">>", "2>", "<".
      const fd = /^\d$|^&$/.test(cur) ? cur : '';
      if (!fd) endWord();
      cur = '';
      started = false;
      let op = fd + c;
      if (command[i + 1] === '>') op += command[++i];
      if (command[i + 1] === '&') op += command[++i] + (command[i + 1] ?? '');
      if (/&\d$/.test(op)) i++;
      words.push({ text: op, quoted: false });
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
    } else {
      cur += c;
      started = true;
    }
  }
  endPipeline();
  return pipelines;
}

function programName(word: string): string {
  return path.basename(word).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
}

function firstLines(n: number): Select {
  return (t) => t.split('\n').slice(0, Math.max(0, n)).join('\n');
}
function lastLines(n: number, fromLine?: number): Select {
  return (t) => {
    const lines = t.replace(/\n$/, '').split('\n');
    return (fromLine !== undefined ? lines.slice(Math.max(0, fromLine - 1)) : lines.slice(-Math.max(1, n))).join('\n');
  };
}
/**
 * A basic regular expression (grep without -E) as JavaScript reads one: there `\{ \} \( \) \| \+ \?` are the
 * operators and the bare characters are literal, the other way round.
 */
function fromBasicRegex(pattern: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '\\' && i + 1 < pattern.length) {
      const next = pattern[++i]!;
      out += '{}()|+?'.includes(next) ? next : `\\${next}`;
    } else {
      out += '{}()|+?'.includes(c) ? `\\${c}` : c;
    }
  }
  return out;
}

function matching(
  pattern: string,
  opts: { ignoreCase?: boolean; invert?: boolean; fixed?: boolean; onlyMatching?: boolean; basic?: boolean },
): Select {
  let re: RegExp | undefined;
  try {
    const source = opts.fixed
      ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      : (opts.basic ? fromBasicRegex(pattern) : pattern).replace(/\\([<>])/g, '\\b');
    re = new RegExp(source, opts.ignoreCase ? 'gi' : 'g');
  } catch {
    return all; // A pattern JavaScript cannot read: assume every line can come out.
  }
  if (opts.onlyMatching && !opts.invert) {
    // grep -o prints just the matched parts: `grep -o "err=[A-Za-z]*"` shows error names, not the line.
    return (t) => t.split('\n').flatMap((l) => [...l.matchAll(re!)].map((m) => m[0])).join('\n');
  }
  return (t) =>
    t
      .split('\n')
      .filter((l) => {
        re!.lastIndex = 0;
        return re!.test(l) !== Boolean(opts.invert);
      })
      .join('\n');
}

/** "2", "1,3", "2-4", "3-" → a test for 1-based field numbers. */
function fieldList(spec: string): ((n: number) => boolean) | undefined {
  const parts = spec.split(',').map((p) => /^(\d*)(-?)(\d*)$/.exec(p));
  if (parts.some((p) => !p || (!p[1] && !p[3]))) return undefined;
  return (n) =>
    parts.some((p) => {
      const from = p![1] ? Number(p![1]) : 1;
      const to = p![2] ? (p![3] ? Number(p![3]) : Infinity) : from;
      return n >= from && n <= to;
    });
}

/** Lines cut into fields, keeping only the ones asked for. */
function fields(split: (line: string) => string[], keep: (n: number) => boolean, joiner: string): Select {
  return (t) =>
    t
      .split('\n')
      .map((l) => split(l).filter((_, i) => keep(i + 1)).join(joiner))
      .join('\n');
}

/** `awk -F, '{print $2, $5}'`: the printed fields; anything fancier prints the whole line as far as we know. */
function awkSelect(args: string[], positional: string[]): Select {
  const sep = option(args, ['-f', '-F']) ?? args.find((a) => /^-F./.test(a))?.slice(2);
  const program = positional.find((p) => p.includes('{')) ?? '';
  const m = /^\s*(?:NR\s*[<>]=?\s*\d+\s*)?\{\s*print\s+((?:\$\d+\s*,?\s*)+);?\s*\}\s*$/.exec(program);
  if (!m) return all;
  const wanted = new Set([...m[1]!.matchAll(/\$(\d+)/g)].map((x) => Number(x[1])));
  if (wanted.has(0)) return all;
  const splitter = sep === undefined ? /\s+/ : sep.length === 1 ? sep : new RegExp(sep);
  return fields((l) => (sep === undefined ? l.trim() : l).split(splitter), (n) => wanted.has(n), ' ');
}

/** Value of `-Name value` / `--name=value` style options. */
function option(args: string[], names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!.toLowerCase();
    for (const n of names) {
      if (a === n) return args[i + 1];
      if (a.startsWith(`${n}=`)) return args[i]!.slice(n.length + 1);
      if (n.length === 2 && n.startsWith('-') && a.startsWith(n) && a.length > 2) {
        return args[i]!.slice(2); // -n5, -d, -F"err="
      }
    }
  }
  return undefined;
}

const has = (args: string[], ...flags: string[]) =>
  args.some((a) => flags.includes(a) || (/^-[a-zA-Z]+$/.test(a) && flags.some((f) => /^-[a-zA-Z]$/.test(f) && a.includes(f[1]!))));

interface Segment {
  program: string;
  args: string[];
  /** Words that are not options, in order. */
  positional: string[];
  inputFile?: string;
  writesToFile: boolean;
  /** Where stdout goes, for `>` and `>>`. */
  writesTo?: string;
}

/** Drops subshell and group brackets around words: `(cd data && cat x.csv)`, `{ cat x.csv; }`. */
function unbracket(words: Word[]): Word[] {
  const out: Word[] = [];
  for (const w of words) {
    let text = w.text;
    if (!w.quoted) {
      if (!out.length) text = text.replace(/^[({]+/, '');
      // A closing bracket ends a group unless the word opened it: `x.{csv,txt}` is a brace expansion.
      if (!text.includes('(')) text = text.replace(/\)+$/, '');
      if (!text.includes('{')) text = text.replace(/\}+$/, '');
    }
    if (text || w.quoted) out.push({ text, quoted: w.quoted });
  }
  return out;
}

function toSegment(words: Word[]): Segment | undefined {
  const list = unbracket(words);
  // Skip shell keywords, VAR=value assignments, and wrappers like sudo.
  for (;;) {
    const first = list[0];
    if (!first || first.quoted) break;
    const word = programName(first.text);
    if (KEYWORDS.has(first.text.toLowerCase()) || PREFIXES.has(first.text.toLowerCase()) || /^[A-Za-z_]\w*=/.test(first.text)) {
      list.shift();
    } else if (word in WRAPPERS) {
      // `timeout 5 cat x.csv`, `sudo -u app cat x.csv`, `stdbuf -oL cat x.csv`: the command is what follows the
      // wrapper's options (and the ones that take a value) and its fixed arguments (the duration of `timeout`).
      const { valued, fixed } = WRAPPERS[word]!;
      list.shift();
      while (list[0] && /^-/.test(list[0].text) && !list[0].quoted) {
        const opt = list.shift()!.text;
        if (valued.includes(opt)) list.shift();
      }
      for (let i = 0; i < fixed && list.length; i++) list.shift();
    } else {
      break;
    }
  }
  if (!list.length) return undefined;
  const program = programName(list[0]!.text);
  const args: string[] = [];
  let inputFile: string | undefined;
  let writesToFile = false;
  let writesTo: string | undefined;
  for (let i = 1; i < list.length; i++) {
    const w = list[i]!;
    if (!w.quoted && /^(\d|&)?>>?$/.test(w.text)) {
      if (!w.text.startsWith('2')) {
        writesToFile = true; // `2>` only redirects errors
        writesTo = list[i + 1]?.text;
      }
      i++;
    } else if (!w.quoted && /^\d?>&\d$/.test(w.text)) {
      // 2>&1 and friends: nothing to do
    } else if (!w.quoted && w.text === '<') {
      inputFile = list[++i]?.text;
    } else {
      args.push(w.text);
    }
  }
  const positional = args.filter((a) => !/^--?[A-Za-z]/.test(a) && !/^-\d+$/.test(a));
  return { program, args, positional, inputFile, writesToFile, writesTo };
}

/** How a segment narrows what flows through it, or `undefined` when it prints a summary instead (wc -l, grep -c). */
function selection(seg: Segment): Select | undefined {
  const { program, args } = seg;
  const num = (v: string | undefined) => (v !== undefined && /^[+-]?\d+$/.test(v) ? Number(v) : undefined);
  switch (program) {
    case 'head': {
      const n = num(option(args, ['-n', '--lines', '-c', '--bytes'])) ?? num(args.find((a) => /^-\d+$/.test(a))?.slice(1));
      return firstLines(Math.abs(n ?? 10));
    }
    case 'tail': {
      const raw = option(args, ['-n', '--lines']) ?? args.find((a) => /^-\d+$/.test(a))?.slice(1);
      if (raw?.startsWith('+')) return lastLines(0, Number(raw.slice(1)));
      return lastLines(Math.abs(num(raw) ?? 10));
    }
    case 'grep': case 'egrep': case 'fgrep': case 'rg': case 'ag': case 'findstr': case 'zgrep': case 'zegrep': {
      if (has(args, '-c', '-l', '-L', '-q', '--count', '--files-with-matches', '--files-without-match', '--quiet', '--files', '--count-matches')) {
        return undefined;
      }
      const pattern = option(args, ['-e', '--regexp']) ?? seg.positional[0];
      if (pattern === undefined) return all;
      return matching(pattern, {
        ignoreCase: has(args, '-i', '--ignore-case') || (program === 'findstr' && has(args, '/i')),
        invert: has(args, '-v', '--invert-match'),
        fixed: program === 'fgrep' || has(args, '-F', '--fixed-strings'),
        onlyMatching: has(args, '-o', '--only-matching'),
        // grep reads a basic regular expression unless told otherwise: "08[0-9]\{9\}".
        basic: ['grep', 'zgrep'].includes(program) && !has(args, '-E', '-P', '--extended-regexp', '--perl-regexp'),
      });
    }
    case 'cut': {
      const list = option(args, ['-f', '--fields']);
      const keep = list === undefined ? undefined : fieldList(list);
      if (!keep) return all;
      const delimiter = option(args, ['-d', '--delimiter']) ?? '\t';
      return fields((l) => l.split(delimiter), keep, delimiter);
    }
    case 'awk': case 'gawk':
      return awkSelect(args, seg.positional);
    case 'select-string': case 'sls': {
      const pattern = option(args, ['-pattern']) ?? seg.positional[0];
      if (pattern === undefined) return all;
      if (has(args, '-quiet', '-list')) return undefined;
      return matching(pattern, {
        ignoreCase: !has(args, '-casesensitive'),
        invert: has(args, '-notmatch'),
        fixed: has(args, '-simplematch'),
      });
    }
    case 'sed': {
      const script = option(args, ['-e', '--expression']) ?? seg.positional[0] ?? '';
      const range = /^(\d+)(?:,(\d+))?p$/.exec(script);
      if (has(args, '-n') && range) {
        const from = Number(range[1]);
        const to = Number(range[2] ?? range[1]);
        return (t) => t.split('\n').slice(from - 1, to).join('\n');
      }
      const quit = /^(\d+)q$/.exec(script);
      return quit ? firstLines(Number(quit[1])) : all;
    }
    case 'get-content': case 'gc': case 'cat': case 'type': {
      const head = num(option(args, ['-totalcount', '-head', '-first']));
      const tail = num(option(args, ['-tail', '-last']));
      if (head !== undefined) return firstLines(head);
      if (tail !== undefined) return lastLines(tail);
      return all;
    }
    case 'select-object': case 'select': {
      const first = num(option(args, ['-first']));
      const last = num(option(args, ['-last']));
      if (first !== undefined) return firstLines(first + 1); // + the header row of Import-Csv output
      if (last !== undefined) return lastLines(last);
      return all;
    }
    default:
      return all;
  }
}

/** A word as a path: Git Bash on Windows writes Z:\Project as /z/Project, PowerShell takes "\" as a separator. */
function asPath(raw: string, powershell: boolean): string {
  let word = raw.replace(/^file:\/\//i, '');
  if (/^\/[A-Za-z]:[\\/]/.test(word)) word = word.slice(1); // file:///Z:/data.csv
  if (process.platform === 'win32') word = word.replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:');
  else if (powershell) word = word.replace(/\\/g, '/');
  return plainPath(word);
}

/** Brace expansion, as the shell does it before anything else: `x.{csv,txt}` → x.csv, x.txt. At most 64 words. */
function braces(word: string): string[] {
  const m = /\{([^{}]*,[^{}]*)\}/.exec(word);
  if (!m) return [word];
  const out = m[1]!.split(',').flatMap((alt) => braces(word.slice(0, m.index) + alt + word.slice(m.index + m[0].length)));
  return out.slice(0, 64);
}

/** The files a word names: brace alternatives, and globs in any part of the path (`data/*` + `/nasabah.csv`). */
function globPaths(word: string, cwd: string): string[] {
  const abs = path.resolve(cwd, word);
  if (!/[*?[]/.test(abs)) return [abs];
  const { root } = path.parse(abs);
  let places = [root];
  for (const part of abs.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    if (!/[*?[]/.test(part)) {
      places = places.map((p) => path.join(p, part));
      continue;
    }
    const re = globToRegExp(part);
    places = places.flatMap((p) => {
      try {
        return readdirSync(p).filter((name) => re.test(name)).map((name) => path.join(p, name));
      } catch {
        return [];
      }
    }).slice(0, 2000);
  }
  return places;
}

/** The data files a word names. */
function expand(raw: string, cwd: string, powershell: boolean): string[] {
  return anyFiles(raw, cwd, powershell).filter(isShellDataFile);
}

/** Every regular file a word names, data or not: a reader prints a copy under any name as it prints the export. */
function anyFiles(raw: string, cwd: string, powershell: boolean): string[] {
  return braces(asPath(raw, powershell))
    .flatMap((word) => globPaths(word, cwd))
    .filter((file) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    });
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Data files in a folder, for `ls data | xargs cat` and `find data -name "*.csv" | xargs cat`; at most 2,000 entries. */
function dataFilesIn(dir: string, recursive: boolean): string[] {
  const out: string[] = [];
  const queue = [dir];
  let seen = 0;
  while (queue.length && seen < 2000) {
    const at = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > 2000) break;
      const full = path.join(at, e.name);
      if (e.isDirectory()) {
        if (recursive && !/^(node_modules|\.git|\.venv|venv|dist|build|target)$/.test(e.name)) queue.push(full);
      } else if (e.isFile() && isShellDataFile(full)) {
        out.push(full);
      }
    }
  }
  return out;
}

// What one command line has done so far, as the walk goes from segment to segment.
interface Walk {
  /** Folders a relative path may be in: the start folder and every folder `cd` went to (a subshell may have gone back). */
  dirs: string[];
  /** Shell and PowerShell variables: `F=x.csv`, `$f = "x.csv"`, `for f in *.csv`. */
  vars: Map<string, string[]>;
  /** Files this command writes from data files (cp, mv, `>`, tee), and what of the data they hold. */
  copies: Map<string, ShellRead[]>;
  /** Scripts this command writes (a heredoc into a file), for strict mode. */
  scripts: Map<string, string>;
  /** `$(…)` and backtick commands, taken out before parsing: their output is part of the command's. */
  subs: string[];
  powershell: boolean;
  strict: boolean;
  depth: number;
  reads: ShellRead[];
  inline: ShellRead[];
  /** Files the command sends off this machine (curl -d @x, scp x host:, nc < x), with where they go. */
  uploads: Array<{ file: string; to: string }>;
}

/** Takes `$(…)` and backtick commands out of a command, leaving a marker for each. */
function takeSubstitutions(command: string, powershell: boolean, subs: string[]): string {
  let out = '';
  for (let i = 0; i < command.length; i++) {
    if (command[i] === '$' && command[i + 1] === '(') {
      let depth = 0;
      let j = i + 1;
      for (; j < command.length; j++) {
        if (command[j] === '(') depth++;
        else if (command[j] === ')' && --depth === 0) break;
      }
      subs.push(command.slice(i + 2, j));
      out += `\u0000${subs.length - 1}\u0000`;
      i = j;
    } else if (!powershell && command[i] === '`') {
      const close = command.indexOf('`', i + 1);
      if (close === -1) {
        out += command.slice(i);
        break;
      }
      subs.push(command.slice(i + 1, close));
      out += `\u0000${subs.length - 1}\u0000`;
      i = close;
    } else {
      out += command[i];
    }
  }
  return out;
}

const varKey = (name: string, w: Walk) => (w.powershell ? name.toLowerCase() : name);

/** Replaces known variables in the words; a variable that stands alone with several values becomes several words. */
function substitute(words: Word[], w: Walk): Word[] {
  return words.flatMap((word) => {
    const whole = /^\$(?:\{(\w+)\}|env:(\w+)|(\w+))$/i.exec(word.text);
    const values = whole ? w.vars.get(varKey((whole[1] ?? whole[2] ?? whole[3])!, w)) : undefined;
    if (values) return values.map((text) => ({ text, quoted: word.quoted }));
    const text = word.text.replace(/\$\{(\w+)\}|\$(\w+)/g, (m, a?: string, b?: string) => w.vars.get(varKey((a ?? b)!, w))?.[0] ?? m);
    return [{ text, quoted: word.quoted }];
  });
}

/** Records `F=x`, `export F=x`, `$f = "x"`, and `for f in a b`; true when the words did nothing else. */
function assign(words: Word[], w: Walk): boolean {
  const texts = words.map((x) => x.text);
  if (/^for$/i.test(texts[0] ?? '') && texts[2]?.toLowerCase() === 'in') {
    w.vars.set(varKey(texts[1]!, w), texts.slice(3));
    return true;
  }
  if (w.powershell) {
    const one = /^\$(\w+)=(.+)$/.exec(texts[0] ?? '');
    if (one && texts.length === 1) {
      w.vars.set(varKey(one[1]!, w), [one[2]!]);
      return true;
    }
    const m = /^\$(\w+)$/.exec(texts[0] ?? '');
    if (m && texts[1] === '=' && texts.length === 3) w.vars.set(varKey(m[1]!, w), [texts[2]!]);
    return false; // `$rows = Get-Content x.csv` is still a command, whose output is kept to be shown later
  }
  const rest = ['export', 'declare', 'local', 'readonly', 'typeset', 'set'].includes(texts[0] ?? '') ? texts.slice(1) : texts;
  if (!rest.length || !rest.every((t) => /^[A-Za-z_]\w*=/.test(t))) return false;
  for (const t of rest) w.vars.set(t.slice(0, t.indexOf('=')), [t.slice(t.indexOf('=') + 1)]);
  return true;
}

/** Every file a word may name, in every folder the command may be in, including files the command wrote from data. */
function resolveWord(raw: string, w: Walk): ShellRead[] {
  const out: ShellRead[] = [];
  for (const dir of w.dirs) {
    const copied = w.copies.get(path.resolve(dir, asPath(raw, w.powershell)));
    if (copied) out.push(...copied);
    for (const file of anyFiles(raw, dir, w.powershell)) out.push({ file, select: all, ...(isShellDataFile(file) ? {} : { other: true }) });
  }
  return out;
}

/** The data files a search or `find` reaches through each of `places`: the files themselves, or every data file under a folder. */
function inFolders(places: string[], w: Walk): ShellRead[] {
  const out: ShellRead[] = [];
  for (const place of places) {
    out.push(...resolveWord(place, w));
    for (const dir of w.dirs) {
      const at = path.resolve(dir, asPath(place, w.powershell));
      if (isDir(at)) for (const file of dataFilesIn(at, true)) out.push({ file, select: all });
    }
  }
  return out.slice(0, MAX_SEARCHED_FILES);
}

// ------------------------------------------------------------------------------------------------ replayed reads
//
// Some commands print data no file on disk holds: what was committed (`git show HEAD:data.csv`, `git log -p`) and what
// is inside an archive (`unzip -p export.zip`, `tar -xOzf export.tar.gz`). The guard runs the read-only ones itself,
// with nothing the agent's arguments could turn into another command: no pager, external diff, textconv, or fsmonitor,
// no global git options but -C, and only the forms that print to stdout. What they print is checked like a file.

const REPLAY_MS = 3000;
const REPLAY_BYTES = 5 * 1024 * 1024;
const GIT_READS = new Set(['show', 'log', 'grep', 'diff', 'cat-file']);

/** The program and arguments to run for a read-only command that prints data from git or an archive, or undefined. */
function replayable(seg: Segment): string[] | undefined {
  const { program, args } = seg;
  if (seg.writesToFile) return undefined;
  if (program === 'git') {
    let i = 0;
    const global: string[] = [];
    while (args[i]?.startsWith('-')) {
      if (args[i] !== '-C' || args[i + 1] === undefined) return undefined; // -c, --exec-path, …: not run
      global.push('-C', args[i + 1]!);
      i += 2;
    }
    const sub = args[i];
    const rest = args.slice(i + 1);
    if (!sub || !GIT_READS.has(sub)) return undefined;
    if (rest.some((a) => /^(?:--ext-diff|--textconv|--output|-O|--open-files-in-pager)(?:=|$)/.test(a))) return undefined;
    // A log without -p prints messages; a diff of the working tree would run the repository's clean filters.
    if (sub === 'log' && !rest.some((a) => /^(?:-p|-u|--patch|-L.*)$/.test(a))) return undefined;
    if (sub === 'diff' && !rest.some((a) => /^--(?:cached|staged)$/.test(a)) && rest.filter((a) => !a.startsWith('-')).length < 2) return undefined;
    if (sub === 'cat-file' && !rest.includes('-p')) return undefined;
    const safe = ['show', 'log', 'diff'].includes(sub) ? ['--no-ext-diff', '--no-textconv', '--no-color'] : sub === 'grep' ? ['--no-color'] : [];
    return [
      'git', '--no-pager', '-c', 'core.pager=cat', '-c', 'core.fsmonitor=false', '-c', 'diff.external=', '-c', 'color.ui=false',
      ...global, sub, ...safe, ...rest,
    ];
  }
  if (program === 'unzip' && has(args, '-p', '-c')) return ['unzip', ...args];
  if (program === 'zipgrep') return ['zipgrep', ...args];
  if (program === 'tar' || program === 'bsdtar') {
    const flags = args.filter((a) => /^-?[A-Za-z]+$/.test(a) && !a.startsWith('--')).join('');
    const extract = /x/.test(flags.replace(/^-/, '')) || args.includes('--extract') || args.includes('--get');
    const stdout = /O/.test(flags) || args.includes('--to-stdout');
    return extract && stdout ? [program, ...args] : undefined;
  }
  return undefined;
}

/** Runs a replayable command in the folder the command runs in; what it printed, or undefined when it failed. */
function replay(argv: string[], w: Walk): string | undefined {
  const env = { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat', GIT_EXTERNAL_DIFF: '', GIT_TERMINAL_PROMPT: '0' };
  const res = spawnSync(argv[0]!, argv.slice(1), { cwd: w.dirs.at(-1), env, timeout: REPLAY_MS, maxBuffer: REPLAY_BYTES, encoding: 'utf8', windowsHide: true });
  const out = typeof res.stdout === 'string' ? res.stdout : '';
  return out.length ? out : undefined;
}

/** The first of these files in the folders the command may be in, as text. */
function projectFile(names: string[], w: Walk): string | undefined {
  for (const dir of w.dirs) {
    for (const name of names) {
      try {
        const file = path.join(dir, name);
        if (statSync(file).size <= MAX_SCRIPT_BYTES) return readFileSync(file, 'utf8');
      } catch {
        // not there
      }
    }
  }
  return undefined;
}

/** The recipe of a Makefile target (its tab-indented lines), or of the first target when none is named. */
function makeRecipe(makefile: string, target: string | undefined): string | undefined {
  const lines = makefile.split(/\r?\n/);
  const head = lines.findIndex((l) => {
    const m = /^([A-Za-z0-9_.\/-][^:=\s]*(?:\s+[^:=\s]+)*)\s*:(?!=)/.exec(l);
    return !!m && !m[1]!.startsWith('.') && (target === undefined || m[1]!.split(/\s+/).includes(target));
  });
  if (head < 0) return undefined;
  const recipe: string[] = [];
  for (const line of lines.slice(head + 1)) {
    if (!line.startsWith('\t')) break;
    recipe.push(line.slice(1).replace(/^[@+-]+/, ''));
  }
  return recipe.join('\n');
}

/** Code a segment runs as another command: eval, script -c, a package.json script, a make target, awk's system(). */
function indirectCode(seg: Segment, w: Walk): string | undefined {
  switch (seg.program) {
    case 'eval':
      return seg.args.join(' ');
    case 'script':
    {
      // `script -qc "cmd" /dev/null`: -c, alone or after other short options.
      const at = seg.args.findIndex((a) => /^-[a-zA-Z]*c$/.test(a) || a === '--command');
      return at >= 0 ? seg.args[at + 1] : option(seg.args, ['--command']);
    }
    case 'npm': case 'pnpm': case 'yarn': case 'bun': {
      const [verb, name] = seg.positional;
      const script = ['run', 'run-script'].includes(verb ?? '') ? name : seg.program !== 'npm' && seg.program !== 'bun' ? verb : undefined;
      if (!script) return undefined;
      try {
        const pkg = JSON.parse(projectFile(['package.json'], w) ?? '{}') as { scripts?: Record<string, string> };
        return pkg.scripts?.[script];
      } catch {
        return undefined;
      }
    }
    case 'make': case 'gmake': {
      const makefile = projectFile(['GNUmakefile', 'makefile', 'Makefile'], w);
      return makefile === undefined ? undefined : makeRecipe(makefile, seg.positional.find((a) => !a.includes('=')));
    }
    case 'awk': case 'gawk': {
      // system("cat x.csv") runs a command; getline < "x.csv" reads a file the way cat does.
      const code = seg.positional.filter((p) => p.includes('{')).join('\n');
      const run = [...code.matchAll(/system\s*\(\s*(["'])(.*?)\1\s*\)/g)].map((m) => m[2]!);
      const read = [...code.matchAll(/getline[^<]*<\s*(["'])(.*?)\1/g)].map((m) => `cat '${m[2]}'`);
      return run.length || read.length ? [...run, ...read].join('\n') : undefined;
    }
    default:
      return undefined;
  }
}

/** `sh -c 'cat "$1"' _ {}` under find -exec or xargs: a shell whose code prints the files it is given. */
function shellPrintsFiles(inner: Segment | undefined): boolean {
  const shell = inner && SHELLS[inner.program];
  if (!shell) return false;
  const at = inner.args.findIndex((a) => shell.flags.includes(a.toLowerCase()));
  const code = at >= 0 ? inner.args[at + 1] ?? '' : '';
  return [...READERS].some((r) => new RegExp(`(?:^|[\\s;|&(])${r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`).test(code));
}

/** A script's text: one this command writes, or a file of up to MAX_SCRIPT_BYTES. */
function readScript(raw: string, w: Walk): string | undefined {
  for (const dir of w.dirs) {
    const file = path.resolve(dir, asPath(raw, w.powershell));
    const written = w.scripts.get(file);
    if (written !== undefined) return written;
    try {
      const stat = statSync(file);
      if (stat.isFile() && stat.size <= MAX_SCRIPT_BYTES) return readFileSync(file, 'utf8');
    } catch {
      // not there
    }
  }
  return undefined;
}

/** Walks a command (or a script's text) inside `w`, adding what it prints to `w.reads` (and, strict, to `w.inline`). */
function walk(command: string, w: Walk): void {
  for (const m of command.matchAll(HEREDOC)) {
    const target = /(?:>\s*|\btee\s+)([^\s<>|;&]+)/.exec(m[0].trimStart().split('\n')[0]!)?.[1];
    if (target) for (const dir of w.dirs) w.scripts.set(path.resolve(dir, asPath(target, w.powershell)), m[4]!);
  }
  const text = takeSubstitutions(stripHeredocs(command), w.powershell, w.subs);
  for (const pipeline of parse(text, w.powershell)) {
    let flow: ShellRead[] = [];
    let piped: string | undefined;
    // File names earlier in the pipeline, for `… | xargs cat`; listed only when an xargs needs them.
    const listed: Array<() => ShellRead[]> = [];
    for (const raw of pipeline) {
      // A `$(…)` in the words runs first, and what it prints is part of this command.
      for (const word of raw) {
        for (const m of word.text.matchAll(/\u0000(\d+)\u0000/g)) walk(w.subs[Number(m[1])]!, w);
      }
      const words = substitute(raw, w);
      if (assign(words, w)) continue;
      const kept = w.powershell && /^\$\w+$/.test(words[0]?.text ?? '') && words[1]?.text === '=';
      const seg = toSegment(kept ? words.slice(2) : words);
      if (!seg) continue;
      const reads = (word: string) => resolveWord(word, w);
      // Sending a file away is not printing it, and no less of a leak.
      for (const sent of uploadsIn(seg, flow, w)) w.uploads.push(sent);

      if (CD.has(seg.program)) {
        const to = seg.positional.find((a) => a.toLowerCase() !== '/d');
        if (to && to !== '-' && to !== '~') {
          for (const dir of [...w.dirs]) {
            const next = path.resolve(dir, asPath(to, w.powershell));
            if (!w.dirs.includes(next) && isDir(next)) w.dirs.push(next);
          }
        }
        continue;
      }

      if (COPIES.has(seg.program)) {
        const destination = w.powershell ? option(seg.args, ['-destination']) : undefined;
        const named = destination !== undefined
          ? [option(seg.args, ['-path', '-literalpath']) ?? seg.positional[0] ?? '', destination]
          : seg.positional;
        const dest = named[named.length - 1];
        const sources = named.slice(0, -1).flatMap((s) => reads(s));
        if (dest && sources.length) {
          for (const dir of w.dirs) {
            const target = path.resolve(dir, asPath(dest, w.powershell));
            const intoDir = isDir(target) || /[\\/]$/.test(dest) || sources.length > 1;
            for (const r of sources) {
              const at = intoDir ? path.join(target, path.basename(r.file)) : target;
              w.copies.set(at, [...(w.copies.get(at) ?? []), r]);
            }
          }
        }
        flow = [];
        continue;
      }

      // What a segment hands on its stdout as text the guard can read: `echo …`, and `… | base64 -d` of that.
      const incoming = piped;
      piped = ['echo', 'printf'].includes(seg.program)
        ? seg.positional.join(' ')
        : seg.program === 'base64' && incoming !== undefined && has(seg.args, '-d', '--decode', '-D')
          ? Buffer.from(incoming, 'base64').toString('utf8')
          : undefined;

      // Commands that run other commands: `eval "c""at x.csv"`, `script -qc "cat x.csv"`, `npm run peek`, `make peek`,
      // `awk 'BEGIN{system("cat x.csv")}'`. awk also reads files itself, so it goes on below.
      const indirect = indirectCode(seg, w);
      if (indirect !== undefined) {
        if (w.depth < MAX_DEPTH && !seg.writesToFile) walk(indirect, { ...w, depth: w.depth + 1 });
        if (!['awk', 'gawk'].includes(seg.program)) {
          flow = [];
          continue;
        }
      }

      // Shells and shell scripts: `bash -c "…"`, `cmd /c …`, `pwsh -c …`, `bash x.sh`, `source x.sh`, `./x.sh`, and a
      // shell reading its commands from a pipe (`echo Y2F0… | base64 -d | sh`).
      const shell = SHELLS[seg.program];
      const sourced = ['source', '.'].includes(seg.program);
      if (shell || sourced || /\.(sh|bash|ps1)$/i.test(seg.program)) {
        const at = shell ? seg.args.findIndex((a) => shell.flags.includes(a.toLowerCase())) : -1;
        const powershell = shell ? shell.powershell : /\.ps1$/i.test(seg.program) || (sourced && w.powershell);
        const script = shell || sourced ? (option(seg.args, ['-file']) ?? seg.positional[0]) : raw[0]!.text;
        const inner = at >= 0
          ? seg.args.slice(at + 1).join(' ')
          : script !== undefined ? readScript(script, w) : shell ? incoming : undefined;
        if (inner !== undefined && w.depth < MAX_DEPTH && !seg.writesToFile) walk(inner, { ...w, powershell, depth: w.depth + 1 });
        flow = [];
        continue;
      }

      if (w.strict && !seg.writesToFile) strictCode(seg, words, w);

      let isReader = READERS.has(seg.program);
      let narrow = selection(seg);
      let files: ShellRead[] | undefined;
      const replayed = replayable(seg);
      if (replayed) {
        // git show HEAD:data.csv, git log -p, unzip -p export.zip: run it, and check what it printed.
        const text = replay(replayed, w);
        isReader = true;
        narrow = all;
        files = text === undefined ? [] : [{ file: seg.args.length ? `${seg.program} ${seg.args.join(' ')}` : seg.program, select: all, text }];
      } else if (seg.program === 'xargs') {
        // `ls data/*.csv | xargs cat`: the files are the names earlier in the pipeline.
        let i = 0;
        while (i < seg.args.length && seg.args[i]!.startsWith('-')) i += /^-[InLPdaEs]$/.test(seg.args[i]!) ? 2 : 1;
        const inner = toSegment(seg.args.slice(i).map((text) => ({ text, quoted: false })));
        isReader = !!inner && (READERS.has(inner.program) || shellPrintsFiles(inner));
        narrow = inner && shellPrintsFiles(inner) ? all : inner ? selection(inner) : undefined;
        files = isReader ? listed.flatMap((list) => list()) : [];
      } else if (['perl', 'ruby'].includes(seg.program) && seg.args.some((a) => /^-[a-zA-Z]*[pn]/.test(a))) {
        isReader = true; // perl -pe / -ne goes through the lines of the files it is given
        narrow = all;
      } else if (/^python[\d.]*$|^py$/.test(seg.program) && option(seg.args, ['-m']) === 'json.tool') {
        isReader = true;
        narrow = all;
      } else if (QUERY_TOOLS.has(seg.program)) {
        // sqlite3 :memory: ".import data.csv t" "select * from t": the files are named inside its arguments.
        isReader = true;
        narrow = all;
        files = seg.args.flatMap((a) => [...a.matchAll(NAMED_FILE)].flatMap((m) => reads(m[0])));
      } else if (seg.program === 'dd') {
        // `dd if=x.csv` prints the file unless `of=` sends it elsewhere.
        const input = seg.args.find((a) => a.startsWith('if='))?.slice(3);
        isReader = !!input && !seg.args.some((a) => a.startsWith('of='));
        narrow = all;
        files = isReader ? reads(input!) : [];
      } else if (['gzip', 'gunzip'].includes(seg.program) && seg.args.some((a) => /^-[a-zA-Z]*c[a-zA-Z]*$|^--(?:to-)?stdout$/.test(a))) {
        isReader = true; // gzip -dc / gunzip -c export.csv.gz prints the text, as zcat does
        narrow = all;
      } else if (seg.program === 'find' && seg.args.some((a) => /^-exec(?:dir)?$/.test(a))) {
        // `find data -name "*.csv" -exec head {} \;`: the files find lists, through the command it runs on each.
        const at = seg.args.findIndex((a) => /^-exec(?:dir)?$/.test(a));
        const end = seg.args.findIndex((a, i) => i > at && (a === ';' || a === '+'));
        const inner = toSegment(seg.args.slice(at + 1, end < 0 ? undefined : end).filter((a) => a !== '{}').map((text) => ({ text, quoted: false })));
        isReader = !!inner && (READERS.has(inner.program) || shellPrintsFiles(inner));
        narrow = inner && shellPrintsFiles(inner) ? all : inner ? selection(inner) : undefined;
        const firstOption = seg.args.findIndex((a) => a.startsWith('-'));
        const places = seg.args.slice(0, firstOption < 0 ? seg.args.length : firstOption);
        files = isReader ? inFolders(places.length ? places : ['.'], w) : [];
      } else if (GREPS.has(seg.program) && (RECURSIVE_GREPS.has(seg.program) || has(seg.args, '-r', '-R', '--recursive', '--dereference-recursive'))) {
        // `grep -rn 0812 .`, `rg Budi data/`: every data file under the folders, through the search.
        const patternGiven = option(seg.args, ['-e', '--regexp']) !== undefined;
        const places = seg.positional.slice(patternGiven ? 0 : 1);
        files = inFolders(places.length ? places : ['.'], w);
      }
      if (LISTERS.has(seg.program)) {
        const recursive = seg.program === 'find' || seg.program === 'fd';
        const places = seg.positional.length || !recursive ? seg.positional : ['.'];
        const dirs = [...w.dirs];
        listed.push(() =>
          places.flatMap((a) => [
            ...reads(a),
            ...dirs.flatMap((dir) => {
              const at = path.resolve(dir, asPath(a, w.powershell));
              return isDir(at) ? dataFilesIn(at, recursive).map((file) => ({ file, select: all })) : [];
            }),
          ]),
        );
      }

      if (seg.program === 'pdftotext' && !seg.args.includes('-')) {
        flow = []; // `pdftotext in.pdf out.txt` writes a file; only `pdftotext in.pdf -` prints the text
        continue;
      }
      if (WRITE_SINKS.has(seg.program) || (!isReader && !FILTERS.has(seg.program))) {
        flow = []; // written to a file, or consumed by a program whose output we cannot predict
        continue;
      }
      if (!narrow) {
        flow = []; // a count or a yes/no, not the data
        continue;
      }
      if (isReader && files === undefined) files = [...seg.args, ...(seg.inputFile ? [seg.inputFile] : [])].flatMap(reads);
      // A filter fed a file on its stdin prints it as it would its pipe: `tee < x.csv`, `tr a-z A-Z < x.csv`.
      else if (files === undefined && seg.inputFile) files = reads(seg.inputFile);
      const select = narrow;
      flow = (files?.length ? files : seg.program === 'xargs' ? [] : flow).map((r) => ({ ...r, select: (t: string) => select(r.select(t)) }));
      // What goes into a file can be printed by a later command: `head x.csv > /tmp/y; cat /tmp/y`.
      const targets = [...(seg.writesTo ? [seg.writesTo] : []), ...(seg.program === 'tee' ? seg.positional : [])];
      if (flow.length) for (const t of targets) for (const dir of w.dirs) w.copies.set(path.resolve(dir, asPath(t, w.powershell)), flow);
      if (seg.writesToFile && seg.program !== 'tee') flow = [];
    }
    for (const r of flow) w.reads.push(r);
  }
}

function newWalk(cwd: string, powershell: boolean, strict: boolean): Walk {
  return { dirs: [cwd], vars: new Map(), copies: new Map(), scripts: new Map(), subs: [], powershell, strict, depth: 0, reads: [], inline: [], uploads: [] };
}

// A remote destination of scp, rsync, rclone and the like: host:path or user@host:path, not a Windows drive (C:\).
const REMOTE = /^(?:[\w.-]+@)?[\w.-]{2,}:(?![\\/]{2}|[\\/]?$)|^[a-z][\w+.-]*:\/\//i;
const URL_ARG = /^https?:\/\//i;

/**
 * The files a segment sends off this machine, and where: curl and wget uploads, scp/rsync/sftp/rclone to a remote,
 * cloud copies (aws s3, gsutil, az, gh gist), nc/socat fed a file, Invoke-WebRequest -InFile. `flow` is what comes into
 * it through a pipe (`cat x.csv | curl -d @- …`). Uploads to this machine or the local network are not counted.
 */
function uploadsIn(seg: Segment, flow: ShellRead[], w: Walk): Array<{ file: string; to: string }> {
  const { program, args } = seg;
  const out: Array<{ file: string; to: string }> = [];
  const send = (word: string | undefined, to: string) => {
    if (!word) return;
    if (word === '-' || word === '@-') {
      for (const r of flow) out.push({ file: r.file, to });
      return;
    }
    const name = word.replace(/^[\w.-]*=?[@<]/, '').replace(/;type=.*$/, '');
    for (const r of resolveWord(name, w)) out.push({ file: r.file, to });
  };
  const urls = args.filter((a) => URL_ARG.test(a));
  const remote = (to: string) => !URL_ARG.test(to) || !localEndpoint(to);
  switch (program) {
    case 'curl': {
      const to = urls[0] ?? 'a server';
      if (urls.length && urls.every((u) => !remote(u))) return out;
      for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        const value = (flag: RegExp) => (flag.test(a) ? (a.includes('=') && a.startsWith('--') ? a.slice(a.indexOf('=') + 1) : args[++i]) : undefined);
        const data = value(/^(?:-d|--data|--data-binary|--data-urlencode|--json|-F|--form|-T|--upload-file)(?:=|$)/);
        if (data === undefined) continue;
        if (/^-T$|^--upload-file/.test(a)) send(data, to);
        else if (/[@<]/.test(data)) send(data.slice(data.search(/[@<]/)), to);
      }
      if (seg.inputFile && args.some((a) => /^(?:-d|--data(?:-binary)?|-T|--upload-file)$/.test(a))) send(seg.inputFile, to);
      return out;
    }
    case 'wget': {
      const to = urls[0] ?? 'a server';
      if (urls.length && urls.every((u) => !remote(u))) return out;
      send(option(args, ['--post-file', '--body-file']), to);
      return out;
    }
    case 'scp': case 'rsync': case 'sftp': case 'rclone': {
      const places = seg.positional.filter((p) => !['copy', 'copyto', 'move', 'moveto', 'sync'].includes(p));
      const dest = places.at(-1);
      if (!dest || !REMOTE.test(dest) || (URL_ARG.test(dest) && localEndpoint(dest))) return out;
      for (const p of places.slice(0, -1)) if (!REMOTE.test(p)) send(p, dest);
      return out;
    }
    case 'aws': case 'gsutil': case 'az': case 'gh': {
      // aws s3 cp x.csv s3://b/, gsutil cp x.csv gs://b/, az storage blob upload -f x.csv, gh gist create x.csv
      const cloud = seg.positional.find((p) => /^(?:s3|gs|az|https?):\/\//.test(p));
      if (program === 'az') send(option(args, ['-f', '--file']), 'Azure storage');
      else if (program === 'gh' && seg.positional[0] === 'gist') for (const p of seg.positional.slice(2)) send(p, 'a GitHub gist');
      else if (program === 'gh' && seg.positional[0] === 'release') for (const p of seg.positional.slice(3)) send(p, 'a GitHub release');
      else if (cloud) for (const p of seg.positional) if (p !== cloud && !['s3', 'cp', 'mv', 'sync', 'rsync'].includes(p)) send(p, cloud);
      return out;
    }
    case 'nc': case 'ncat': case 'netcat': case 'socat': case 'telnet': {
      const to = seg.positional[0] ?? 'a network address';
      if (localEndpoint(`http://${to}`)) return out;
      if (seg.inputFile) send(seg.inputFile, to);
      for (const r of flow) out.push({ file: r.file, to });
      return out;
    }
    case 'invoke-webrequest': case 'iwr': case 'invoke-restmethod': case 'irm': case 'send-mailmessage': {
      const to = option(args, ['-uri']) ?? urls[0] ?? (program === 'send-mailmessage' ? 'e-mail' : 'a server');
      if (URL_ARG.test(to) && localEndpoint(to)) return out;
      send(option(args, ['-infile', '-attachments']), to);
      return out;
    }
    default:
      return out;
  }
}

/** Data files whose contents the command prints to the conversation. */
export function dataReadsInCommand(command: string, cwd: string, powershell = false): ShellRead[] {
  return analyzeCommand(command, cwd, powershell).reads;
}

/**
 * What a command prints (`reads`), and the files it writes from data files (`copies`: cp, mv, ln, Copy-Item, `>`,
 * tee), each with the data files it comes from. A copy under another name is data too, in the commands after it.
 */
export function analyzeCommand(command: string, cwd: string, powershell = false): {
  reads: ShellRead[];
  copies: Array<{ target: string; from: string[] }>;
  uploads: Array<{ file: string; to: string }>;
} {
  const w = newWalk(cwd, powershell, false);
  walk(command, w);
  const copies = [...w.copies]
    .map(([target, from]) => ({ target, from: [...new Set(from.filter((r) => !r.other && r.text === undefined).map((r) => r.file))] }))
    .filter((c) => c.from.length);
  return { reads: w.reads, copies, uploads: w.uploads };
}

// ------------------------------------------------------------------------------------------------ strict mode
//
// Code passed on the command line can print a file as easily as `cat`: `python -c "print(open('x.csv').read())"`. The
// default guard allows it, because one-liners that count or check data are common. In strict mode a data file named in
// such code is treated as printed, and so is one named in a script that an interpreter runs with its output on the
// screen (`python report.py`, or a script a heredoc wrote a moment before): what it prints reaches the conversation
// too. Output redirected to a file (`python clean.py > bersih.csv`), or a data file passed as an argument
// (`python clean.py data.csv`), still runs.

/** Interpreters, and the options after which their code follows on the command line. */
const INLINE_CODE: Record<string, string[]> = {
  python: ['-c'], python3: ['-c'], py: ['-c'], node: ['-e', '--eval', '-p', '--print'], bun: ['-e', '--eval', '-p', '--print'],
  deno: ['eval'], ruby: ['-e'], perl: ['-e', '-E'], php: ['-r'], rscript: ['-e'], pwsh: ['-c', '-command'],
  powershell: ['-c', '-command'],
};
const SCRIPT_FILE = /\.(py|js|mjs|cjs|ts|mts|rb|pl|php|r)$/i;
const NAMED_FILE = /[\w.~:\\/-]+\.(?:csv|tsv|json|jsonl|ndjson|log|txt|sql|xml|ya?ml|dump|bak|out)(?:\.\d+)?(?![\w.])/gi;
// .NET file reads in PowerShell: [IO.File]::ReadAllText('x.csv'), [System.IO.File]::ReadAllLines(...)
const DOTNET_READ = /\[(?:system\.)?io\.file\]::\s*read/i;
// A heredoc fed to a program: `python3 - <<'EOF'` … `EOF`.
const HEREDOC = /(?:^|\n)[ \t]*(\S+)[^\n]*?<<-?[ \t]*(['"]?)(\w+)\2[^\n]*\n([\s\S]*?)\n[ \t]*\3[ \t]*(?=\r?\n|$)/g;
// A PowerShell here-string piped to a program: @' … '@ | python -
const HERE_STRING = /@(['"])\r?\n([\s\S]*?)\r?\n\1@[ \t]*\|[ \t]*(\S+)/g;

function namedFiles(code: string, w: Walk): string[] {
  return [...code.matchAll(NAMED_FILE)].flatMap((m) => w.dirs.flatMap((dir) => expand(m[0].replace(/^[(]+/, ''), dir, w.powershell)));
}

/** Strict mode: the data files named in code an interpreter runs from this segment. */
function strictCode(seg: Segment, words: Word[], w: Walk): void {
  const flags = INLINE_CODE[seg.program];
  const at = flags ? seg.args.findIndex((a) => flags.includes(a.toLowerCase())) : -1;
  const joined = words.map((x) => x.text).join(' ');
  let code: string | undefined;
  if (at >= 0) code = seg.args.slice(at + 1).join(' ');
  else if (w.powershell && DOTNET_READ.test(joined)) code = joined;
  else if (flags && seg.positional[0] && SCRIPT_FILE.test(seg.positional[0])) code = readScript(seg.positional[0], w);
  if (code !== undefined) for (const file of namedFiles(code, w)) w.inline.push({ file, select: all });
}

/** Strict mode: data files named in code that runs from the command line, which may print them whole. */
export function inlineCodeReads(command: string, cwd: string, powershell = false): ShellRead[] {
  const w = newWalk(cwd, powershell, true);
  for (const m of command.matchAll(HEREDOC)) {
    if (programName(m[1]!) in INLINE_CODE) for (const f of namedFiles(m[4]!, w)) w.inline.push({ file: f, select: all });
  }
  for (const m of command.matchAll(HERE_STRING)) {
    if (programName(m[3]!) in INLINE_CODE) for (const f of namedFiles(m[2]!, w)) w.inline.push({ file: f, select: all });
  }
  walk(command, w);
  const seen = new Set<string>();
  return w.inline.filter((r) => !seen.has(r.file) && seen.add(r.file));
}
