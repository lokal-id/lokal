// Gaps an independent evaluation of 0.16.1 found, each with its look-alikes that must stay clean. Written in this
// repository's own words: the evaluation's cases are not copied here. Every person and number is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Samaran, detectPii } from '../src/index.ts';

const found = (text: string) => detectPii(text).map((m) => `${m.type}:${m.value}`);

test('NIK dan KK bertitik tertangkap tanpa label titik dua; nominal dan versi bertitik tidak', () => {
  assert.deepEqual(found('pemohon (NIK 3175.0912.0390.0002) sudah datang'), ['NIK:3175.0912.0390.0002']);
  assert.deepEqual(found('No. KTP 3175.0912.0390.0002'), ['NIK:3175.0912.0390.0002']);
  assert.deepEqual(found('tolong cek 3175.0912.0390.0002 ya'), ['NIK:3175.0912.0390.0002']);
  assert.deepEqual(found('KK 32.01.01.150895.0001'), ['KK:32.01.01.150895.0001']);
  assert.deepEqual(found('ktp 320101.150895.0001'), ['NIK:320101.150895.0001']);
  for (const clean of ['transfer Rp 12.500.000.000 ke kas', 'build 2026.10.31.1200 rilis', 'versi 1.2.3.4', 'populasi 1.250.000.000.000 bintang']) {
    assert.deepEqual(found(clean), [], clean);
  }
});

test('alamat perumahan tanpa "Jl." dan kunci pengiriman', () => {
  assert.deepEqual(found('{"ship_to": "Komp. Griya Kenanga 6"}'), ['ADDRESS:Komp. Griya Kenanga 6']);
  assert.deepEqual(found('{"alamat_kirim": "Taman Sari Indah C3"}'), ['ADDRESS:Taman Sari Indah C3']);
  assert.deepEqual(found('kirim ke Komp. Griya Kenanga 6 ya kak'), ['ADDRESS:Komp. Griya Kenanga 6']);
  assert.deepEqual(found('Kenanga Residence Blok C2 No. 5, Bekasi'), ['ADDRESS:Blok C2 No. 5']);
  for (const clean of ['Perum Bulog 2 gudang penuh', 'komplek 3 orang', 'cluster 2 unit tersisa', 'perumahan 45 rumah', 'blok A dan blok B rapat jam 2']) {
    assert.deepEqual(found(clean), [], clean);
  }
});

test('kolom nama di CSV tanpa header bermakna, termasuk nama yang tidak ada di daftar', () => {
  const csv = 'c1,c2,c3\nBudi Santoso,Bogor,120000\nKaleandra Wirasena,Depok,50000\nSiti Aminah,Bekasi,75000\nYohanes Tumbelaka,Bandung,9000\n';
  assert.deepEqual(
    detectPii(csv).filter((m) => m.type === 'NAME').map((m) => m.value),
    ['Budi Santoso', 'Kaleandra Wirasena', 'Siti Aminah', 'Yohanes Tumbelaka'],
  );
  for (const m of detectPii(csv)) assert.equal(csv.slice(m.start, m.end), m.value);
  // With CRLF too: offsets stay right.
  const crlf = csv.replace(/\n/g, '\r\n');
  for (const m of detectPii(crlf)) assert.equal(crlf.slice(m.start, m.end), m.value);
  // Products and cities are not people.
  assert.deepEqual(found('c1,c2\nIndomie Goreng,3500\nAqua Botol,4000\nTeh Pucuk,3000\nKopi Kapal Api,2000\n'), []);
  assert.deepEqual(found('a;b\nBogor;1\nDepok;2\nBekasi;3\nTangerang;4\n'), []);
});

