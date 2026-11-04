"""Gaps an independent evaluation of 0.16.1 found, as in packages/core/test/gaps.test.ts. Every value is made up."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from lokal.samaran import Samaran, detect_pii


def found(text: str) -> list[str]:
    return [f'{m.type}:{m.value}' for m in detect_pii(text)]


@pytest.mark.parametrize(
    ('text', 'want'),
    [
        ('pemohon (NIK 3175.0912.0390.0002) sudah datang', ['NIK:3175.0912.0390.0002']),
        ('No. KTP 3175.0912.0390.0002', ['NIK:3175.0912.0390.0002']),
        ('tolong cek 3175.0912.0390.0002 ya', ['NIK:3175.0912.0390.0002']),
        ('KK 32.01.01.150895.0001', ['KK:32.01.01.150895.0001']),
        ('transfer Rp 12.500.000.000 ke kas', []),
        ('build 2026.10.31.1200 rilis', []),
        ('{"ship_to": "Komp. Griya Kenanga 6"}', ['ADDRESS:Komp. Griya Kenanga 6']),
        ('kirim ke Komp. Griya Kenanga 6 ya kak', ['ADDRESS:Komp. Griya Kenanga 6']),
        ('Kenanga Residence Blok C2 No. 5, Bekasi', ['ADDRESS:Blok C2 No. 5']),
        ('Perum Bulog 2 gudang penuh', []),
        ('perumahan 45 rumah', []),
        ('2026-10-31 10:00:01 INFO payment-svc transfer trace_id=7340958123094857', []),
        ('tf berhasil, ref 7340958123094857', []),
        ('waktu proses 0812345678 ms', []),
        ('duration=0856123456', []),
        ('transfer ke rek 7340958123094857', ['BANK_ACCOUNT:7340958123094857']),
        ('hp 0812345678 ms dulu', ['PHONE:0812345678']),
    ],
)
def test_found(text: str, want: list[str]) -> None:
    assert found(text) == want


def test_name_columns_without_a_meaningful_header() -> None:
    csv = 'c1,c2,c3\nBudi Santoso,Bogor,120000\nKaleandra Wirasena,Depok,50000\nSiti Aminah,Bekasi,75000\nYohanes Tumbelaka,Bandung,9000\n'
    for text in (csv, csv.replace('\n', '\r\n')):
        names = [m for m in detect_pii(text) if m.type == 'NAME']
        assert [m.value for m in names] == ['Budi Santoso', 'Kaleandra Wirasena', 'Siti Aminah', 'Yohanes Tumbelaka']
        assert all(text[m.start : m.end] == m.value for m in names)
    assert found('c1,c2\nIndomie Goreng,3500\nAqua Botol,4000\nTeh Pucuk,3000\nKopi Kapal Api,2000\n') == []


def test_lower_case_name_restored_in_the_case_around_it() -> None:
    s = Samaran()
    s.mask('nama: Paijo')
    text = s.mask('aku paijo yg td chat').text
    assert text == 'aku [NAME_1] yg td chat'
    assert s.unmask(text) == 'aku paijo yg td chat'
    assert s.unmask('Halo [NAME_1], pesanan dikirim') == 'Halo Paijo, pesanan dikirim'


@pytest.mark.parametrize(
    ('text', 'want'),
    [
        ('name: Budi_Santoso', ['NAME:Budi_Santoso']),
        ('name: build_and_test', []),
        ('Kemudian Fatimah binti Abdullah datang', ['NAME:Fatimah binti Abdullah']),
        ('yang hadir R. Ayu Kusumawardhani dan Budi', ['NAME:R. Ayu Kusumawardhani', 'NAME:Budi']),
        ('Saksi melihat SUPRIYADI ALIAS UDIN TELAH MENGAMBIL motor', ['NAME:SUPRIYADI ALIAS UDIN']),
        ('IMEI: 356938035643809', []),
        ('kirim ke Kp. Rawa Bebek RT 04/09, Bekasi', ['ADDRESS:Kp. Rawa Bebek RT 04/09']),
    ],
)
def test_round_two(text: str, want: list[str]) -> None:
    assert found(text) == want


def test_kembaran_replaces_a_nik_the_detector_misses() -> None:
    from lokal.kembaran import Kembaran

    sql = "INSERT INTO t VALUES ('3276/01/0101/800001', 'x');\nINSERT INTO t VALUES ('32760101.01800002', 'y');"
    assert detect_pii(sql) == []
    r = Kembaran(secret='s').texts([sql])
    digits = ''.join(c for c in r.files[0].text if c.isdigit())
    assert '3276010101800001' not in digits and '3276010101800002' not in digits
    assert r.files[0].crossed == {'NIK': 2}


def test_audit_hidden_and_encoded_data() -> None:
    nik = '3201011508950001'
    wide = ''.join(chr(ord(c) + 0xFEE0) for c in nik)
    cases = [
        (f'NIK {wide}', 'NIK'),
        ('NIK ' + '​'.join(nik), 'NIK'),
        ('NIK 3201 0115 0895 0001', 'NIK'),
        ('NIK ' + ''.join(f'&#{ord(c)};' for c in nik), 'NIK'),
        ('NIK 32010115\n08950001', 'NIK'),
        ('hp 0812 3456 78 lapan sembilan nol', 'PHONE'),
        ('hp +62 (0)812-3456-7890', 'PHONE'),
        ('siti . rahayu88 @ gmail . com', 'EMAIL'),
        ('From: =?UTF-8?B?QnVkaSBTYW50b3Nv?= <x@contoh.test>', 'NAME'),
    ]
    for text, kind in cases:
        found = detect_pii(text)
        assert any(m.type == kind for m in found), ascii(text)
        assert all(text[m.start : m.end] == m.value for m in found)
    for clean in ('token eyJhbGciOiJIUzI1NiJ9 ok', 'jam 1 2 3 4 5 lalu', '&#9999999; dan &#xFFFFFF;'):
        assert detect_pii(clean) == [], clean


def test_logging_filter_masks_extra_fields() -> None:
    import io
    import logging

    from lokal.samaran.logging import SamaranFilter

    out = io.StringIO()
    handler = logging.StreamHandler(out)
    handler.setFormatter(logging.Formatter('%(message)s %(pelanggan)s %(meta)s'))
    handler.addFilter(SamaranFilter())
    log = logging.getLogger('lokal.test.extra')
    log.addHandler(handler)
    log.setLevel(logging.INFO)
    log.info('login', extra={'pelanggan': 'NIK 3201011508950001', 'meta': {'hp': '081234567890', 'n': 1}})
    log.getChild('anak').info('NIK %s', '3276014501990002', extra={'pelanggan': '-', 'meta': '-'})
    text = out.getvalue()
    assert '3201011508950001' not in text and '081234567890' not in text and '3276014501990002' not in text, text


def test_audit_rupiah_phone_and_working_days() -> None:
    from lokal.holidays import count_working_days
    from lokal.phone import parse_phone
    from lokal.rupiah import parse_rupiah

    for text, amount in [('Rp -1.000', -1000), ('(Rp 1.000)', -1000), ('minus 2,5 juta', -2500000)]:
        parsed = parse_rupiah(text)
        assert parsed is not None and parsed.amount == amount, text
    for text in ('Rp 1.2.3', '1.50.000,5', '1-2 juta', '1 sampai 2 juta', '100rb - 200rb', 'Rp100rb–200rb', 'Rp 1jt s/d 2jt'):
        assert parse_rupiah(text) is None, text
    assert parse_phone('0062 812 3456 7890').e164 == '+6281234567890'
    assert count_working_days('2026-12-31', '2026-01-01') == -count_working_days('2026-01-01', '2026-12-31')


@pytest.mark.parametrize(
    'text',
    [
        'noreply@github.com, support@tokopedia.com, info@toko-contoh.co.id',
        'Yohanes 3:16 dan Matius 5:9',
        'Gedung Sate dan RSUD Dr. Soetomo',
        'Total aset Rp 3201011508950001',
        'order_id=3201011508950001',
    ],
)
def test_audit_false_positives(text: str) -> None:
    assert found(text) == []


@pytest.mark.parametrize(
    ('text', 'want'),
    [
        ('Siti rutin minum Clozapine tiap malam', ['HEALTH:Clozapine']),
        ('Acct: 1234567890 (BCA)', ['BANK_ACCOUNT:1234567890']),
        ('IBAN DE89370400440532013000', ['BANK_ACCOUNT:DE89370400440532013000']),
        ('<pelanggan><nama>Kaleandra Wirasena</nama></pelanggan>', ['NAME:Kaleandra Wirasena']),
        ("SELECT * FROM pelanggan WHERE nama LIKE '%Darmaji%'", ['NAME:Darmaji']),
        ('KTP Bonifasius Mote', ['NAME:Bonifasius Mote']),
        ('Pelanggan Dewi Lestari dan Kaleandra Wirasena sudah bayar', ['NAME:Dewi Lestari', 'NAME:Kaleandra Wirasena']),
    ],
)
def test_audit_round_three_gaps(text: str, want: list[str]) -> None:
    assert found(text) == want


def test_road_named_after_a_city_stays_whole() -> None:
    from lokal.wilayah import parse_alamat

    a = parse_alamat('Jl. Raya Bogor KM 30, Depok')
    assert a.street == 'Jl. Raya Bogor KM 30'
    assert a.kabupaten_kota is not None and a.kabupaten_kota.name == 'Kota Depok'
    b = parse_alamat('Jalan Lintas Sumatera KM 12, Lahat')
    assert b.street == 'Jalan Lintas Sumatera KM 12'
    assert b.kabupaten_kota is not None and b.kabupaten_kota.name == 'Kabupaten Lahat'
    assert parse_alamat('Jl. Melati 3 Bogor').street == 'Jl. Melati 3'


def test_search_wilayah_knows_everyday_names() -> None:
    from lokal.wilayah import search_wilayah

    def first(q: str) -> str:
        return search_wilayah(q, limit=1)[0].name

    assert first('DKI') == 'Daerah Khusus Ibukota Jakarta'
    assert first('Jogja') == 'Daerah Istimewa Yogyakarta'
    assert first('DIY') == 'Daerah Istimewa Yogyakarta'
    assert first('Jatim') == 'Jawa Timur'
    assert first('Jaksel') == 'Kota Administrasi Jakarta Selatan'
    assert first('Sumatra Utara') == 'Sumatera Utara'
    assert len(search_wilayah('sumatra', level=1)) == 3
    assert first('Depok') == 'Kota Depok'


def test_kembaran_family_name_first_and_email_from_stand_in() -> None:
    from lokal._kembaran_data import MALE_FIRST
    from lokal.kembaran import Kembaran

    csv = 'nama,email\n"Santoso, Budi",budi.santoso@gmail.com\nBudi Santoso,budi_santoso87@yahoo.co.id\nSiti Aminah,siti@mail.co.id\n'
    files = Kembaran(secret='uji').texts([csv]).files
    _, flipped, plain, siti = files[0].text.strip().split('\n')
    given, family = plain.split(',')[0].split(' ')
    assert flipped.split('",')[0] == f'"{family}, {given}', 'the same person, family name first'
    assert given in MALE_FIRST
    assert flipped.split('",')[1] == f'{given.lower()}.{family.lower()}@example.com'
    assert re.fullmatch(rf'{given.lower()}_{family.lower()}\d{{2}}@example\.com', plain.split(',')[1])
    assert siti.split(',')[1] == f'{siti.split(" ")[0].lower()}@example.com'
    k = Kembaran(secret='uji')
    assert re.fullmatch(r'Nama: [A-Z][a-z]+ [A-Z][a-z]+, S\.Kom', k.text('Nama: Budi Santoso, S.Kom').text)
    assert k.text('Kontak: info@toko.co.id').text == 'Kontak: info@toko.co.id'


def test_kembaran_cli_keeps_latin1_and_bom(tmp_path: Path) -> None:
    from lokal.kembaran import main

    (tmp_path / 'lama.csv').write_bytes('nama,nik,kota\nBudi Santoso,3201011508950003,S\xe3o Paulo\n'.encode('latin-1'))
    (tmp_path / 'bom.csv').write_bytes(b'\xef\xbb\xbfnama,nik\r\nSiti Aminah,3276014501990002\r\n')
    out = tmp_path / 'out'
    out.mkdir()
    assert main([str(tmp_path / 'lama.csv'), str(tmp_path / 'bom.csv'), '-o', str(out), '--secret', 'uji']) == 0
    latin = (out / 'lama.csv').read_bytes()
    assert b'\xe3' in latin and 'ã'.encode() not in latin
    assert b'Budi Santoso' not in latin and b'3201011508950003' not in latin
    assert latin.endswith(b',S\xe3o Paulo\n')
    bom = (out / 'bom.csv').read_bytes()
    assert bom.startswith(b'\xef\xbb\xbf') and b'\r\n' in bom


CSV16 = 'nama,nik,hp\r\nBudi Santoso,3201011508950001,081234567890\r\nSiti Aminah,3276014501990002,085711112222\r\n'


@pytest.mark.parametrize(
    ('name', 'data', 'encoding'),
    [
        ('le.csv', b'\xff\xfe' + CSV16.encode('utf-16-le'), 'utf16le'),
        ('be.csv', b'\xfe\xff' + CSV16.encode('utf-16-be'), 'utf16be'),
        ('nobom.log', CSV16.encode('utf-16-le'), 'utf16le'),
    ],
)
def test_utf16_files_are_text_and_scanned(tmp_path: Path, name: str, data: bytes, encoding: str) -> None:
    from lokal.files import load_document, scan_path

    (tmp_path / name).write_bytes(data)
    doc = load_document(tmp_path / name)
    assert doc.kind == 'text' and doc.encoding == encoding
    assert doc.parts[0].text.lstrip('﻿') == CSV16
    report = scan_path(tmp_path)
    assert report.totals.get('NIK') == 2


def test_utf16_binary_stays_binary(tmp_path: Path) -> None:
    from lokal.files import load_document

    (tmp_path / 'gambar.dat').write_bytes(bytes([0x89, 0x50, 0x4E, 0x47, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0]))
    assert load_document(tmp_path / 'gambar.dat').kind == 'skipped'


def test_kembaran_cli_keeps_utf16(tmp_path: Path) -> None:
    from lokal.kembaran import main

    (tmp_path / 'ps.csv').write_bytes(b'\xff\xfe' + CSV16.encode('utf-16-le'))
    (tmp_path / 'be.csv').write_bytes(b'\xfe\xff' + CSV16.encode('utf-16-be'))
    out = tmp_path / 'out'
    out.mkdir()
    assert main([str(tmp_path / 'ps.csv'), str(tmp_path / 'be.csv'), '-o', str(out), '--secret', 'uji']) == 0
    le = (out / 'ps.csv').read_bytes()
    assert le.startswith(b'\xff\xfe')
    text = le[2:].decode('utf-16-le')
    assert text.startswith('nama,nik,hp\r\n') and 'Budi Santoso' not in text and '3201011508950001' not in text
    be = (out / 'be.csv').read_bytes()
    assert be.startswith(b'\xfe\xff') and 'Budi Santoso' not in be[2:].decode('utf-16-be')


def test_scan_path_upload_folder_ignores_its_own_config(tmp_path: Path) -> None:
    from lokal.files import scan_path

    # An upload folder where someone also uploaded a .samaranignore and an allow list.
    (tmp_path / 'ktp.csv').write_text('nama,nik\nBudi Santoso,3201011508950001\n', encoding='utf-8')
    (tmp_path / 'catatan.txt').write_text('NIK 3276014501990002\n', encoding='utf-8')
    (tmp_path / '.samaranignore').write_text('*.csv\n', encoding='utf-8')
    (tmp_path / '.samaran.json').write_text('{"allow": ["3276014501990002"]}', encoding='utf-8')
    loose = scan_path(tmp_path)
    assert loose.files_ignored == 1 and not loose.totals.get('NIK')
    strict = scan_path(tmp_path, ignore_file=False, config=False)
    # Both files, and the allow list itself (it holds the NIK).
    assert strict.files_ignored == 0 and strict.totals.get('NIK') == 3
