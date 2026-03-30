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

Jika FE ingin memakai `jobId` sendiri agar bisa subscribe SSE lebih awal, backend juga menerima:

- query `jobId`
- query `job_id`
- header `x-upload-job-id`

Untuk kasus **`encode=1`**, ini adalah cara yang disarankan.
Namun perlu dicatat: flow ini tetap diproses backend **satu per satu / sequential**, bukan semua file diproses paralel sekaligus.
Jadi kelebihannya bukan membuat seluruh upload folder jadi lebih cepat, tetapi membuat job bisa **ditinggal jalan** sambil FE tetap memantau progress lewat `jobId`.
FE cukup membuat `jobId` sendiri, kirim saat request upload dimulai, lalu gunakan endpoint status / SSE memakai `jobId` itu.

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
  - Jika `encode=1` / `true`, backend akan memproses video menjadi **HLS fMP4** (playlist `.m3u8` + init `.mp4` + segmen `.m4s`) lalu upload hasilnya ke B2.
  - Proses HLS menggunakan `ffmpeg -c copy` (tanpa re-encode) sehingga tidak menurunkan kualitas.
  - Saat packaging HLS, backend hanya membawa **video utama** dan **audio utama**. Subtitle, attachment font, dan stream data lain dari file seperti MKV tidak ikut dipaketkan ke output HLS.
  - **Penting (path output HLS)**: hasil HLS akan diupload ke folder berbasis **object key input tanpa ekstensi**.
    - Jika input video diupload sebagai: `<objectKey>.mp4`
    - Nama folder HLS dan nama segmen akan dinormalisasi menjadi **URL-safe**. Karakter seperti spasi, `[` `]`, dan simbol lain akan diganti agar path aman dipakai di CDN/player.
    - Maka output HLS akan berada di folder turunan dari `<objectKey>` dengan nama leaf yang sudah dinormalisasi, misalnya `Kira/Test/My_Video/index.m3u8`, `Kira/Test/My_Video/My_Video_init.mp4`, dan `Kira/Test/My_Video/My_Video_00001.m4s` dst.
    - Artinya: folder/prefix dari `prefix` + `relativePath` tetap dipakai.

- **Field `relativePath` / `filePath` / `path`** (opsional, per file)
  - Ini yang membuat endpoint bisa “upload folder”.
  - Contoh nilai: `720p/eps1.mp4`, `720p/eps2.mp4`, dst.
  - Jika diisi, backend akan:
    - Menyimpan object key persis sesuai path tersebut (digabung dengan `prefix` bila ada)
    - Membuat folder hierarchy di katalog lokal (SQLite) berdasarkan path itu.

Catatan penting (multipart payload):

- Beberapa client mengirim field `relativePath` dan `fileSize` sebagai field biasa yang berulang (bukan menempel di `part.fields` untuk tiap file).
- Backend akan membaca field-field tersebut sebagai **antrian (queue)** dan memasangkannya ke file yang diupload secara **berurutan**.
- Dengan begitu file ke-2 dan seterusnya tetap akan masuk ke subfolder yang benar (mis. `Video/...`), bukan jatuh langsung ke root prefix.

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
- Init segment: `Nanti Conto/720p/eps1/eps1_init.mp4`
- Media segment: `Nanti Conto/720p/eps1/eps1_00001.m4s`, `.../eps1_00002.m4s`, dst.

Jika nama file asli mengandung karakter yang tidak aman untuk URL/CDN, nama folder HLS dan nama segmen hasil encode akan memakai bentuk yang sudah dinormalisasi.

- Jika `relativePath` tidak ada:
  - `objectKey = <prefix>/<filename>`

---

## Response

### Catatan penting untuk `encode=1`

Pada flow multipart, backend membaca body upload sebagai stream multipart lalu memproses file yang masuk di request yang sama.
Untuk banyak file dalam satu folder, backend tetap menjalankan proses ini **berurutan per file**, jadi perilakunya tetap seperti antre satu-satu.
Artinya untuk kasus `encode=1`, response JSON biasanya baru diterima FE setelah fase berikut selesai:

1. body upload selesai diterima backend
2. encode / packaging HLS selesai
3. file output HLS (`index.m3u8`, init `.mp4`, dan `.m4s`) selesai diupload ke B2

Jadi benar: pada flow ini request upload tidak langsung selesai saat file pertama selesai terkirim dari FE.
Request baru selesai setelah pekerjaan pada request tersebut selesai diproses backend.

Artinya, untuk upload folder, endpoint ini **bukan** mekanisme agar semua file encode/upload bersamaan.
Nilai utamanya adalah request bisa dibiarkan berjalan dan FE tetap bisa melihat status realtime tanpa harus menunggu response akhir lebih dulu.

Karena itu, jika FE ingin langsung tracking progress encode **tanpa menunggu response upload selesai**, gunakan pola berikut:

