# Data wilayah

`wilayah.json` (provinsi, kabupaten/kota, kecamatan) and `desa.json` (kelurahan/desa) are generated from
[cahyadsn/wilayah](https://github.com/cahyadsn/wilayah) `db/wilayah.sql`, which follows
Kepmendagri No 300.2.2-2138 Tahun 2025 (as amended by 300.2.2-2430 Tahun 2025, which only reassigns four islands). The
totals match the decree exactly: 38 provinsi, 416 kabupaten, 98 kota, 7,285 kecamatan, 8,496 kelurahan, 75,266 desa.
That data is MIT-licensed; see `LICENSE-wilayah.txt`.

After a new Kepmendagri decree, download the inputs from specific upstream commits.
Record both commit IDs, the decree number, the snapshot date, and the input SHA-256 values
reported by the generator in the data-update PR.

```sh
curl --fail --location -o wilayah.sql "https://raw.githubusercontent.com/cahyadsn/wilayah/<commit>/db/wilayah.sql"
curl --fail --location -o wilayah_kodepos.sql "https://raw.githubusercontent.com/cahyadsn/wilayah_kodepos/<commit>/db/wilayah_kodepos.sql"
npm run data:wilayah -w @lokal-id/core -- /path/to/wilayah.sql /path/to/wilayah_kodepos.sql
python python/scripts/sync_data.py
```

The generator checks the hierarchy, rejects duplicate codes, and requires one valid
postal-code mapping for each desa/kelurahan. If the postal SQL is omitted, the existing
`kodepos.json` must cover the new snapshot exactly. If the two sources describe different
decrees, reconcile the mapping before regenerating. Compare the printed level counts with
the new decree before committing the generated data.
