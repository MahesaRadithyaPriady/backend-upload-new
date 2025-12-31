# B2 Upload API

Dokumen ini menjelaskan API upload video ke Backblaze B2 beserta alur umum dan contoh penggunaan untuk frontend.

---

## Endpoint

- **Method**: `GET`
- **Path**: `/b2/upload-url`

Mengembalikan `uploadUrl` dan `authorizationToken` dari Backblaze B2 agar frontend bisa upload langsung ke B2.

---

- **Method**: `POST`
- **Path**: `/b2/upload`
- **Content-Type**: `application/json`

Endpoint ini digunakan untuk **commit metadata file** setelah frontend berhasil upload langsung ke Backblaze B2. Backend akan mencatat metadata tersebut ke katalog lokal (SQLite).

---

- **Method**: `POST`
- **Path**: `/b2/upload-multipart`
- **Content-Type**: `multipart/form-data`

Endpoint ini adalah **fallback** untuk upload multipart (server menerima file lalu upload ke B2), dan tetap mencatat metadatanya di katalog lokal (SQLite).

Endpoint ini **hanya menerima file video**. File non-video (misalnya PDF, DOCX, ZIP) akan ditolak dengan status **400**.

---

## Request

## Opsi B (Disarankan untuk Browser): B2 S3-Compatible Presigned PUT

Jika upload langsung ke endpoint native B2 (`/b2api/v2/b2_upload_file`) terblokir CORS di browser, gunakan alur presigned URL via **B2 S3-Compatible API**.

### Persiapan (konfigurasi)

Backend membutuhkan environment variable berikut:

- `B2_S3_ENDPOINT`
  - Contoh: `https://s3.us-west-000.backblazeb2.com`
- `B2_S3_REGION`
  - Default: `us-east-1`
- `B2_S3_ACCESS_KEY_ID`
- `B2_S3_SECRET_ACCESS_KEY` (atau `B2_S3_SECRET_APPLICATION_KEY`)
- `B2_S3_BUCKET_NAME` (atau fallback ke `B2_BUCKET_NAME`)

Selain itu, di bucket (S3 rules), pastikan **CORS** mengizinkan origin frontend (mis. `http://localhost:5173`) untuk method `PUT`.

### 1) Minta presigned URL (FE -> BE)

`GET /b2/s3-presign?filePath=<path>&contentType=<mime>&expiresInSeconds=600`

Response:

```json
{
  "filePath": "courses/kelas-a/intro.mp4",
  "bucket": "<bucket>",
  "method": "PUT",
  "url": "https://...presigned...",
  "expiresInSeconds": 600
}
```

### 2) Upload ke presigned URL (FE -> B2 S3)

Frontend melakukan:

- Method: `PUT`
- URL: `url` dari response presign
- Body: file (binary)
- Header (minimal): `Content-Type` harus sama dengan yang digunakan saat presign

### 3) Commit metadata (FE -> BE)

Setelah upload sukses, lakukan commit ke backend:

`POST /b2/upload` dengan body JSON seperti bagian **Commit metadata (FE -> BE)** di bawah.

### 1) Ambil upload URL (FE -> BE)

`GET /b2/upload-url`

Response:

```json
{
  "uploadUrl": "https://pod-xxxx.backblaze.com/b2api/v2/b2_upload_file/...",
  "authorizationToken": "xxxx",
  "bucketId": "xxxx"
}
```

### 2) Upload file ke B2 (FE -> B2)

Frontend meng-upload file langsung ke Backblaze B2 menggunakan `uploadUrl` dan `authorizationToken`.

### 3) Commit metadata (FE -> BE)

`POST /b2/upload` (`application/json`)

Body (single file):

```json
{
  "filePath": "courses/kelas-a/intro.mp4",
  "size": 123456,
  "contentType": "video/mp4",
  "uploadedAt": "2025-12-17T05:00:00.000Z"
}
```

Body (multiple files):

```json
{
  "files": [
    {
      "filePath": "courses/kelas-a/intro.mp4",
      "size": 123456,
      "contentType": "video/mp4",
      "uploadedAt": "2025-12-17T05:00:00.000Z"
    }
  ]
}
```

Keterangan field:

- `filePath` (opsional jika pakai `prefix` + `fileName`)
  - Path lengkap object di B2.
- `prefix` + `fileName` (opsional)
  - Alternatif pembentukan `filePath`.
- `size` (opsional)
  - Ukuran file dalam byte.
- `contentType` (opsional)
  - MIME type file.
- `uploadedAt` (opsional)
  - ISO string.

---

## Response

### Sukses (200)

```json
{
  "files": [
    {
      "id": "courses/kelas-a/intro.mp4",
      "name": "intro.mp4",
      "mimeType": "video/mp4",
      "size": 123456,
      "modifiedTime": "2025-12-17T05:00:00.000Z"
    }
  ]
}
```

Keterangan:

- `id`: Path lengkap file di B2 (juga disimpan sebagai `file_path` di katalog lokal). Nilai ini bisa dipakai langsung untuk streaming melalui `/b2/stream/:id`.
- `name`: Nama file (basename tanpa folder), sama dengan nama asli file saat upload.
- `mimeType`: MIME type file (contoh: `video/mp4`).
- `size`: Ukuran file dalam byte.
- `modifiedTime`: Waktu upload (ISO string). Bisa `null` jika tidak tersedia.

