# B2 Import By URL API (Server fetch)

Dokumen ini menjelaskan endpoint untuk **import video dari URL remote** (contoh: `https://.../video.mp4`).

Flow ini berbeda dari:

- `direct-upload-link`: FE upload binary (PUT) ke backend.
- `upload-folder-multipart`: FE upload multipart ke backend.

Di sini FE hanya mengirim **URL**. Backend akan:

- fetch/stream dari URL
- jika `encode=1`: stream → `ffmpeg` → output HLS → upload ke B2
- jika `encode=0`: stream → upload original ke B2

---

## Endpoint

- **Method**: `POST`
- **Path**: `/b2/import-by-url`
- **Content-Type**: `application/json`

---

## Request

### Body

```json
{
  "sourceUrl": "https://example.com/video.mp4",
  "prefix": "test",
  "relativePath": "720p/eps1.mp4",
  "fileName": "eps1.mp4",
  "contentType": "video/mp4",
  "encode": 1
}
```

Keterangan:

- `sourceUrl` (wajib): URL `http/https`.
- `prefix` (opsional): prefix global.
- `relativePath` (opsional): path di dalam prefix.
  - Jika ada, object key jadi: `<prefix>/<relativePath>`.
- `fileName` (opsional): dipakai jika `relativePath` kosong.
  - Jika kosong juga, backend akan coba ambil dari nama file pada URL.
- `contentType` (opsional): override content-type.
- `encode` (opsional):
  - `1`/`true` → encode HLS
  - `0`/`false` → upload original

---

## Response

### Sukses (200)

Response selalu mengembalikan `jobId` dan array `files`.

Jika `encode=0`:

```json
{
  "jobId": "<jobId>",
  "files": [
    {
      "id": "test/720p/eps1.mp4",
      "name": "eps1.mp4",
      "mimeType": "video/mp4",
      "size": 1570024,
      "modifiedTime": "2026-03-01T00:00:00.000Z"
    }
  ]
}
```

Jika `encode=1`:

```json
{
  "jobId": "<jobId>",
  "files": [
    {
      "id": "test/720p/eps1/index.m3u8",
      "name": "index.m3u8",
      "mimeType": "application/vnd.apple.mpegurl",
      "size": 0,
      "modifiedTime": "2026-03-01T00:00:00.000Z"
    }
  ]
}
```

---

## Progress (Polling / SSE)

Gunakan endpoint job yang sama:

- Polling:
  - `GET /b2/upload-job/:id`
  - `GET /b2/upload-job?id=<jobId>`

- SSE:
  - `GET /b2/upload-job-sse/:id`
  - `GET /b2/upload-job-sse?id=<jobId>`

- Cancel:
  - `DELETE /b2/upload-job/:id`

---

## Catatan penting

- Backend akan mengikuti redirect (`302`) saat fetch.
- Hanya mendukung URL `http/https`.
- Jika source server sangat lambat / sering putus, job bisa error.
