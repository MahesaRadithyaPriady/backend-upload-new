# API Stream Drive via B2

Endpoint ini digunakan untuk melakukan streaming file Drive **melalui Backblaze B2** dengan mode **proxy**.
Artinya konten video dikirim dari backend ke client, dan backend yang mengambil data dari B2.

Tujuan: **signed URL B2 tidak terekspos** ke client.

Mapping berasal dari database `file_mapping.db` (tabel `drive_b2_mapping`).

## Endpoint

- **Method**: `GET`
- **URL**:
  - `/drive/stream-b2/:id`
  - `/drive/stream-b2?id=<driveFileId>` (alternatif via query)

Alias (internal/backward-compatible):

- **Method**: `GET`
- **URL**:
  - `/drive/stream-b2/media/:id`
  - `/drive/stream-b2/media?id=<driveFileId>` (alternatif via query)

`id` adalah **Drive File ID** (contoh: `1xqc8YWm0Gci30-WzVPhWSxOlmvWWGWPW`).

## Prasyarat

Sebelum endpoint ini bisa digunakan, mapping Drive -> B2 harus sudah ada:

- Jalankan katalog sync B2 -> DB (sekali / berkala):
  - `node utils/sync-b2-to-db.js`
- Jalankan mapping Drive -> B2:
  - `node utils/sync-drive-b2-mapping.js --driveRootId <driveFolderId>`

## Perilaku Response

Endpoint ini akan:

1. Lookup mapping di `file_mapping.db` (`drive_b2_mapping`) berdasarkan `driveFileId`.
2. Melakukan download stream dari B2 (server-side) dan meneruskan stream + header.

Endpoint ini mendukung header `Range` sehingga cocok untuk video (`<video>` seek/buffering).

### Status Code

- `200 OK`
  - Mengembalikan stream (full content).

- `206 Partial Content`
  - Mengembalikan stream partial jika client mengirim header `Range`.

- `404 Not Found`
  - Jika mapping `driveFileId -> b2ObjectKey` tidak ditemukan.

- `400 Bad Request`
  - Jika `id` tidak dikirim.

- `500 Internal Server Error`
  - Jika terjadi error saat mengambil mapping atau generate signed URL.

## Contoh Penggunaan

### 1. Streaming via path param

```bash
GET /drive/stream-b2/1xqc8YWm0Gci30-WzVPhWSxOlmvWWGWPW
```

### 2. Integrasi dengan `<video>` tag

```html
<video
  src="/drive/stream-b2/1xqc8YWm0Gci30-WzVPhWSxOlmvWWGWPW"
  controls
></video>
```

## Catatan

- Endpoint `/drive/stream/:id` **masih** streaming langsung dari Google Drive.
- Endpoint ini (`/drive/stream-b2/:id`) khusus untuk kasus ketika stream Drive sudah dialihkan ke B2.
- Pastikan env B2 sudah dikonfigurasi (`B2_APPLICATION_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET_NAME`/`B2_BUCKET_ID`).
