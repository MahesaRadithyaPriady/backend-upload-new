# B2 Upload Folder (Multipart) API

Dokumen ini menjelaskan endpoint untuk upload banyak file (mis. 12 episode) sambil mempertahankan struktur folder seperti `720p/eps1.mp4`.

Endpoint ini cocok untuk memudahkan upload “folder” dari client (mis. dari aplikasi desktop / script). Untuk browser, biasanya lebih disarankan menggunakan presigned PUT per file lalu commit metadata, tapi endpoint ini tetap disediakan sebagai fallback.

---

## Endpoint

- **Method**: `POST`
- **Path**: `/b2/upload-folder-multipart`
- **Content-Type**: `multipart/form-data`

Catatan: untuk menghindari masalah urutan multipart (mis. file terkirim duluan baru field `prefix`), backend juga mendukung `prefix` dan `encode` lewat query string:

- `/b2/upload-folder-multipart?prefix=test`
- `/b2/upload-folder-multipart?prefix=test&encode=1`

---

## Request

### Part yang didukung

- **File part** (bisa banyak)
  - `filename`: nama file asli (contoh: `eps1.mp4`)
  - `mimetype`: harus `video/*` atau ekstensi termasuk:
    - `.mp4`, `.mkv`, `.webm`, `.avi`, `.mov`, `.m4v`

- **Field `prefix`** (opsional)
  - Prefix global untuk semua file.
  - Contoh: `Nanti Conto`.

- **Field `encode`** (opsional)
  - Jika `encode=1` / `true`, backend akan memproses video menjadi **HLS** (playlist `.m3u8` + segmen `.ts`) lalu upload hasilnya ke B2.
  - Proses HLS menggunakan `ffmpeg -c copy` (tanpa re-encode) sehingga tidak menurunkan kualitas.
  - **Penting (path output HLS)**: hasil HLS akan diupload ke folder berbasis **object key input tanpa ekstensi**.
    - Jika input video diupload sebagai: `<objectKey>.mp4`
    - Maka output HLS akan berada di: `<objectKey>/index.m3u8` dan `<objectKey>/<basename>_00001.ts` dst.
    - Artinya: folder/prefix dari `prefix` + `relativePath` tetap dipakai.

- **Field `relativePath` / `filePath` / `path`** (opsional, per file)
  - Ini yang membuat endpoint bisa “upload folder”.
  - Contoh nilai: `720p/eps1.mp4`, `720p/eps2.mp4`, dst.
  - Jika diisi, backend akan:
    - Menyimpan object key persis sesuai path tersebut (digabung dengan `prefix` bila ada)
    - Membuat folder hierarchy di katalog lokal (SQLite) berdasarkan path itu.

- **Fallback: path di `filename`**
  - Jika client mengirim `filename` yang sudah mengandung folder (mis. `test/video1.mp4`), backend akan menganggap itu sebagai `relativePath`.
  - Jadi object key akan menjadi `test/video1.mp4` (atau `<prefix>/test/video1.mp4` jika `prefix` diisi), dan folder `test/` akan ikut tercatat.

- **Field `fileSize` / `size`** (opsional)
  - Untuk bantu logging progress.

### Cara membentuk object key

Backend membentuk object key seperti:

- Jika `relativePath` (atau alias) tersedia:
  - `objectKey = <prefix>/<relativePath>`
  - Contoh:
    - `prefix = Nanti Conto`
    - `relativePath = 720p/eps1.mp4`
    - Hasil: `Nanti Conto/720p/eps1.mp4`

Jika `encode=1`, maka output HLS untuk contoh di atas akan menjadi:

- Playlist: `Nanti Conto/720p/eps1/index.m3u8`
- Segmen: `Nanti Conto/720p/eps1/eps1_00001.ts`, `.../eps1_00002.ts`, dst.

- Jika `relativePath` tidak ada:
  - `objectKey = <prefix>/<filename>`

---

## Response

### Sukses (200)

```json
{
  "jobId": "<jobId>",
  "files": [
    {
      "id": "Nanti Conto/720p/eps1/index.m3u8",
      "name": "index.m3u8",
      "mimeType": "application/vnd.apple.mpegurl",
      "size": 123456,
      "modifiedTime": "2026-02-24T00:00:00.000Z"
    }
  ]
}
```

## Cancel / kill job

Untuk membatalkan job (termasuk menghentikan proses `ffmpeg` jika sedang encode), gunakan:

