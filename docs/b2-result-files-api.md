# B2 Result Files API

Dokumen ini menjelaskan field **`resultFiles`** yang disertakan backend pada response upload job dan SSE update events.

Field `resultFiles` berisi array file hasil upload (HLS `index.m3u8` atau MP4) dengan path asli di B2, sehingga frontend tidak perlu menebak path.

---

## Masalah yang diselesaikan

Frontend sebelumnya menebak path file HLS dengan pola `{prefix}/{namaFile_tanpa_ekstensi}/index.m3u8`, tetapi selalu salah karena struktur folder hasil encode bisa berbeda-beda.

Sekarang backend menyimpan path asli dan mengembalikannya via `resultFiles`.

---

## Spesifikasi field `resultFiles`

Array of object dengan field berikut:

| Field | Tipe | Wajib | Deskripsi |
|-------|------|-------|-----------|
| `path` | string | Ya | Full path / object key di B2 (tanpa URL encoding) |
| `name` | string | Ya | Nama file saja, contoh `index.m3u8` atau `video.mp4` |
| `type` | string | Ya | `"hls"` untuk index.m3u8 hasil encode, `"mp4"` untuk file MP4 |
| `streamUrl` | string | Tidak | URL lengkap CDN (jika BE tidak kasih, FE akan generate sendiri dari `path` + `STREAM_BASE`) |

### Aturan penting

- `path` adalah object key asli di B2, bukan hasil tebakan.
- `type: "hls"` = file `index.m3u8` (master playlist). Segment `.ts` / `.m4s` **TIDAK** perlu dimasukkan.
- `type: "mp4"` = file `.mp4` mentah (upload tanpa encode).
- Untuk upload dengan `encode=1`: `resultFiles` baru muncul saat `status: "done"`. Saat status masih `encoding` / `uploading`, `resultFiles` boleh kosong atau tidak ada.
- Untuk upload tanpa encode (`encode=0`): `resultFiles` langsung ada di response POST.
- Satu job bisa punya multiple `resultFiles` jika upload multiple file.

---

## 1) SSE update event saat `status = done`

### Endpoint

- **GET** `/b2/upload-job-sse/:id`
- **GET** `/b2/upload-job-sse?id=<jobId>`
- **GET** `/b2/upload-job-sse?prefix=<prefix>`

### Event `update` saat `status = done`

```json
{
  "id": "fe_abc123",
  "prefix": "Kira/Test",
  "status": "done",
  "current": "Kira/Test/Virgoun - Surat Cinta Untuk Starla _ A Love Letter To Starla (Official Lyric Video)/index.m3u8",
  "done": 1,
  "total": 1,
  "percent": 100,
  "error": null,
  "resultFiles": [
    {
      "path": "Kira/Test/Virgoun - Surat Cinta Untuk Starla _ A Love Letter To Starla (Official Lyric Video)/index.m3u8",
      "name": "index.m3u8",
      "type": "hls",
      "streamUrl": "https://cdn-stable.nanimeid.xyz/file/NanimeID/Kira/Test/Virgoun%20-%20Surat%20Cinta%20Untuk%20Starla%20_%20A%20Love%20Letter%20To%20Starla%20(Official%20Lyric%20Video)/index.m3u8"
    }
  ],
  "created_at_ms": 1711270000000,
  "updated_at_ms": 1711270099999
}
```

### Saat status masih encoding/uploading

`resultFiles` akan `null` atau tidak ada:

```json
{
  "id": "fe_abc123",
  "status": "encoding",
  "percent": 35,
  "resultFiles": null
}
```

---

## 2) GET /b2/upload-job/:id

### Endpoint

- **GET** `/b2/upload-job/:id`
- **GET** `/b2/upload-job?id=<jobId>`

### Response sukses (200) saat `status = done`

