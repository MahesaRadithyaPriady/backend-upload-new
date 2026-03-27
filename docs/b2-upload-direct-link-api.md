# B2 Direct Upload Link API (Backend PUT)

Dokumen ini menjelaskan flow upload 2-step menggunakan **link upload ke backend** (bukan ke B2 langsung). Flow ini cocok untuk upload yang lama/stabil, dan bisa mendukung **encode HLS**.

Bedanya dengan `upload-folder-multipart`:

- Direct link: FE upload pakai `PUT` **raw binary** (tanpa multipart).
- Multipart folder: FE upload pakai `multipart/form-data`.

---

## Flow ringkas

1. FE minta link upload ke backend (mendapat `uploadUrl` + `jobId`).
2. FE `PUT` binary ke `uploadUrl`.
3. FE pantau progress lewat polling / SSE menggunakan `jobId`.

Catatan tambahan:

- Jika sumber videonya dari URL remote (bukan file lokal), gunakan endpoint **import by URL** (`POST /b2/import-by-url`).
- Flow import by URL juga streaming (server fetch) dan bisa `encode=1` → HLS menggunakan `ffmpeg -c copy` (tanpa re-encode) + job progress yang sama.

---

## 1) Buat link upload

- **Method**: `POST`
- **Path**: `/b2/direct-upload-link`
- **Content-Type**: `application/json`

Catatan:

- Endpoint ini **tidak menerima URL video**.
- FE hanya meminta token/link, lalu upload file video sebagai **raw binary stream** lewat `PUT`.

### Field wajib

- Wajib salah satu:
  - `relativePath`, atau
  - `fileName`

### Field yang disarankan

- `prefix`
- `contentType`
- `size`
- `encode`

### Body

```json
{
  "jobId": "custom_job_123",
  "prefix": "test",
  "relativePath": "720p/eps1.mp4",
  "fileName": "eps1.mp4",
  "contentType": "video/mp4",
  "size": 1570024,
  "encode": 1,
  "expiresInSeconds": 1800
}
```

Keterangan:

- `prefix` (opsional): prefix global.
- `relativePath` (opsional): path file di dalam prefix. Jika ada, object key akan menjadi `<prefix>/<relativePath>`.
- `fileName` (opsional): dipakai bila `relativePath` tidak ada.
- `contentType` (opsional): default `application/octet-stream`.
- `size` (opsional): dipakai untuk logging.
- `jobId` (opsional): FE boleh mengirim `jobId` sendiri agar bisa subscribe progress sebelum proses upload/encode selesai.
- `encode` (opsional): jika `1`, backend akan encode ke **HLS** (tanpa re-encode, `ffmpeg -c copy`).

### Response

```json
{
  "jobId": "<jobId>",
  "ssePath": "/b2/upload-job-sse/<jobId>",
  "method": "PUT",
  "uploadUrl": "/b2/direct-upload/<token>",
  "expiresInSeconds": 1800,
  "expiresAt": "2026-02-28T00:00:00.000Z",
  "encode": 1
}
```

Catatan:

- `uploadUrl` adalah path relatif. FE dapat menggabungkan dengan base URL API.

---

## 2) Upload binary ke link (PUT)

- **Method**: `PUT`
- **Path**: `/b2/direct-upload/:token`
- **Body**: raw binary (file)

Logic backend:

- Jika `encode=1` saat buat link:
  - stream dari client → `ffmpeg` (stdin)
  - output HLS (`index.m3u8` + `.ts`) diupload ke B2
  - nama folder HLS dan nama segmen dinormalisasi menjadi **URL-safe** agar aman dipakai di CDN/player
- Jika `encode=0`:
  - stream dari client → upload ke B2 sebagai file original

Header yang disarankan:

- `Content-Type`: sama dengan `contentType` yang dikirim saat minta link
- `Content-Length`: disarankan (agar server bisa log size lebih akurat)

### Contoh (fetch)

```js
async function directPut({ apiBase, uploadUrl, file, contentType }) {
  const res = await fetch(`${apiBase}${uploadUrl}`, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType || file.type || 'application/octet-stream',
      'Content-Length': String(file.size),
    },
    body: file,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `PUT failed: ${res.status}`);
  }

  return res.json();
}
```

### Response (200)

Jika `encode=0`:

```json
{
  "jobId": "<jobId>",
  "ssePath": "/b2/upload-job-sse/<jobId>",
  "files": [
    {
      "id": "test/720p/eps1.mp4",
      "name": "eps1.mp4",
      "mimeType": "video/mp4",
      "size": 1570024,
      "modifiedTime": "2026-02-28T00:00:00.000Z"
    }
  ]
}
```

Jika `encode=1`:

```json
{
  "jobId": "<jobId>",
  "ssePath": "/b2/upload-job-sse/<jobId>",
  "files": [
    {
      "id": "test/720p/eps1/index.m3u8",
      "name": "index.m3u8",
      "mimeType": "application/vnd.apple.mpegurl",
      "size": 0,
      "modifiedTime": "2026-02-28T00:00:00.000Z"
    }
  ]
}
```

---

## Progress (Polling / SSE)

Gunakan endpoint job yang sama seperti flow multipart:

- Setelah response sukses, FE bisa langsung menggunakan `jobId` atau `ssePath` dari response.

- Polling:
  - `GET /b2/upload-job/:id`
  - `GET /b2/upload-job?id=<jobId>`

- SSE:
  - `GET /b2/upload-job-sse/:id`
  - `GET /b2/upload-job-sse?id=<jobId>`

- Cancel:
  - `DELETE /b2/upload-job/:id`

---

## Alternatif: Remote upload (Server fetch) + HLS

Jika kamu ingin backend mengambil video dari URL remote lalu memprosesnya (tanpa FE upload binary), gunakan:

- **Method**: `POST`
- **Path**: `/b2/import-by-url`

Ringkasnya:

- `encode=1`:
  - stream dari URL remote → `ffmpeg` (stdin)
  - output HLS (`index.m3u8` + `.ts`) diupload ke B2
  - **tanpa re-encode** (menggunakan `ffmpeg -c copy`)
  - progress tetap lewat `jobId` + SSE yang sama (`/b2/upload-job-sse/:jobId`)
- `encode=0`:
  - stream dari URL remote → upload original ke B2

---

## Catatan penting

- Link bersifat **one-time**: token hanya bisa dipakai sekali.
- Link bisa **expired** (default 30 menit) → request ulang dengan `POST /b2/direct-upload-link`.
