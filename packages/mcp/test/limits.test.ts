import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const CLI = path.resolve(import.meta.dirname, '../src/cli.ts');

test('MCP: permintaan terlalu besar dijawab error, server tetap hidup dan vault tidak hilang', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lokal-limit-'));
  writeFileSync(path.join(dir, 'a.csv'), 'nik\n3201011508950001\n');
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [CLI],
    env: { ...process.env, LOKAL_ROOT: dir, LOKAL_MAX_MESSAGE_MB: '1' } as Record<string, string>,
  }));
  try {
    const read = await client.callTool({ name: 'read_file_masked', arguments: { path: 'a.csv' } });
    assert.match(JSON.stringify(read), /\[NIK_1\]/);
    await assert.rejects(
      client.callTool({ name: 'write_file_unmasked', arguments: { path: 'b.txt', content: 'x'.repeat(2 * 1024 * 1024) } }),
      /larger than 1 MB/,
    );
    // Still there, with the same vault.
    const wrote = await client.callTool({ name: 'write_file_unmasked', arguments: { path: 'c.txt', content: '[NIK_1]' } });
    assert.match(JSON.stringify(wrote), /"restored\\?": ?1/);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('guard: berkas besar yang ditampilkan melewati bagian yang diperiksa ditanyakan (default) atau diblokir (strict)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lokal-big-'));
  try {
    // 12 MB of harmless rows, then one made-up person past the 5 MB the guard reads.
    const rows = Array.from({ length: 400000 }, (_, i) => `${i},ok,2026-01-01T00:00:00`).join('\n');
    writeFileSync(path.join(dir, 'ekspor.csv'), `id,status,ts\n${rows}\nBudi Santoso,3201011508950001,081234567890\n`);
    const guard = (tool: string, input: Record<string, unknown>, mode = '') => {
      const r = spawnSync(process.execPath, [CLI, 'guard'], {
        input: JSON.stringify({ cwd: dir, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input }),
        env: { ...process.env, CLAUDE_PROJECT_DIR: dir, SAMARAN_GUARD: mode },
        encoding: 'utf8',
      });
      if (r.status === 2) return 'block';
      return /"permissionDecision":"ask"/.test(r.stdout) ? 'ask' : 'allow';
    };
    for (const [tool, input] of [
      ['Bash', { command: 'tail -n 1 ekspor.csv' }],
      ['Bash', { command: 'grep 3201 ekspor.csv' }],
      ['Grep', { pattern: '3201', path: 'ekspor.csv', output_mode: 'content' }],
    ] as const) {
      assert.equal(guard(tool, input), 'ask', `${tool} ${JSON.stringify(input)}`);
      assert.equal(guard(tool, input, 'strict'), 'block', `${tool} ${JSON.stringify(input)} strict`);
    }
    // What stays inside the part that was read is checked and let through.
    assert.equal(guard('Bash', { command: 'head -n 20 ekspor.csv' }), 'allow');
    assert.equal(guard('Grep', { pattern: '3201', path: 'ekspor.csv', output_mode: 'count' }), 'allow');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