```json
{
  "id": "fe_abc123",
  "prefix": "Kira/Test",
  "status": "done",
  "current": "Kira/Test/Virgoun - Surat Cinta Untuk Starla _ A Love Letter To Starla (Official Lyric Video)/index.m3u8",
  "done": 1,
  "total": 1,
  "percent": 100,
  "error": null,
  "resultFiles": [
    {
      "path": "Kira/Test/Virgoun - Surat Cinta Untuk Starla _ A Love Letter To Starla (Official Lyric Video)/index.m3u8",
      "name": "index.m3u8",
      "type": "hls",
      "streamUrl": "https://cdn-stable.nanimeid.xyz/file/NanimeID/Kira/Test/Virgoun%20-%20Surat%20Cinta%20Untuk%20Starla%20_%20A%20Love%20Letter%20To%20Starla%20(Official%20Lyric%20Video)/index.m3u8"
    }
  ],
  "created_at_ms": 1711270000000,
  "updated_at_ms": 1711270099999
}
```

### Response saat masih processing

```json
{
  "id": "fe_abc123",
  "status": "encoding",
  "percent": 35,
  "resultFiles": null
}
```

---

## 3) POST /b2/upload-folder-multipart (upload tanpa encode)

### Endpoint

- **POST** `/b2/upload-folder-multipart`

### Response sukses (200) dengan `encode=0`

```json
{
  "jobId": "fe_abc123",
  "ssePath": "/b2/upload-job-sse/fe_abc123",
  "files": [
    {
      "id": "Kira/Test/video.mp4",
      "name": "video.mp4",
      "mimeType": "video/mp4",
      "size": 104857600,
      "modifiedTime": "2026-06-29T04:00:00.000Z",
      "type": "mp4",
      "streamUrl": "https://cdn-stable.nanimeid.xyz/file/NanimeID/Kira/Test/video.mp4"
    }
  ],
  "resultFiles": [
    {
      "path": "Kira/Test/video.mp4",
      "name": "video.mp4",
      "type": "mp4",
      "streamUrl": "https://cdn-stable.nanimeid.xyz/file/NanimeID/Kira/Test/video.mp4"
    }
  ]
}
```

### Response sukses (200) dengan `encode=1`

Saat upload dengan encode, response POST baru diterima setelah encode selesai. `resultFiles` berisi path HLS:

```json
{
  "jobId": "fe_abc123",
  "ssePath": "/b2/upload-job-sse/fe_abc123",
  "files": [
    {
      "id": "Kira/Test/Virgoun - Surat Cinta Untuk Starla _ A Love Letter To Starla (Official Lyric Video)/index.m3u8",
      "name": "index.m3u8",
      "mimeType": "application/vnd.apple.mpegurl",
      "size": 0,
      "modifiedTime": "2026-06-29T04:05:00.000Z",
      "type": "hls",
      "streamUrl": "https://cdn-stable.nanimeid.xyz/file/NanimeID/Kira/Test/Virgoun%20-%20Surat%20Cinta%20Untuk%20Starla%20_%20A%20Love%20Letter%20To%20Starla%20(Official%20Lyric%20Video)/index.m3u8"
    }
  ],
  "resultFiles": [
    {
      "path": "Kira/Test/Virgoun - Surat Cinta Untuk Starla _ A Love Letter To Starla (Official Lyric Video)/index.m3u8",
      "name": "index.m3u8",
      "type": "hls",
      "streamUrl": "https://cdn-stable.nanimeid.xyz/file/NanimeID/Kira/Test/Virgoun%20-%20Surat%20Cinta%20Untuk%20Starla%20_%20A%20Love%20Letter%20To%20Starla%20(Official%20Lyric%20Video)/index.m3u8"
    }
  ]
}
```

### Response partial (207) jika ada file gagal

