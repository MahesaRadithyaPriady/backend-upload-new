# API List Folder (B2)

Endpoint ini khusus untuk mengambil **daftar folder level pertama** (segmen pertama path) secara lebih efisien,
agar folder lain tidak "terkubur" di belakang prefix yang berisi sangat banyak file.

Contoh kasus:

- `Kira/` berisi ~7000 file
- `Xyan/` berisi ~1000 file

Jika memakai `/b2/list` biasa di root, halaman-halaman awal akan penuh dengan file di dalam `Kira/`,
sehingga `Xyan` baru muncul setelah banyak kali `nextPageToken`.

Endpoint `/b2/folders` menyelesaikan ini dengan cara:

- Backend melakukan beberapa kali panggilan `listFileNames` ke B2 dengan `maxFileCount` besar (1000).
- Hanya mengambil **segmen pertama** setelah `prefix` sebagai folder.
- Berhenti ketika sudah mengumpulkan cukup banyak folder unik (`pageSize`) atau tidak ada data lagi.

## Endpoint

- **Method**: `GET`
- **URL**: `/b2/folders`

Selain itu, tersedia endpoint tambahan untuk **mendaftarkan folder di katalog (database)** tanpa
menyentuh B2 sama sekali:

- **Method**: `POST`
- **URL**: `/b2/folder`

## Query Parameters (GET /b2/folders)

- `prefix` (opsional, string)
  - Sama seperti di `/b2/list`.
  - Digunakan sebagai **base path** untuk mencari folder.
  - Contoh:
    - `prefix=` (kosong) → folder top-level (`Kira`, `Xyan`, dll.).
    - `prefix=Kira` → folder level berikutnya di dalam `Kira/`.

- `pageToken` (opsional, string)
  - Token untuk pagination.
  - Diisi dengan `nextPageToken` dari response sebelumnya.
  - Backend meneruskan nilai ini sebagai `startFileName` ke Backblaze B2.

- `pageSize` (opsional, number)
  - Default: `50`.
  - Minimal: `1`, maksimal: `200`.
  - Menentukan **jumlah folder unik** yang akan dikembalikan dalam satu halaman.

## Body (POST /b2/folder)

```json
{
  "prefix": "Kira/Anime"
}
```

- `prefix` (string, wajib)
  - Prefix folder yang ingin dipastikan ada di katalog.
  - Boleh berisi atau tidak berisi `/` di awal/akhir; backend akan menormalisasi menjadi
    bentuk tanpa slash di awal/akhir, lalu menambahkan `/` di akhir untuk disimpan sebagai
    `prefix` di tabel `folders`.
  - Contoh:
    - `"Kira"` → disimpan sebagai `"Kira/"`
    - `"Kira/Anime"` → disimpan sebagai `"Kira/Anime/"`

Jika `prefix` kosong atau hanya berisi spasi, server mengembalikan **400**:

```json
{
  "error": "Missing prefix"
}
```

## Response (GET /b2/folders)

```json
{
  "folders": [
    {
      "id": "Kira",
      "name": "Kira",
      "mimeType": "application/vnd.google-apps.folder"
    },
    {
      "id": "Xyan",
      "name": "Xyan",
      "mimeType": "application/vnd.google-apps.folder"
    }
  ],
  "nextPageToken": "Kira/Anime/SomeVeryLateFile.mp4" // string atau null
}
```

### Response (POST /b2/folder)

```json
{
  "folder": {
    "id": 123,
    "name": "Anime",
    "prefix": "Kira/Anime/"
  }
}
```

Jika folder dengan prefix tersebut sudah ada di katalog, endpoint ini **tidak** membuat baris
baru, tetapi hanya mengembalikan baris terakhir (folder terdalam) setelah memastikan seluruh
hirarki prefix tersedia. Jika terjadi error internal, server akan mengembalikan **500** dengan
payload:

```json
{
  "error": "Failed to create folder in catalog",
  "details": "<pesan error>"
}
```

### Catatan

- `id` sama seperti di `/b2/list` untuk folder:
  - Jika `prefix` kosong → `id` adalah nama segmen pertama, misalnya `Kira`.
  - Jika `prefix=Kira` → `id` bisa menjadi `Kira/Anime`, `Kira/Movies`, dst.
- `mimeType` folder mengikuti konvensi yang sama dengan API lama: `application/vnd.google-apps.folder`.

## Contoh Penggunaan (GET /b2/folders)

```bash
GET /b2/folders?pageSize=50
```

### 2. Ambil daftar folder di dalam `Kira`

```bash
GET /b2/folders?prefix=Kira&pageSize=50
```

### 3. Pagination

1. Request pertama:

```bash
GET /b2/folders?pageSize=50
```

Response (potongan):

```json
{
  "folders": [
    // ... 50 folder pertama ...
  ],
  "nextPageToken": "Kira/Anime/SomeVeryLateFile.mp4"
}
```

2. Request berikutnya:

```bash
GET /b2/folders?pageSize=50&pageToken=Kira/Anime/SomeVeryLateFile.mp4
```

Backend akan melanjutkan scanning dari `startFileName` tersebut sampai menemukan
folder-folder berikutnya.

## Integrasi dengan `/b2/list`, `/b2/folder`, `/b2/file`, dan `/b2/rename`

- Gunakan `/b2/folders` untuk **navigasi struktur folder** (root dan subfolder).
- Ketika user memilih satu folder, gunakan `/b2/list?prefix=<folderId>` untuk mengambil isi
  folder tersebut (folder + file) secara rinci.
- Gunakan `/b2/folder` (POST) ketika ingin **mendaftarkan folder di katalog terlebih dahulu**
  meskipun belum ada file di B2 dengan prefix tersebut. Ini berguna jika UI ingin menyiapkan
  struktur folder kosong lebih dulu, lalu meng-upload file ke dalamnya nanti dengan `prefix`
  yang sama.
- Gunakan `DELETE /b2/file?id=<encodedId>` untuk **hard delete**:
  - Jika `id` persis sama dengan satu `file_path` di B2, backend akan menghapus **satu file itu**
    dari B2 dan dari katalog.
  - Jika tidak ada file persis dengan nama tersebut, backend akan menganggap `id` sebagai
    **prefix/folder**, lalu menghapus **semua file di bawah prefix itu** dari B2 dan dari katalog
    (SQLite). Operasi ini bisa sangat mahal jika isi folder sangat banyak.
- Gunakan `POST /b2/rename` untuk **rename satu file saja**:
  - Body minimal: `{ "oldPath": "Kira/Anime/ep1.mp4", "newName": "ep01.mp4" }`.
  - Backend akan melakukan copy+delete di B2 (rename via copy ke nama baru, lalu hapus nama lama),
    lalu mengupdate satu baris file terkait di tabel `files` (field `file_path` dan `file_name`).
  - Endpoint ini **tidak** melakukan rename prefix/folder massal. Jika dibutuhkan nanti, akan
    disediakan endpoint/parameter terpisah.

Dengan kombinasi ini:

- `/b2/folders` + `/b2/list` dipakai untuk baca/navigasi.
- `/b2/folder` dipakai untuk menyiapkan struktur folder di katalog.
- `/b2/file` (DELETE) dan `/b2/rename` dipakai untuk operasi mutasi (hapus/rename) yang tetap
  konsisten antara B2 dan database lokal.

Frontend tidak perlu memanggil `/b2/list` berkali-kali hanya untuk keluar dari satu prefix besar
 (seperti `Kira/`), dan UX penjelajahan folder menjadi jauh lebih efisien.
