// UTF-16 text files: what Windows PowerShell 5.1 writes with `>` and Out-File, and Notepad's "Unicode". Their zero
// bytes made them look binary, so the guard let `cat`, `Get-Content`, and `Read` through and scan_pii skipped them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { decodeText, encodeText, looksBinary, utf16Of } from '../src/files.ts';

const CLI = path.resolve(import.meta.dirname, '../src/cli.ts');
// Made-up people: NIKs valid by structure, belonging to no one.
const CSV = 'nama,nik,hp\r\nBudi Santoso,3201011508950001,081234567890\r\nSiti Aminah,3276014501990002,085711112222\r\n';
const le = (s: string, bom = true) => Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(s, 'utf16le')]);
const be = (s: string) => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(s, 'utf16le').swap16()]);
const FILES: Record<string, Buffer> = {
  'le.csv': le(CSV),
  'le-nobom.csv': le(CSV, false),
  'be.csv': be(CSV),
  'catatan.txt': le('Pelanggan Budi Santoso NIK 3201011508950001, Siti NIK 3276014501990002, HP 081234567890\r\n'),
};

let dir: string;
before(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'lokal-utf16-'));
  for (const [name, data] of Object.entries(FILES)) writeFileSync(path.join(dir, name), data);
});
after(() => rmSync(dir, { recursive: true, force: true }));

const guard = (event: Record<string, unknown>) =>
  spawnSync(process.execPath, [CLI, 'guard'], {
    input: JSON.stringify({ cwd: dir, hook_event_name: 'PreToolUse', ...event }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    encoding: 'utf8',
  });

test('utf16: dikenali dari BOM atau dari pola nol, biner tetap biner', () => {
  assert.equal(utf16Of(le(CSV)), 'utf16le');
  assert.equal(utf16Of(le(CSV, false)), 'utf16le');
  assert.equal(utf16Of(be(CSV)), 'utf16be');
  assert.equal(utf16Of(Buffer.from(CSV)), undefined);
  assert.equal(looksBinary(le(CSV, false)), false);
  assert.equal(looksBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0])), true);
  const { text, encoding } = decodeText(be(CSV));
  assert.equal(encoding, 'utf16be');
  assert.equal(text, `﻿${CSV}`);
  assert.deepEqual(encodeText(text, 'utf16be'), be(CSV));
  assert.deepEqual(encodeText(decodeText(le(CSV)).text, 'utf16le'), le(CSV));
});

test('utf16: guard memblokir Read, cat, Get-Content, dan Grep', () => {
  for (const name of Object.keys(FILES)) {
    const events = [
      { tool_name: 'Read', tool_input: { file_path: path.join(dir, name) } },
      { tool_name: 'Bash', tool_input: { command: `cat ${name}` } },
      { tool_name: 'PowerShell', tool_input: { command: `Get-Content ${name}` } },
      { tool_name: 'Grep', tool_input: { pattern: '3201', path: name, output_mode: 'content' } },
    ];
    for (const event of events) {
      const r = guard(event);
      assert.equal(r.status, 2, `${name} ${event.tool_name}: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /3201011508950001|Budi Santoso/);
    }
  }
});

test('utf16: read_file_masked menyamarkan, scan_pii memindai, anonymize_file menulis UTF-16 lagi', async () => {
  const client = new Client({ name: 'utf16', version: '0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [CLI],
    env: { ...process.env, LOKAL_ROOT: dir, LOKAL_CACHE_DIR: path.join(dir, '.cache') } as Record<string, string>,
  }));
  try {
    const call = async (name: string, args: Record<string, unknown>) =>
      ((await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> }).content.map((c) => c.text).join('\n');
    for (const name of Object.keys(FILES)) {
      const out = await call('read_file_masked', { path: name });
      assert.doesNotMatch(out, /3201011508950001|081234567890|Budi Santoso|\u0000/, name);
      assert.match(out, /\[NIK_1\]/, name);
    }
    const scan = JSON.parse(await call('scan_pii', { path: '.' })) as { filesScanned: number; totals: Record<string, number> };
    assert.equal(scan.filesScanned, 4);
    assert.ok((scan.totals.NIK ?? 0) >= 7, JSON.stringify(scan.totals));
    for (const [name, mark] of [['le.csv', [0xff, 0xfe]], ['be.csv', [0xfe, 0xff]]] as const) {
      await call('anonymize_file', { paths: [name], output: `anon-${name}`, secret: 'uji' });
      const bytes = readFileSync(path.join(dir, `anon-${name}`));
      assert.deepEqual([...bytes.subarray(0, 2)], mark, `${name} keeps its BOM`);
      const text = decodeText(bytes).text;
      assert.match(text, /^﻿nama,nik,hp\r\n/);
      assert.doesNotMatch(text, /3201011508950001|Budi Santoso/);
    }
  } finally {
    await client.close();
  }
});