```json
{
  "jobId": "fe_abc123",
  "ssePath": "/b2/upload-job-sse/fe_abc123",
  "files": [
    {
      "id": "Kira/Test/video1.mp4",
      "name": "video1.mp4",
      "type": "mp4",
      "streamUrl": "https://cdn-stable.nanimeid.xyz/file/NanimeID/Kira/Test/video1.mp4"
    }
  ],
  "resultFiles": [
    {
      "path": "Kira/Test/video1.mp4",
      "name": "video1.mp4",
      "type": "mp4",
      "streamUrl": "https://cdn-stable.nanimeid.xyz/file/NanimeID/Kira/Test/video1.mp4"
    }
  ],
  "errors": [
    {
      "fileName": "video2.mp4",
      "objectKey": "Kira/Test/video2.mp4",
      "error": "Upload failed"
    }
  ]
}
```

---

## 4) POST /b2/import-by-url

### Endpoint

- **POST** `/b2/import-by-url`

### Response sukses (200) dengan `encode=1`

```json
{
  "jobId": "fe_abc123",
  "ssePath": "/b2/upload-job-sse/fe_abc123",
  "files": [
    {
      "id": "Kira/Test/video/index.m3u8",
      "name": "index.m3u8",
      "mimeType": "application/vnd.apple.mpegurl",
      "size": 0,
      "modifiedTime": "2026-06-29T04:05:00.000Z",
      "type": "hls",
      "streamUrl": "https://cdn-stable.nanimeid.xyz/file/NanimeID/Kira/Test/video/index.m3u8"
    }
  ],
  "resultFiles": [
    {
      "path": "Kira/Test/video/index.m3u8",
      "name": "index.m3u8",
      "type": "hls",
      "streamUrl": "https://cdn-stable.nanimeid.xyz/file/NanimeID/Kira/Test/video/index.m3u8"
    }
  ]
}
```

### Response sukses (200) dengan `encode=0`

```json
{
  "jobId": "fe_abc123",
  "ssePath": "/b2/upload-job-sse/fe_abc123",
  "files": [
    {
      "id": "Kira/Test/video.mp4",
      "name": "video.mp4",
      "mimeType": "video/mp4",
      "size": 52428800,
      "modifiedTime": "2026-06-29T04:02:00.000Z",
      "type": "mp4",
      "streamUrl": "https://cdn-stable.nanimeid.xyz/file/NanimeID/Kira/Test/video.mp4"
    }
  ],
  "resultFiles": [
    {
      "path": "Kira/Test/video.mp4",
      "name": "video.mp4",
      "type": "mp4",
      "streamUrl": "https://cdn-stable.nanimeid.xyz/file/NanimeID/Kira/Test/video.mp4"
    }
  ]
}
```

---

## 5) POST /b2/upload (commit upload)

### Endpoint

- **POST** `/b2/upload`

### Response sukses (200)

```json
{
  "jobId": "fe_abc123",
  "files": [
    {
      "id": "Kira/Test/video.mp4",
      "name": "video.mp4",
      "mimeType": "video/mp4",
      "size": 104857600,
      "modifiedTime": "2026-06-29T04:00:00.000Z",
      "type": "mp4",
      "streamUrl": "https://cdn-stable.nanimeid.xyz/file/NanimeID/Kira/Test/video.mp4"
    }
  ],
  "resultFiles": [
    {
      "path": "Kira/Test/video.mp4",
      "name": "video.mp4",
      "type": "mp4",
      "streamUrl": "https://cdn-stable.nanimeid.xyz/file/NanimeID/Kira/Test/video.mp4"
    }
  ]
}
```

---

## 6) POST /b2/upload-multipart

### Endpoint

- **POST** `/b2/upload-multipart`

### Response sukses (200)

```json
{
  "files": [
    {
      "id": "Kira/Test/video.mp4",
      "name": "video.mp4",
      "mimeType": "video/mp4",
      "size": 104857600,
      "modifiedTime": "2026-06-29T04:00:00.000Z",
      "type": "mp4",
      "streamUrl": "https://cdn-stable.nanimeid.xyz/file/NanimeID/Kira/Test/video.mp4"
    }
  ],
  "resultFiles": [
    {
      "path": "Kira/Test/video.mp4",
      "name": "video.mp4",
      "type": "mp4",
      "streamUrl": "https://cdn-stable.nanimeid.xyz/file/NanimeID/Kira/Test/video.mp4"
    }
  ]
}
```