1. FE generate `jobId` sendiri.
2. FE kirim `jobId` lewat query `jobId` / `job_id` atau header `x-upload-job-id`.
3. FE bisa langsung membuka SSE ke `/b2/upload-job-sse/:jobId` **atau** mulai cek `GET /b2/upload-job/:jobId`.
4. Jika `GET /b2/upload-job/:jobId` masih `404`, anggap job belum aktif / belum tercatat di storage job backend.
5. Jika endpoint check sudah mengembalikan `200`, FE bisa memakai hasil itu sebagai status awal lalu menjaga koneksi SSE tetap aktif untuk update realtime.
6. Backend akan membuat job sejak awal request masuk dengan status awal seperti `receiving`, lalu berubah ke `encoding` saat proses encode dimulai.

### Sukses (200)

```json
{
  "jobId": "<jobId>",
  "ssePath": "/b2/upload-job-sse/<jobId>",
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

- Jika response juga mengandung `ssePath`, FE bisa langsung pakai path tersebut.
- Jika FE ingin tracking saat upload masih berlangsung, jangan tunggu response ini. Gunakan `jobId` yang sudah FE kirim sendiri sejak awal request.

- `GET /b2/upload-job/:id`
- atau `GET /b2/upload-job?id=<jobId>`
- atau `GET /b2/upload-job-by-prefix?prefix=<prefix>`

Perilaku yang disarankan di FE:

- Jika `GET /b2/upload-job/:id` mengembalikan `404`, anggap job **belum aktif / belum tercatat**.
- FE boleh retry ringan beberapa kali sambil upload request masih berjalan.
- Begitu `GET /b2/upload-job/:id` mengembalikan `200`, gunakan data job itu untuk menampilkan status awal.
- Setelah itu, teruskan update realtime lewat SSE agar FE tidak perlu polling rapat.

Contoh response job aktif:

```json
{
  "id": "job_abc123",
  "prefix": "Kira/Test",
  "status": "encoding",
  "current": "Kira/Test/720p/eps1.mkv",
  "done": 0,
  "total": 1,
  "percent": 17,
  "error": null,
  "created_at_ms": 1711270000000,
  "updated_at_ms": 1711270005234
}
```

## Live progress via SSE (FE)

Untuk live update tanpa polling, gunakan SSE:

- `GET /b2/upload-job-sse/:id`
- atau `GET /b2/upload-job-sse?id=<jobId>`
- atau `GET /b2/upload-job-sse?prefix=<prefix>`

Event yang dikirim:

- `hello`
- `update` (payload = row job dari SQLite)
- `not_found` (job belum aktif / belum tercatat)
- `end`
- `error`

Untuk flow multipart + `encode=1`, pola yang aman di FE biasanya seperti ini:

1. FE generate `jobId`.
2. FE mulai upload multipart sambil mengirim `jobId`.
3. FE buka SSE ke `/b2/upload-job-sse/:jobId`.
4. Jika SSE mengirim `not_found`, FE anggap job belum aktif lalu biarkan koneksi retry / reconnect.
5. Saat event `update` mulai masuk, FE tampilkan progress realtime dari field `status`, `current`, dan `percent`.
6. Saat event `end` masuk, FE tutup koneksi SSE.

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
- `test/720p/eps1/eps1_init.mp4`
- `test/720p/eps1/eps1_00001.m4s` dst.
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
  const jobId = `job_${Date.now()}`;
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
  qs.set('jobId', jobId);

  async function waitUntilJobActive() {
    for (let i = 0; i < 20; i += 1) {
      const r = await fetch(`/b2/upload-job/${encodeURIComponent(jobId)}`);
      if (r.status === 200) return r.json();
      if (r.status !== 404) throw new Error(`Failed to check job: ${r.status}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return null;
  }

  const es = new EventSource(`/b2/upload-job-sse/${encodeURIComponent(jobId)}`);
  es.addEventListener('not_found', () => {
    console.log('job belum aktif');
  });
  es.addEventListener('update', (ev) => {
    const job = JSON.parse(ev.data);
    console.log('progress', job.status, job.percent);
  });
  es.addEventListener('end', () => {
    es.close();
  });

  const uploadPromise = fetch(`/b2/upload-folder-multipart?${qs.toString()}`, {
    method: 'POST',
    body: fd,
  });

  const job = await waitUntilJobActive();
  console.log('job aktif', job);

  const res = await uploadPromise;
  const data = await res.json();
  return { jobId, job, data, es };
}
```

Jika kamu tidak ingin polling sama sekali, FE juga bisa langsung mengandalkan SSE.
Namun endpoint `GET /b2/upload-job/:id` tetap berguna sebagai check awal apakah row job sudah aktif atau masih `404`.

---

## Catatan penting

- Endpoint ini **menyimpan struktur folder** (prefix seperti `720p/`) dari `relativePath`.
- Endpoint ini **mengupload ke B2 lewat backend** (lebih berat dibanding presigned PUT).
- Untuk banyak file, proses tetap **sequential / satu per satu** di backend.
- Kelebihan utamanya adalah job bisa **ditinggal** sambil tetap dipantau lewat `GET /b2/upload-job/:id` atau SSE `/b2/upload-job-sse/:id`.
