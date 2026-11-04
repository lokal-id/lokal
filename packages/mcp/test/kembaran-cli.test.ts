import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = path.resolve(import.meta.dirname, '../src/cli.ts');
// Made-up NIKs: valid by structure, belonging to no one.
const NIKS = ['3276010101800001', '3276014501990002', '3201011508950003'];
const dotted = (n: string) => n.replace(/(\d{4})(\d{4})(\d{4})(\d{4})/, '$1.$2.$3.$4');

function kembaran(dir: string, ...args: string[]) {
  return spawnSync(process.execPath, [CLI, 'kembaran', ...args], { cwd: dir, encoding: 'utf8' });
}

test('kembaran: NIK bertitik di file tunggal diganti, bukan disalin sambil dilaporkan aman', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lokal-kembaran-'));
  try {
    // An SQL dump on its own, the NIKs dotted and with mixed separators, no column name the detector reads.
    const sql = NIKS.map((n, i) => `INSERT INTO kyc VALUES (${i}, '${i === 2 ? n.replace(/(\d{4})(\d{4})(\d{4})(\d{4})/, '$1-$2.$3 $4') : dotted(n)}');`).join('\n');
    writeFileSync(path.join(dir, 'kyc.sql'), `${sql}\n`);
    const res = kembaran(dir, 'kyc.sql', '-o', 'kyc.anon.sql', '--secret', 's');
    assert.equal(res.status, 0, res.stderr);
    const out = readFileSync(path.join(dir, 'kyc.anon.sql'), 'utf8');
    const left = [...out.matchAll(/\d(?:[ .-]?\d){15}/g)].map((m) => m[0].replace(/\D/g, ''));
    for (const n of NIKS) assert.ok(!left.includes(n), `${n} left in the output`);
    assert.equal(left.length, 3, 'three stand-in NIKs');
    assert.doesNotMatch(res.stderr, /nothing found/);
    assert.match(res.stderr, /NIK=3|valid NIKs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kembaran: file tanpa data yang dikenali dilaporkan apa adanya, tanpa nada aman', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lokal-kembaran-'));
  try {
    writeFileSync(path.join(dir, 'catatan.txt'), 'rapat jam 3, bawa laptop\n');
    const res = kembaran(dir, 'catatan.txt', '-o', 'catatan.anon.txt');
    assert.match(res.stderr, /nothing replaced: Kembaran recognized no personal data, which does not mean there is none/);
    assert.match(res.stderr, /Do not treat them as anonymized without looking/);
    assert.match(res.stderr, /Look through the output before sharing it, and only then/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kembaran: file Latin-1 ditulis kembali dalam Latin-1, BOM UTF-8 tetap ada', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lokal-kembaran-'));
  try {
    // "São Paulo" with ã as the single byte 0xE3: not UTF-8.
    writeFileSync(path.join(dir, 'lama.csv'), Buffer.from(`nama,nik,kota\nBudi Santoso,${NIKS[2]},S\xe3o Paulo\n`, 'latin1'));
    writeFileSync(path.join(dir, 'bom.csv'), `﻿nama,nik\r\nSiti Aminah,${NIKS[1]}\r\n`);
    const r = kembaran(dir, 'lama.csv', 'bom.csv', '-o', 'out', '--secret', 'uji');
    assert.equal(r.status, 0, r.stderr);
    const latin = readFileSync(path.join(dir, 'out', 'lama.csv'));
    assert.ok(latin.includes(0xe3) && !latin.includes(Buffer.from('ã', 'utf8')), 'still Latin-1');
    assert.ok(!latin.toString('latin1').includes('Budi Santoso') && !latin.toString('latin1').includes(NIKS[2]!));
    assert.match(latin.toString('latin1'), /,S\xe3o Paulo\n$/);
    const bom = readFileSync(path.join(dir, 'out', 'bom.csv'));
    assert.deepEqual([...bom.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.ok(bom.includes(13), 'CRLF kept');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