---

## 7) PUT /b2/direct-upload/:token (direct upload link)

### Endpoint

- **PUT** `/b2/direct-upload/:token`

### Response sukses (200) dengan `encode=1`

```json
{
  "jobId": "fe_abc123",
  "ssePath": "/b2/upload-job-sse/fe_abc123",
  "files": [
    {
      "id": "Kira/Test/video/index.m3u8",
      "name": "index.m3u8",
      "mimeType": "application/vnd.apple.mpegurl",
      "size": 0,
      "modifiedTime": "2026-06-29T04:05:00.000Z",
      "type": "hls",
      "streamUrl": "https://cdn-stable.nanimeid.xyz/file/NanimeID/Kira/Test/video/index.m3u8"
    }
  ],
  "resultFiles": [
    {
      "path": "Kira/Test/video/index.m3u8",
      "name": "index.m3u8",
      "type": "hls",
      "streamUrl": "https://cdn-stable.nanimeid.xyz/file/NanimeID/Kira/Test/video/index.m3u8"
    }
  ]
}
```

---

## Alur Frontend

1. Upload file -> dapat `jobId`
2. Subscribe SSE `/b2/upload-job-sse/:jobId`
3. Saat event `update` dengan `status: "done"`, baca `resultFiles` array
4. Tampilkan setiap file di list "Hasil Upload" dengan tombol Copy link
5. Jika `streamUrl` ada, langsung copy itu. Jika tidak, FE generate dari `path` + `STREAM_BASE`
6. Frontend berhenti menebak path HLS. Frontend hanya baca `resultFiles` dari BE.

### Contoh FE

```js
const es = new EventSource(`/b2/upload-job-sse/${encodeURIComponent(jobId)}`);

es.addEventListener('update', (ev) => {
  const job = JSON.parse(ev.data);
  console.log('progress', job.percent, job.status);

  if (job.status === 'done' && job.resultFiles) {
    for (const file of job.resultFiles) {
      console.log('Result file:', file.path, file.type, file.streamUrl);
      // Tampilkan di UI dengan tombol copy link
    }
  }
});

es.addEventListener('end', (ev) => {
  const data = JSON.parse(ev.data);
  console.log('job end', data.status);
  es.close();
});
```

---

## Stream URL format

Backend generate `streamUrl` dari:

- `B2_CDN_BASE` env var (default: `https://cdn-stable.nanimeid.xyz/file/NanimeID`)
- `path` (object key di B2)

Setiap segment dari path di-encode dengan `encodeURIComponent`, lalu di-join dengan `/`.

Contoh:
- `path`: `Kira/Test/video file.mp4`
- `streamUrl`: `https://cdn-stable.nanimeid.xyz/file/NanimeID/Kira/Test/video%20file.mp4`

Jika `streamUrl` tidak ada di response, FE bisa generate sendiri dengan formula yang sama.

---

## Database migration

Field `resultFiles` disimpan sebagai kolom `result_files` (JSONB) di tabel `upload_jobs`.

Migration SQL:

```sql
ALTER TABLE "upload_jobs" ADD COLUMN "result_files" JSONB;
```

Prisma schema:

```prisma
model UploadJob {
  // ... field lain
  resultFiles Json? @map("result_files")
}
```

---

## Catatan penting

- `resultFiles` hanya diisi saat job selesai (`done` / `partial`). Saat status lain, field akan `null`.
- Untuk upload tanpa encode, `resultFiles` langsung ada di response POST karena tidak ada proses encode.
- Untuk upload dengan encode, `resultFiles` baru tersedia saat `status: "done"`. Gunakan SSE untuk mendapatkan update realtime.
- Segment `.ts` / `.m4s` **TIDAK** dimasukkan di `resultFiles`. Hanya `index.m3u8` (untuk HLS) atau file `.mp4` (untuk non-encode).
- Field `files` di response tetap ada untuk backward compatibility, tetapi sekarang juga punya field `type` dan `streamUrl`.