### Error (contoh)

- Error commit (contoh):

  ```json
  {
    "error": "No files committed",
    "errors": [
      {
        "filePath": null,
        "fileName": null,
        "error": "Missing filePath or fileName"
      }
    ]
  }
  ```

- Error internal server:

  ```json
  {
    "error": "Failed to commit upload",
    "details": "<pesan error>"
  }
  ```


---

## Endpoint Fallback: Upload Multipart (Server -> B2)

Jika masih butuh mekanisme upload file via backend (multipart), gunakan:

- **Method**: `POST`
- **Path**: `/b2/upload-multipart`
- **Content-Type**: `multipart/form-data`

Field yang didukung untuk endpoint ini:

- File part (wajib)
  - Validasi:
    - `mimetype` harus `video/*`, **atau**
    - Ekstensi file termasuk salah satu:
      - `.mp4`
      - `.mkv`
      - `.webm`
      - `.avi`
      - `.mov`
      - `.m4v`

- Field `prefix` (opsional)
  - Membentuk objectKey: `<prefix>/<original_filename>`

- Field `fileSize` / `size` (opsional)
  - Membantu logging progres upload di server.

---

## Alur Backend (ringkas)

### Alur utama (disarankan): FE -> B2 -> FE -> BE

1. Frontend meminta `uploadUrl` dan `authorizationToken` via `GET /b2/upload-url`.
2. Frontend upload file langsung ke Backblaze B2.
3. Setelah upload sukses, frontend melakukan `POST /b2/upload` untuk commit metadata ke SQLite melalui `upsertFile`.

### Alur fallback (lama): FE -> BE -> B2

Gunakan `POST /b2/upload-multipart` jika file masih ingin dikirim via backend.

---

## Contoh Penggunaan di Frontend

### Upload via S3 Presigned PUT (Browser-friendly)

```js
async function uploadViaPresignedPutAndCommit({ file, prefix }) {
  const filePath = prefix ? `${prefix.replace(/^\/+|\/+$/g, '')}/${file.name}` : file.name;

  const presign = await fetch(
    `/b2/s3-presign?filePath=${encodeURIComponent(filePath)}&contentType=${encodeURIComponent(file.type || 'application/octet-stream')}`,
  ).then((r) => r.json());

  const putRes = await fetch(presign.url, {
    method: 'PUT',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
    },
    body: file,
  });

  if (!putRes.ok) {
    throw new Error(`Upload PUT failed: ${putRes.status}`);
  }

  const commitRes = await fetch('/b2/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filePath,
      size: file.size,
      contentType: file.type || 'application/octet-stream',
      uploadedAt: new Date().toISOString(),
    }),
  });

  if (!commitRes.ok) {
    const err = await commitRes.json().catch(() => ({}));
    throw new Error(err.error || 'Commit failed');
  }

  const data = await commitRes.json();
  return data.files?.[0];
}
```

### Upload Video (FE -> B2) lalu Commit (FE -> BE)

```js
async function uploadVideoAndCommit({ file, prefix }) {
  const info = await fetch('/b2/upload-url', { method: 'GET' }).then((r) => r.json());

  // Upload ke B2 (detail header B2 menyesuaikan implementasi FE kamu)
  // Setelah upload sukses, commit metadata ke backend:
  const filePath = prefix ? `${prefix.replace(/^\/+|\/+$/g, '')}/${file.name}` : file.name;

  const res = await fetch('/b2/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filePath,
      size: file.size,
      contentType: file.type || 'application/octet-stream',
      uploadedAt: new Date().toISOString(),
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Commit failed');
  }

  const data = await res.json();
  return data.files?.[0];
}
```

### Upload Video dengan `axios`

```js
import axios from 'axios';

async function commitUploadAxios({ filePath, size, contentType, uploadedAt }) {
  const res = await axios.post(
    '/b2/upload',
    { filePath, size, contentType, uploadedAt },
    { withCredentials: true },
  );
  return res.data;
}
```

### Troubleshooting (catatan FE)

- **Upload ke B2 sukses tapi commit gagal**
  - Cek respons `POST /b2/upload`.
  - Pastikan `filePath` sesuai object key di B2.
  - Jika mengirim batch, perhatikan response `207` yang berarti ada sebagian file yang gagal commit.

### Menggunakan ID untuk Streaming Video

ID yang dikembalikan oleh `/b2/upload` bisa dipakai untuk streaming lewat endpoint `/b2/stream/:id`.

```jsx
// Misal "file" adalah hasil dari uploadVideo()
<video
  src={`/b2/stream/${encodeURIComponent(file.id)}`}
  controls
/>
```

---

## Integrasi dengan Endpoint Lain

Untuk menampilkan daftar video atau file di B2:

- **List semua file/folder**:
  - `GET /b2/list?prefix=...&type=all|file&page=...`
- **List khusus video**:
  - `GET /b2/videos?prefix=...&pageToken=...`

Untuk streaming / download file (termasuk video yang baru diupload):

- **Stream / redirect ke signed URL**:
  - `GET /b2/stream/:id`
  - `id` = nilai `id` dari response `/b2/upload` atau `/b2/list` / `/b2/videos`.
