# API List Catalog (SQLite)

Endpoint ini membaca struktur folder & file dari database SQLite (`storage_catalog.db`)
yang sudah di-sync dari B2 oleh script `utils/sync-b2-to-db.js`.

## Endpoint

- **Method**: `GET`
- **URL**: `/catalog/list`

## Query Parameters

- `prefix` (opsional, string)
  - Path folder saat ini.
  - Contoh:
    - `prefix=` (kosong) → root.
    - `prefix=Kira` → folder `Kira/`.
    - `prefix=Kira/Anime` → folder `Kira/Anime/`.

- `type` (opsional, string)
  - Nilai yang didukung:
    - `"all"` (default) → kembalikan folder + file.
    - `"folder"` → hanya folder.
    - `"file"` → hanya file.

- `page` (opsional, number)
  - Default: `1`.
  - Dipakai bersama `pageSize` untuk pagination berbasis `LIMIT/OFFSET`.

- `pageSize` (opsional, number)
  - Default: `50`.
  - Minimal: `1`, maksimal: `500`.

## Response

```json
{
  "folders": [
    {
      "id": 1,
      "name": "Kira",
      "prefix": "Kira/",
      "parent_id": null,
      "file_count": 5000,
      "created_at": "2025-12-16T15:00:00.000Z",
      "updated_at": "2025-12-16T15:00:00.000Z"
    }
  ],
  "files": [
    {
      "id": 10,
      "folder_id": 1,
      "file_name": "ep01-720.mp4",
      "file_path": "Kira/ep01-720.mp4",
      "size": 1234567,
      "content_type": "video/mp4",
      "uploaded_at": "2025-12-15T10:00:00.000Z"
    }
  ],
  "page": 1,
  "pageSize": 50,
  "hasMore": true
}
```

## Alur Penggunaan

1. **Sync awal dari B2 ke SQLite**

   Jalankan script:

   ```bash
   deno run \
     --env-file=.env \
     --allow-env \
     --allow-read \
     --allow-write \
     --allow-net \
     utils/sync-b2-to-db.js
   ```

   Script ini akan:

   - Scan semua file di B2 via `listFiles()`.
   - Mengisi tabel `folders` dan `files` di `storage_catalog.db`.

2. **List di root**

   ```bash
   GET /catalog/list?page=1&pageSize=50
   ```

   - `folders` → daftar folder root (prefix `.../` dengan `parent_id = null`).
   - `files` → file yang berada langsung di root (jika ada).

3. **Masuk ke folder tertentu (misal `Kira`)**

   ```bash
   GET /catalog/list?prefix=Kira&page=1&pageSize=50
   ```

   - `folders` → subfolder di dalam `Kira/`.
   - `files` → file langsung di dalam `Kira/`.

4. **Filter hanya folder atau hanya file**

   - Hanya folder:

     ```bash
     GET /catalog/list?prefix=Kira&type=folder&page=1&pageSize=50
     ```

   - Hanya file:

     ```bash
     GET /catalog/list?prefix=Kira&type=file&page=1&pageSize=50
     ```

5. **Streaming file dari hasil catalog**

   - Ambil `file_path` dari item `files[]`.
   - Gunakan sebagai `fileName` untuk endpoint `/b2/stream` (yang menghasilkan signed URL ke B2).

Dengan pendekatan ini, UI file manager bisa:

- Navigasi folder & file sepenuhnya dari SQLite (cepat, tidak hit B2 untuk listing).
- Hanya menggunakan B2 untuk operasi actual data (streaming / download) melalui `/b2/stream`.
