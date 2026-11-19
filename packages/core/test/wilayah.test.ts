import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findByPostalCode,
  getWilayah,
  listWilayah,
  normalizeWilayahCode,
  postalCodesIn,
  searchWilayah,
  wilayahName,
} from '../src/wilayah.ts';

test('38 provinsi', () => {
  const provinces = listWilayah();
  assert.equal(provinces.length, 38);
  assert.ok(provinces.every((p) => p.type === 'provinsi'));
});

test('kode dengan atau tanpa titik', () => {
  assert.equal(normalizeWilayahCode('3276'), '32.76');
  assert.equal(normalizeWilayahCode('3276011001'), '32.76.01.1001');
  assert.equal(wilayahName('3276'), 'Kota Depok');
});

test('getWilayah memberi jenis dan jalur lengkap', () => {
  const depok = getWilayah('32.76');
  assert.equal(depok?.type, 'kota');
  assert.equal(depok?.path, 'Kota Depok, Jawa Barat');
  assert.equal(getWilayah('32.01')?.type, 'kabupaten');
  assert.equal(getWilayah('91.03.01')?.type, 'distrik'); // Sentani, Kabupaten Jayapura
  assert.equal(getWilayah('91.03.01.3007')?.type, 'desa_adat'); // Desa Adat Yoboi
  const desa = listWilayah('32.01.01')[0];
  assert.equal(desa?.level, 4);
  assert.ok(desa?.path.endsWith('Cibinong, Kabupaten Bogor, Jawa Barat'));
});

test('kode pos per kelurahan/desa', () => {
  const depok = listWilayah('32.76.01').find((w) => w.name === 'Depok');
  assert.equal(depok?.postalCode, '16431');
  assert.deepEqual(postalCodesIn('32.76.01'), ['16431', '16432', '16433', '16434', '16435', '16436']);
  assert.ok(findByPostalCode('16431').some((w) => w.code === depok?.code));
  assert.deepEqual(findByPostalCode('abc'), []);
  assert.equal(getWilayah('32.76')?.postalCode, undefined);
});

test('dropdown berjenjang', () => {
  const kabKota = listWilayah('32');
  assert.ok(kabKota.length >= 27);
  assert.ok(kabKota.every((w) => w.code.startsWith('32.') && w.level === 2));
});

test('pencarian toleran terhadap awalan "kab.", "kota", "kec."', () => {
  assert.equal(searchWilayah('depok')[0]?.name, 'Kota Depok');
  assert.equal(searchWilayah('Kab. Bogor')[0]?.code, '32.01');
  assert.equal(searchWilayah('jakarta selatan')[0]?.name, 'Kota Administrasi Jakarta Selatan');
  const kec = searchWilayah('kec. cibinong', { level: 3 });
  assert.equal(kec[0]?.name, 'Cibinong');
  assert.ok(searchWilayah('a', { within: '32', limit: 5 }).every((w) => w.code.startsWith('32')));
});

test('jumlah wilayah sama dengan rekap Kepmendagri 300.2.2-2138/2025', () => {
  const count: Record<string, number> = {};
  const walk = (parent?: string) => {
    for (const w of listWilayah(parent)) {
      // Desa adat (Kab. Jayapura) dan distrik/kampung Papua dihitung sebagai desa/kecamatan di rekap resmi.
      const type = { desa_adat: 'desa', distrik: 'kecamatan' }[w.type as string] ?? w.type;
      count[type] = (count[type] ?? 0) + 1;
      if (w.code.length < 13) walk(w.code);
    }
  };
  walk();
  assert.deepEqual(count, { provinsi: 38, kabupaten: 416, kota: 98, kecamatan: 7285, kelurahan: 8496, desa: 75266 });
});


test("wilayah generator validates both inputs before writing a snapshot", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "lokal-data-"));
  t.after(() => {
    // This fixture only contains generated data and copies of the input scripts.
    rmSync(root, { recursive: true, force: true });
  });
  for (const dir of ["scripts", "src", "data"]) mkdirSync(path.join(root, dir));
  const script = path.join(root, "scripts", "build-wilayah.ts");
  copyFileSync(new URL("../scripts/build-wilayah.ts", import.meta.url), script);

  const wilayah = path.join(root, "wilayah.sql");
  const postal = path.join(root, "kodepos.sql");
  const output = path.join(root, "data", "desa.json");
  const quote = String.fromCharCode(39);
  const entry = (code: string, value: string) => `(${quote}${code}${quote}, ${quote}${value}${quote})`;
  const codes = ["32", "32.76", "32.76.01", "32.76.01.1001"];
  const valid = codes.map((code) => entry(code, code)).join(", ");
  const postcodes = entry(codes[3]!, "16431");
  const build = (...args: string[]) => spawnSync(process.execPath, [script, wilayah, ...args], { encoding: "utf8" });
  writeFileSync(wilayah, valid);
  writeFileSync(postal, postcodes);
  const first = build(postal);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /wilayah.sql SHA-256=[0-9a-f]{64}/);
  const original = readFileSync(output, "utf8");
  assert.deepEqual(JSON.parse(original), { "32.76.01.1001": "32.76.01.1001" });

  writeFileSync(wilayah, valid + ", " + entry("32.76.01", "duplicate"));
  assert.match(build(postal).stderr, /Duplicate wilayah code/);
  writeFileSync(wilayah, valid.replaceAll("32.76.01.1001", "32.76.02.1001"));
  assert.match(build(postal).stderr, /Missing parent/);
  writeFileSync(wilayah, valid + ", " + entry("32.76.01.1002", "new village"));
  assert.match(build().stderr, /Missing kode pos/);
  assert.equal(readFileSync(output, "utf8"), original);
});
