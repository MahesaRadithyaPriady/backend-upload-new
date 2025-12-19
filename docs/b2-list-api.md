# API List File (B2 Native)

Dokumen ini menjelaskan endpoint baru `/b2/list` yang mengambil data langsung dari Backblaze B2.

## Endpoint

- **Method**: `GET`
- **URL**: `/b2/list`

## Query Parameters

- `prefix` (opsional, string)
  - Prefix path di dalam bucket B2.
  - Contoh:
    - `prefix=` (kosong) → list semua file mulai dari awal bucket.
    - `prefix=anime` → list file dengan prefix `anime/`.
    - `prefix=anime/season1` → list file dengan prefix `anime/season1/`.

- `pageToken` (opsional, string)
  - Token untuk pagination.
  - Isi dari field `nextPageToken` pada response sebelumnya.
  - Diteruskan ke B2 sebagai `startFileName`.

- `pageSize` (opsional, number)
  - Default: `1000`.
  - Batas minimal: `1`.
  - Batas maksimal: `1000`.
  - Dipetakan ke `maxFileCount` pada B2.

- `type` (opsional, string)
  - Nilai yang didukung:
    - `"all"` (default) → kembalikan **folder + file** pada level prefix saat ini.
    - `"file"` → kembalikan **hanya file** langsung di bawah prefix (tanpa folder simulasi).
  - `type=file` berguna jika frontend sudah mendapatkan daftar folder dari `/b2/folders`,
    dan hanya ingin mengambil isi file di dalam satu folder tertentu.

## Bentuk Response

```json
{
  "files": [
    {
      "id": "Kira",
      "name": "Kira",
      "mimeType": "application/vnd.google-apps.folder"
    },
    {
      "id": "SomeFileInRoot.mp4",
      "name": "SomeFileInRoot.mp4",
      "mimeType": "video/mp4",
      "size": 123456,
      "modifiedTime": "2024-12-15T10:20:30.000Z"
    }
  ],
  "nextPageToken": "anime/season1/ep50.mp4"
}
```

Contoh lain, jika `prefix=Kira/Anime`:

```json
{
  "files": [
    {
      "id": "Kira/Anime/Akujiki Reijou to Kyouketsu Koushaku",
      "name": "Akujiki Reijou to Kyouketsu Koushaku",
      "mimeType": "application/vnd.google-apps.folder"
    },
    {
      "id": "Kira/Anime/Ao no Orchestra Season 2",
      "name": "Ao no Orchestra Season 2",
      "mimeType": "application/vnd.google-apps.folder"
    },
    {
      "id": "Kira/Anime/SomeFileLangsung.mp4",
      "name": "SomeFileLangsung.mp4",
      "mimeType": "video/mp4",
      "size": 123456,
      "modifiedTime": "2024-12-15T10:20:30.000Z"
    }
  ],
  "nextPageToken": null
}
```

### Penjelasan Field

- `files[]`
  - **Folder**
    - `id`
      - Path prefix folder (misal: `"Kira"`, `"Kira/Anime"`, `"Kira/Anime/Akujiki Reijou to Kyouketsu Koushaku"`).
    - `name`
      - Nama folder saja (segmen terakhir dari path).
    - `mimeType`
      - Selalu `"application/vnd.google-apps.folder"` untuk item folder.
    - Tidak ada `size` dan `modifiedTime` (karena B2 tidak menyimpan metadata folder).

  - **File**
    - `id`
      - Sama dengan `fileName` di B2 (path penuh), misal:
        - `"Kira/Anime/Akujiki Reijou to Kyouketsu Koushaku/Eps.6/ARKK-06-360p-SAMEHADAKU.CARE.mp4"`.
    - `name`
      - `basename` dari path (segmen terakhir setelah `/`).
    - `mimeType`
      - Diambil dari `contentType` di metadata B2.
      - Default `application/octet-stream` jika tidak tersedia.
    - `size`
      - Diambil dari `contentLength` B2 (dalam byte).
    - `modifiedTime`
      - Diambil dari `uploadTimestamp` B2 dan dikonversi ke ISO string.

- `nextPageToken`
  - Diisi dengan nilai `nextFileName` dari B2.
  - Jika `null`, berarti tidak ada halaman berikutnya.

> Catatan: Jika bucket kamu **sangat besar** dan terdapat sangat banyak file yang diawali dengan prefix tertentu (misalnya semua diawali `Kira/...`), maka halaman pertama (`pageSize=1000`) mungkin masih didominasi oleh folder itu saja. Untuk memastikan semua folder root ter-cover, client bisa melakukan beberapa kali request dengan `pageToken` (pagination) dan menggabungkan daftar folder di sisi frontend.

## Streaming File dari Hasil List

Setiap item file yang dikembalikan oleh `/b2/list` memiliki field `id` yang sama dengan `fileName` di B2.

Untuk melakukan streaming file tersebut, gunakan endpoint `/b2/stream`:

- **Param path**:

  ```bash
  GET /b2/stream/<encodedId>
  ```

- **Query string**:

  ```bash
  GET /b2/stream?id=<encodedId>
  ```

Di mana `encodedId = encodeURIComponent(id)` dari item file.

Detail lengkap penggunaan `/b2/stream` ada di dokumen `b2-stream-api.md`.