- **Method**: `DELETE`
- **Path**: `/b2/upload-job/:id`

atau:

- **Method**: `DELETE`
- **Path**: `/b2/upload-job?id=<jobId>`

Response:

```json
{ "ok": true }
```

## Polling progress (FE)

Response dari endpoint ini selalu mengembalikan `jobId`. FE bisa polling progress:

- `GET /b2/upload-job/:id`
- atau `GET /b2/upload-job?id=<jobId>`
- atau `GET /b2/upload-job-by-prefix?prefix=<prefix>`

## Live progress via SSE (FE)

Untuk live update tanpa polling, gunakan SSE:

- `GET /b2/upload-job-sse/:id`
- atau `GET /b2/upload-job-sse?id=<jobId>`
- atau `GET /b2/upload-job-sse?prefix=<prefix>`

Event yang dikirim:

- `hello`
- `update` (payload = row job dari SQLite)
- `not_found`
- `end`
- `error`

Contoh penggunaan (browser):

```js
const es = new EventSource(`/b2/upload-job-sse/${encodeURIComponent(jobId)}`);

es.addEventListener('update', (ev) => {
  const job = JSON.parse(ev.data);
  console.log('job update', job);
});

es.addEventListener('end', () => {
  es.close();
});

es.addEventListener('error', () => {
  // Biasanya terjadi kalau koneksi putus, FE bisa reconnect.
});
```

### Partial success (207)

Jika sebagian file gagal, response akan berisi `files` dan `errors`.

```json
{
  "files": [
    { "id": "Nanti Conto/720p/eps1.mp4", "name": "eps1.mp4" }
  ],
  "errors": [
    { "fileName": "eps2.mp4", "objectKey": "Nanti Conto/720p/eps2.mp4", "error": "..." }
  ]
}
```

### Error (400/500)

- 400 jika tidak ada file part atau semua file invalid.
- 500 jika terjadi error internal.

---

## Contoh penggunaan

### cURL (single file, dengan relativePath)

```bash
curl -X POST "http://localhost:PORT/b2/upload-folder-multipart" \
  -F "prefix=test" \
  -F "encode=1" \
  -F "file=@./720p/eps1.mp4" \
  -F "relativePath=720p/eps1.mp4"

Hasil output HLS akan berada di:

- `test/720p/eps1/index.m3u8`
- `test/720p/eps1/eps1_00001.ts` dst.
```

### cURL (fallback, path lewat filename)

Sebagian client (atau script) bisa mengirim filename berisi path. Jika itu yang terjadi, backend akan tetap membuat folder prefix otomatis.

```bash
curl -X POST "http://localhost:PORT/b2/upload-folder-multipart" \
  -F "file=@./test/video1.mp4;filename=test/video1.mp4"
```

Catatan: banyak tool CLI mengikat field ke request, bukan per file. Kalau kamu butuh metadata per file secara konsisten, gunakan pola `filePath[]` + `file[]` berpasangan (perlu update endpoint). Untuk kebutuhan sekarang, endpoint ini paling pas dipakai dari script/client yang bisa mengirim `relativePath` per part (multipart advanced).

### Postman (multi file)

- Body: `form-data`
- Tambahkan key `prefix` (Text)
- Untuk tiap file:
  - key `file` (File)
  - key `relativePath` (Text)
  - Ulangi sampai semua episode terupload

### Contoh FE (FormData)

Pastikan `prefix` ditambahkan ke `FormData` sebelum file, atau gunakan query string agar tidak tergantung urutan part.

```js
async function uploadFolderMultipart({ files, prefix, encode }) {
  const fd = new FormData();
  if (prefix) fd.append('prefix', prefix);
  if (encode) fd.append('encode', '1');

  for (const f of files) {
    fd.append('file', f.file, f.file.name);
    fd.append('relativePath', f.relativePath);
  }

  const qs = new URLSearchParams();
  if (prefix) qs.set('prefix', prefix);
  if (encode) qs.set('encode', '1');

  const res = await fetch(`/b2/upload-folder-multipart?${qs.toString()}`, {
    method: 'POST',
    body: fd,
  });
  return res.json();
}
```

---

## Catatan penting

- Endpoint ini **menyimpan struktur folder** (prefix seperti `720p/`) dari `relativePath`.
- Endpoint ini **mengupload ke B2 lewat backend** (lebih berat dibanding presigned PUT).