test('ID teknis di log pembayaran bukan rekening, durasi bukan nomor HP', () => {
  for (const clean of [
    '2026-10-31 10:00:01 INFO payment-svc transfer trace_id=7340958123094857',
    'INFO bca-callback trace_id=7340958123094857 status=OK',
    '[va-service] traceId=7340958123094857',
    'tf berhasil, ref 7340958123094857',
    'id transaksi 7340958123094857 via BCA',
    'waktu proses 0812345678 ms',
    'duration=0856123456',
  ]) {
    assert.deepEqual(found(clean), [], clean);
  }
  assert.deepEqual(found('transfer ke rek 7340958123094857'), ['BANK_ACCOUNT:7340958123094857']);
  assert.deepEqual(found('no rek BCA 7340958123094857'), ['BANK_ACCOUNT:7340958123094857']);
  assert.deepEqual(found('hp 0812345678 ms dulu'), ['PHONE:0812345678']);
  assert.deepEqual(found('durasi telp: 0812-3456-7890'), ['PHONE:0812-3456-7890']);
});

test('nama yang juga ditulis huruf kecil dipulihkan sesuai huruf di sekitarnya', () => {
  const s = new Samaran();
  s.mask('nama: Paijo');
  const { text } = s.mask('aku paijo yg td chat');
  assert.equal(text, 'aku [NAME_1] yg td chat', 'one person, one placeholder');
  assert.equal(s.unmask(text), 'aku paijo yg td chat');
  assert.equal(s.unmask('Halo [NAME_1], pesanan dikirim'), 'Halo Paijo, pesanan dikirim');
  assert.equal(s.unmask('[NAME_1]'), 'Paijo');
  const only = new Samaran();
  only.mask('nama: paijo');
  assert.equal(only.unmask('Halo [NAME_1]'), 'Halo paijo', 'a name only ever written in lower case stays so');
});

test('putaran 2: nama bergaris bawah, bin/binti, inisial di depan, dan nama huruf besar yang berhenti di kata kerja', () => {
  assert.deepEqual(found('{"role":"user","name":"Budi_Santoso","content":"halo"}'), ['NAME:Budi_Santoso']);
  assert.deepEqual(found('name: build_and_test'), []);
  assert.deepEqual(found('Kemudian Fatimah binti Abdullah datang'), ['NAME:Fatimah binti Abdullah']);
  assert.deepEqual(found('AHMAD BIN HASAN'), ['NAME:AHMAD BIN HASAN']);
  assert.deepEqual(found('yang hadir R. Ayu Kusumawardhani dan Budi'), ['NAME:R. Ayu Kusumawardhani', 'NAME:Budi']);
  assert.deepEqual(found('Saksi melihat SUPRIYADI ALIAS UDIN TELAH MENGAMBIL motor'), ['NAME:SUPRIYADI ALIAS UDIN']);
  for (const clean of ['Pasal 5 ayat 2 UU No. 27', 'J. P. Morgan Chase', 'sesuai P.T. Bank Mandiri', 'IMEI: 356938035643809']) {
    assert.deepEqual(found(clean), [], clean);
  }
  assert.deepEqual(found('nama: Siti Menik'), ['NAME:Siti Menik'], 'men- is not cut: Menik, Mentari are names');
  assert.deepEqual(found('kirim ke Kp. Rawa Bebek RT 04/09, Bekasi'), ['ADDRESS:Kp. Rawa Bebek RT 04/09']);
});

test('Kembaran: NIK yang tidak dikenali detektor tetap diganti lewat strukturnya, dan panggilan ikut nama lengkap', async () => {
  const { Kembaran } = await import('../src/kembaran.ts');
  const sql = "INSERT INTO t VALUES ('3276/01/0101/800001', 'x');\nINSERT INTO t VALUES ('32760101.01800002', 'y');";
  assert.deepEqual(detectPii(sql), [], 'the detector misses both');
  const r = new Kembaran({ secret: 's' }).texts([sql]);
  assert.ok(!r.files[0]!.text.replace(/\D/g, '').includes('3276010101800001'));
  assert.ok(!r.files[0]!.text.replace(/\D/g, '').includes('3276010101800002'));
  assert.deepEqual(r.files[0]!.crossed, { NIK: 2 });
  const csv = 'nama,catatan\nSiti Aminah,Bu Siti minta dikirim pagi\nBudi Santoso,Pak Budi sudah bayar\nBudi Hartono,-\n';
  const [row1, row2] = new Kembaran({ secret: 's' }).texts([csv]).files[0]!.text.split('\n').slice(1);
  assert.equal(row1!.split(',')[1], `Bu ${row1!.split(' ')[0]} minta dikirim pagi`, 'Bu Siti follows Siti Aminah');
  assert.notEqual(row2!.split(',')[1], `Pak ${row2!.split(' ')[0]} sudah bayar`, 'two Budis: no guess');
});