## Contoh Request

### List semua file (tanpa prefix)

```bash
GET /b2/list
```

### List file dalam prefix tertentu

```bash
GET /b2/list?prefix=anime/season1&pageSize=100
```

### Pagination

1. Request pertama:

```bash
GET /b2/list?prefix=anime/season1&pageSize=50
```

Response (dipotong):

```json
{
  "files": [
    // ... 50 file pertama ...
  ],
  "nextPageToken": "anime/season1/ep50.mp4"
}
```

2. Request berikutnya:

```bash
GET /b2/list?prefix=anime/season1&pageSize=50&pageToken=anime/season1/ep50.mp4
```

### List hanya file langsung di dalam folder (tanpa folder simulasi)

Misal frontend sudah menggunakan `/b2/folders` untuk navigasi struktur folder, dan ingin
menampilkan hanya file langsung di dalam `anime/season1`:

```bash
GET /b2/list?prefix=anime/season1&type=file&pageSize=50
```

Response hanya akan berisi item file (tanpa item folder) di level tersebut.

## Alur Navigasi Folder + File

Untuk UX yang efisien pada bucket besar dan struktur folder dalam, disarankan pola berikut:

1. **List folder root**

   - Panggil:

     ```bash
     GET /b2/folders?pageSize=50
     ```

   - Tampilkan hasil `folders[]` sebagai daftar folder root (`Kira`, `Xyan`, dll.).

2. **Masuk ke satu folder (misal `Kira`)**

   - Subfolder di dalam `Kira`:

     ```bash
     GET /b2/folders?prefix=Kira&pageSize=50
     ```

   - File langsung di dalam `Kira` (tanpa subfolder):

     ```bash
     GET /b2/list?prefix=Kira&type=file&pageSize=50
     ```

3. **Masuk ke subfolder lebih dalam (misal `Kira/Anime`)**

   - Subfolder di dalam `Kira/Anime`:

     ```bash
     GET /b2/folders?prefix=Kira/Anime&pageSize=50
     ```

   - File langsung di dalam `Kira/Anime`:

     ```bash
     GET /b2/list?prefix=Kira/Anime&type=file&pageSize=50
     ```

Dengan kombinasi ini:

- `/b2/folders` dipakai untuk **navigasi struktur folder** per level (root dan subfolder).
- `/b2/list?prefix=...&type=file` dipakai untuk mengambil **file langsung** di dalam folder
  yang sedang dibuka.

Hal ini menghindari masalah di mana bucket atau satu prefix besar (misalnya `Kira/` dengan
ribuan file) mendominasi seluruh hasil `list`, sehingga folder lain sulit muncul tanpa
pagination manual yang panjang.

## Konsep Folder Virtual di B2 (Prefix)

Backblaze B2 **tidak punya folder sungguhan** seperti filesystem. Yang ada hanyalah **fileName**
berbentuk string (misalnya `mahesa/video.mp4`). Folder yang tampil di API `/b2/list` dan
`/b2/folders` adalah **folder virtual** yang dibentuk dari **prefix** sebelum karakter `/`.

Beberapa poin penting:

- Tidak ada endpoint khusus "create folder" untuk B2.
- Folder akan **muncul otomatis** ketika ada file yang di-upload dengan `fileName` ber-prefix.
- Tabel `folders` di SQLite (`storage_catalog.db`) hanyalah **cermin (mirror)** dari prefix
  yang sudah ada di B2, dan diisi saat:
  - Upload file melalui `/b2/upload` (backend memanggil `ensureFolderHierarchy` dan `upsertFolder`).
  - Menjalankan script sinkronisasi `utils/sync-b2-to-db.js`.

### Contoh: prefix `mahesa` dan file `video.mp4`

Misal frontend meng-upload video dengan:

- Endpoint: `POST /b2/upload`
- Field form:
  - `file` = `video.mp4`
  - `prefix` = `mahesa`

Backend akan menyusun `fileName` di B2 menjadi:

```text
mahesa/video.mp4
```

Efeknya:

- Di B2: hanya ada satu file dengan `fileName = "mahesa/video.mp4"` (tanpa folder fisik).
- Di DB katalog:
  - Folder virtual dengan `prefix = "mahesa/"` akan dibuat (jika belum ada).
  - File dengan `file_path = "mahesa/video.mp4"` akan dicatat dan di-link ke folder tersebut.

Kemudian saat frontend memanggil:

```bash
GET /b2/folders
```

akan muncul item folder:

```json
{
  "id": "mahesa/",
  "name": "mahesa",
  "mimeType": "application/vnd.google-apps.folder"
}
```

Dan saat frontend memanggil:

```bash
GET /b2/list?prefix=mahesa&type=file&pageSize=50
```

response akan berisi file:

```json
{
  "files": [
    {
      "id": "mahesa/video.mp4",
      "name": "video.mp4",
      "mimeType": "video/mp4",
      "size": 123456,
      "modifiedTime": "2024-12-15T10:20:30.000Z"
    }
  ],
  "nextPageToken": null
}
```

Di UI, hal ini akan terlihat seolah-olah ada folder bernama **`mahesa`** yang berisi file
`video.mp4`, padahal di sisi B2 semuanya dibangun dari **prefix string** saja.
