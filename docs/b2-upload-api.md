# B2 Upload API

Dokumen ini menjelaskan API upload video ke Backblaze B2 beserta alur umum dan contoh penggunaan untuk frontend.

---

## Endpoint

- **Method**: `POST`
- **Path**: `/b2/upload`
- **Content-Type**: `multipart/form-data`

Endpoint ini digunakan untuk **upload file video** ke B2 tanpa proses encoding/transcoding. File dikirim apa adanya, lalu disimpan ke bucket B2 dan dicatat metadatanya di katalog lokal (SQLite).

Endpoint ini **hanya menerima file video**. File non-video (misalnya PDF, DOCX, ZIP) akan ditolak dengan status **400**.

---

## Request

### Field `file` (wajib)

- Tipe: `file` (multipart)
- Deskripsi: File video yang akan di-upload.
- Validasi:
  - `mimetype` harus `video/*`, **atau**
  - Ekstensi file termasuk salah satu:
    - `.mp4`
    - `.mkv`
    - `.webm`
    - `.avi`
    - `.mov`
    - `.m4v`

Jika file tidak memenuhi kriteria di atas, server akan mengembalikan:

```json
{
  "error": "Only video files are allowed for this endpoint"
}
```

### Field `prefix` (opsional)

- Tipe: `string`
- Deskripsi: Prefix/folder tempat file akan disimpan di B2.
- Contoh nilai:
  - `"videos"`
  - `"courses/kelas-a"`

Server akan menormalisasi prefix (menghapus spasi dan `/` berlebih), lalu membentuk `objectKey`:

```text
<prefix>/<original_filename>
```

Contoh:

- `prefix = "videos"`, file `intro.mp4` → `videos/intro.mp4`
- `prefix = "courses/kelas-a"`, file `intro.mp4` → `courses/kelas-a/intro.mp4`

Jika `prefix` tidak diisi, file disimpan langsung di root bucket dengan nama asli file.

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

- Tidak ada file:

  ```json
  {
    "error": "No file provided"
  }
  ```

- Tidak ada `filename`:

  ```json
  {
    "error": "Missing filename"
  }
  ```

- File bukan video:

  ```json
  {
    "error": "Only video files are allowed for this endpoint"
  }
  ```

- Error internal server:

  ```json
  {
    "error": "Failed to upload file to B2",
    "details": "<pesan error>"
  }
  ```

---

## Alur Backend (ringkas)

1. Backend membaca `file` dan `prefix` dari `multipart/form-data`.
2. Validasi nama file (`filename`) dan tipe file (hanya video).
3. Menentukan `objectKey` berdasarkan `prefix` dan nama file.
4. Membaca stream file dan mengupload ke B2 **tanpa encoding** menggunakan `uploadFromStream`.
5. Menyimpan metadata file ke SQLite melalui `upsertFile` (folder, nama file, path, ukuran, `content_type`, waktu upload).
6. Mengembalikan response JSON berisi array `files` seperti di atas.

---

## Contoh Penggunaan di Frontend

### Upload Video dengan `fetch` (JavaScript)

```js
async function uploadVideo({ file, prefix }) {
  const formData = new FormData();
  formData.append('file', file); // file: objek File dari input[type=file]

  if (prefix) {
    formData.append('prefix', prefix); // contoh: 'courses/kelas-a'
  }

  const res = await fetch('/b2/upload', {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Upload failed');
  }

  const data = await res.json();
  return data.files[0]; // { id, name, mimeType, size, modifiedTime }
}
```

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
