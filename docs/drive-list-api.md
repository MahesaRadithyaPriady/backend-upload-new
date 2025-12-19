# API List File (Backblaze B2)

Dokumen ini menjelaskan cara mengambil list file/folder dari backend yang sudah dimigrasi ke Backblaze B2.

## Endpoint

- **Method**: `GET`
- **URL**: `/drive/list`

## Query Parameters

- `folderId` (opsional, string)
  - Default: `"root"`
  - Diimplementasikan sebagai **prefix path** di dalam bucket B2.
  - Contoh:
    - `folderId=root` → list isi root bucket.
    - `folderId=anime` → list isi prefix `anime/`.
    - `folderId=anime/season1` → list isi prefix `anime/season1/`.

- `search` (opsional, string)
  - Filter hasil berdasarkan nama (case-insensitive).
  - Pencarian diterapkan **setelah** list dari B2 diambil.

- `pageToken` (opsional, string)
  - Token untuk pagination.
  - Backend meneruskan `nextPageToken` dari response sebelumnya, yang isinya adalah `nextFileName` dari B2.

- `pageSize` (opsional, number)
  - Default: `50`.
  - Digunakan untuk mengatur `maxFileCount` saat list dari B2 (dibatasi antara 1 s/d 1000).

- `order` (opsional, string)
  - Nilai yang didukung:
    - `"name_asc"` (default)
    - `"name_desc"`
  - Sorting dilakukan di sisi backend berdasarkan `name`.

- `type` (opsional, string)
  - Nilai yang didukung:
    - `"all"` (default) → folder + file.
    - `"folder"` → hanya folder.
    - `"file"` → hanya file.

## Bentuk Response

```json
{
  "files": [
    {
      "id": "anime/season1",          // untuk folder → path prefix tanpa trailing slash
      "name": "season1",
      "mimeType": "application/vnd.google-apps.folder"
    },
    {
      "id": "anime/season1/ep1.mp4",  // untuk file → full path (fileName) di B2
      "name": "ep1.mp4",
      "mimeType": "video/mp4",
      "size": 123456789,
      "modifiedTime": "2024-12-15T10:20:30.000Z"
    }
  ],
  "nextPageToken": "..." // string atau null
}
```

### Catatan Struktur Data

- **Folder**:
  - Tidak ada folder asli di B2, hanya path prefix.
  - Backend mensimulasikan folder dari path:
    - Setiap segmen pertama setelah `folderId` dianggap sebagai folder.
  - `mimeType` folder selalu: `"application/vnd.google-apps.folder"`.

- **File**:
  - `id` = `fileName` dari B2 (full path).
  - `name` = nama terakhir (basename) dari path.
  - `size` diambil dari `contentLength` B2.
  - `modifiedTime` diambil dari `uploadTimestamp` B2 dan dikonversi ke ISO string.

## Contoh Request

### List root

```bash
GET /drive/list
```

### List di dalam folder tertentu

```bash
GET /drive/list?folderId=anime/season1&pageSize=100
```

### List hanya file, dengan pencarian nama

```bash
GET /drive/list?folderId=anime&type=file&search=ep1
```

### Pagination

1. Request pertama:

```bash
GET /drive/list?folderId=anime/season1&pageSize=50
```

Response (dipotong):

```json
{
  "files": [
    // ... 50 item pertama ...
  ],
  "nextPageToken": "anime/season1/ep50.mp4"
}
```

2. Request berikutnya:

```bash
GET /drive/list?folderId=anime/season1&pageSize=50&pageToken=anime/season1/ep50.mp4
```

Backend akan meneruskan `pageToken` ini sebagai `startFileName` ke B2.

## Catatan Integrasi Frontend

- Untuk operasi lain (stream, delete, rename, move), gunakan field `id` dari item sebagai **path kunci**:
  - Stream: `GET /drive/stream/:id` atau `GET /drive/stream?id=<encodeURIComponent(id)>`.
  - Delete: `DELETE /drive/delete?id=<id>`.
  - Rename: `POST /drive/rename` dengan body `{ id, name }`.
  - Move: `POST /drive/move` dengan body `{ ids: [id1, id2, ...], destinationId }`.
- `folderId` dan `id` selalu diperlakukan sebagai path relatif di dalam bucket B2.