test('audit: data yang disamarkan dengan Unicode, entity, ejaan, atau encoding tetap terdeteksi di posisi aslinya', () => {
  const NIK = '3201011508950001';
  const wide = (s: string) => [...s].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join('');
  const cases: Array<[string, string]> = [
    [`NIK ${wide(NIK)}`, 'NIK'],
    [`NIK ${[...NIK].join('​')}`, 'NIK'],
    [`NIK ${[...NIK].join('­')}`, 'NIK'],
    ['NIK 3201 0115 0895 0001', 'NIK'],
    [`NIK ${[...NIK].map((c) => String.fromCharCode(0x0660 + Number(c))).join('')}`, 'NIK'],
    [`NIK ${[...NIK].map((c) => `&#${c.charCodeAt(0)};`).join('')}`, 'NIK'],
    ['NIK 32010115\n08950001', 'NIK'],
    ['NIK tiga dua nol satu nol satu satu lima nol delapan sembilan lima nol nol nol satu', 'NIK'],
    [`HP ${wide('081234567890')}`, 'PHONE'],
    ['hp 0812 3456 78 lapan sembilan nol', 'PHONE'],
    ['hp +62 (0)812-3456-7890', 'PHONE'],
    ['siti.rahayu88＠gmail.com', 'EMAIL'],
    ['siti . rahayu88 @ gmail . com', 'EMAIL'],
    ['siti.rahayu88&#64;gmail.com', 'EMAIL'],
    [`data: ${btoa(`NIK ${NIK}`)}`, 'NIK'],
    ['From: =?UTF-8?B?QnVkaSBTYW50b3Nv?= <x@contoh.test>', 'NAME'],
  ];
  for (const [text, type] of cases) {
    const found = detectPii(text);
    assert.ok(found.some((m) => m.type === type), `${JSON.stringify(text)}: ${JSON.stringify(found)}`);
    for (const m of found) assert.equal(text.slice(m.start, m.end), m.value, 'offsets on the original text');
  }
  // Look-alikes stay clean, and odd entities do not break detection.
  for (const clean of ['token eyJhbGciOiJIUzI1NiJ9 ok', 'jam 1 2 3 4 5 lalu', 'Senin satu dua tiga empat lima', '&#9999999; dan &#xFFFFFF;', 'harga Rp 1.250.000']) {
    assert.deepEqual(detectPii(clean), [], clean);
  }
});

test('audit: rupiah negatif dan rusak, rentang, awalan 0062, hari kerja dari Date di WIB', async () => {
  const { parseRupiah, parsePhone, isWorkingDay, countWorkingDays } = await import('../src/index.ts');
  for (const [text, amount] of [['Rp -1.000', -1000], ['-Rp 1.000', -1000], ['(Rp 1.000)', -1000], ['minus 2,5 juta', -2500000], ['Rp 1.500.000,50', 1500000.5]] as const) {
    assert.equal(parseRupiah(text)?.amount, amount, text);
  }
  for (const text of ['Rp 1.2.3', '1.50.000,5', '1-2 juta', '1 sampai 2 juta', '100rb - 200rb', 'Rp100rb–200rb', 'Rp 1jt s/d 2jt']) assert.equal(parseRupiah(text), null, text);
  assert.equal(parsePhone('0062 812 3456 7890').valid, true);
  assert.equal(parsePhone('0062 812 3456 7890').e164, '+6281234567890');
  // Monday 06:00 WIB is Monday 2 November, not Sunday 23:00 UTC.
  assert.equal(isWorkingDay(new Date('2026-11-02T06:00:00+07:00')), true);
  assert.equal(isWorkingDay(new Date('2026-11-01T23:30:00+07:00')), false);
  assert.equal(isWorkingDay(new Date('2026-08-18T05:00:00+09:00'), { timeZone: 'Asia/Jayapura' }), true);
  assert.equal(countWorkingDays('2026-12-31', '2026-01-01'), -countWorkingDays('2026-01-01', '2026-12-31'));
});

test('audit: false positive — email peran, ayat Alkitab, tempat bernama orang, nominal dan ID 16 digit', () => {
  for (const clean of [
    'noreply@github.com, support@tokopedia.com, info@toko-contoh.co.id',
    'Yohanes 3:16 dan Matius 5:9',
    'Gedung Sate dan RSUD Dr. Soetomo',
    'Universitas Prof. Dr. Moestopo',
    'Total aset Rp 3201011508950001',
    'order_id=3201011508950001',
  ]) {
    assert.deepEqual(found(clean), [], clean);
  }
  assert.deepEqual(found('budi.santoso@gmail.com'), ['EMAIL:budi.santoso@gmail.com']);
  assert.deepEqual(found('Matius tinggal di Bogor'), ['NAME:Matius'], 'a man named Matius');
  assert.deepEqual(found('dirawat Pak Budi Santoso'), ['NAME:Budi Santoso']);
  assert.deepEqual(found('NIK pemesan, order 3201011508950001'), ['NIK:3201011508950001'], 'a NIK label wins');
});

test('audit: obat dan disabilitas tanpa label, Acct dan IBAN, XML dan SQL, judul dokumen, nama berikutnya dalam daftar', () => {
  const cases: Array<[string, string[]]> = [
    ['Siti rutin minum Clozapine tiap malam', ['HEALTH:Clozapine']],
    ['pelamar atas nama Rina, disabilitas netra', ['NAME:Rina', 'HEALTH:disabilitas netra']],
    ['Acct: 1234567890 (BCA)', ['BANK_ACCOUNT:1234567890']],
    ['IBAN DE89370400440532013000', ['BANK_ACCOUNT:DE89370400440532013000']],
    ['<pelanggan><nama>Kaleandra Wirasena</nama></pelanggan>', ['NAME:Kaleandra Wirasena']],
    ["SELECT * FROM pelanggan WHERE nama LIKE '%Darmaji%'", ['NAME:Darmaji']],
    ['KTP Bonifasius Mote', ['NAME:Bonifasius Mote']],
    ['ktp_bonifasius_mote.jpg', ['NAME:bonifasius_mote']],
    ['Pelanggan Dewi Lestari dan Kaleandra Wirasena sudah bayar', ['NAME:Dewi Lestari', 'NAME:Kaleandra Wirasena']],
  ];
  for (const [text, want] of cases) assert.deepEqual(found(text), want, text);
  for (const clean of [
    'Artikel: gejala tifus dan cara mencegah gastritis',
    'fasilitas untuk penyandang disabilitas netra di stasiun',
    'IBAN DE00370400440532013000',
    'Guest: Mr. Robert Tanujaya, Room 1207',
    'Budi Santoso dan Kantor Pusat',
  ]) {
    assert.ok(!found(clean).some((m) => /HEALTH|BANK_ACCOUNT|NAME:(?:Room|Kantor)/.test(m)), `${clean}: ${found(clean)}`);
  }
});

test('jalan bernama kota tujuannya tetap utuh; kota sesudah koma yang dipakai', async () => {
  const { parseAlamat } = await import('../src/wilayah.ts');
  const a = parseAlamat('Jl. Raya Bogor KM 30, Depok');
  assert.equal(a.street, 'Jl. Raya Bogor KM 30');
  assert.equal(a.kabupatenKota?.name, 'Kota Depok');
  const b = parseAlamat('Jalan Lintas Sumatera KM 12, Lahat');
  assert.equal(b.street, 'Jalan Lintas Sumatera KM 12');
  assert.equal(b.kabupatenKota?.name, 'Kabupaten Lahat');
  // A city named right after the street, without "Raya" before it, still ends the street.
  assert.equal(parseAlamat('Jl. Melati 3 Bogor').street, 'Jl. Melati 3');
});

test('search_wilayah mengenal nama sehari-hari dan ejaan Sumatra', async () => {
  const { searchWilayah } = await import('../src/wilayah.ts');
  const first = (q: string) => searchWilayah(q, { limit: 1 })[0]?.name;
  assert.equal(first('DKI'), 'Daerah Khusus Ibukota Jakarta');
  assert.equal(first('Jogja'), 'Daerah Istimewa Yogyakarta');
  assert.equal(first('DIY'), 'Daerah Istimewa Yogyakarta');
  assert.equal(first('Jatim'), 'Jawa Timur');
  assert.equal(first('Jaksel'), 'Kota Administrasi Jakarta Selatan');
  assert.equal(first('Sumatra Utara'), 'Sumatera Utara');
  assert.equal(searchWilayah('sumatra', { level: 1 }).length, 3);
  assert.equal(first('Depok'), 'Kota Depok');
});

test('Kembaran: nama "Belakang, Depan" sama orangnya; e-mail mengikuti nama samarannya', async () => {
  const { Kembaran } = await import('../src/kembaran.ts');
  const csv = 'nama,email\n"Santoso, Budi",budi.santoso@gmail.com\nBudi Santoso,budi_santoso87@yahoo.co.id\nSiti Aminah,siti@mail.co.id\n';
  const { files } = new Kembaran({ secret: 'uji' }).texts([csv]);
  const [, flipped, plain, siti] = files[0]!.text.trim().split('\n');
  const name = plain!.split(',')[0]!;
  const [given, family] = name.split(' ');
  assert.equal(flipped!.split('",')[0], `"${family}, ${given}`, 'the same person, family name first');
  assert.match(given!, /^[A-Z][a-z]+$/);
  assert.ok(/^(?:Agus|Ahmad|Andi|Anton|Arif|Asep|Bagus|Bambang|Bayu|Benny|Budi|Cecep|Dadang|Dani|Daniel|Dedi|Dimas|Doni|Edi|Eko|Fajar|Farhan|Fikri|Galih|Gede|Gilang|Hadi|Hari|Hendra|Heru|Ilham|Imam|Indra|Irfan|Ivan|Iwan|Joko|Ketut|Kevin|Komang|Krisna|Lukman|Made|Michael|Muhammad|Nyoman|Paulus|Putu|Rahmat|Rangga|Reza|Ridwan|Rizki|Rudi|Satria|Sigit|Slamet|Steven|Surya|Taufik|Teguh|Togar|Tono|Ujang|Wahyu|Wawan|Yoga|Yohanes|Yudi|Yusuf|Zainal)$/.test(given!), `${given} is a man's name`);
  assert.equal(flipped!.split('",')[1], `${given!.toLowerCase()}.${family!.toLowerCase()}@example.com`);
  assert.match(plain!.split(',')[1]!, new RegExp(String.raw`^${given!.toLowerCase()}_${family!.toLowerCase()}\d{2}@example\.com$`));
  const sitiGiven = siti!.split(' ')[0]!.toLowerCase();
  assert.equal(siti!.split(',')[1], `${sitiGiven}@example.com`, 'a given name alone follows that one person');
  // A degree after the comma is not a given name; a role mailbox is not a person.
  const k = new Kembaran({ secret: 'uji' });
  assert.match(k.text('Nama: Budi Santoso, S.Kom').text, /^Nama: [A-Z][a-z]+ [A-Z][a-z]+, S\.Kom$/);
  assert.equal(k.text('Kontak: info@toko.co.id').text, 'Kontak: info@toko.co.id');
});
