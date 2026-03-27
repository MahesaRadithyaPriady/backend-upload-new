# B2 Upload Status / Progress API

Dokumen ini menjelaskan endpoint untuk membaca **status job upload / encode** yang dipakai oleh flow berikut:

- upload folder multipart
- import by URL
- direct upload link
- flow upload lain yang mengembalikan `jobId`

Endpoint ini berguna untuk frontend yang ingin:

- fetch status setelah upload berhasil
- polling progress encode/upload
- subscribe live update via SSE
- menampilkan daftar job aktif

Khusus untuk flow upload multipart dengan `encode=1`, FE sebaiknya membuat `jobId` sendiri sejak awal request lalu langsung subscribe ke SSE memakai `jobId` tersebut.
Dengan cara ini FE bisa melihat status `receiving` lalu `encoding` **tanpa menunggu response upload selesai**.

---

## Ringkasan endpoint

- **GET** `/b2/upload-job/:id`
- **GET** `/b2/upload-job?id=<jobId>`
- **GET** `/b2/upload-job-by-prefix?prefix=<prefix>`
- **GET** `/b2/upload-jobs?active=1&limit=50`
- **GET** `/b2/upload-job-sse/:id`
- **GET** `/b2/upload-job-sse?id=<jobId>`
- **GET** `/b2/upload-job-sse?prefix=<prefix>`
- **GET** `/b2/upload-jobs-sse?active=1&limit=50`
- **DELETE** `/b2/upload-job/:id`
- **DELETE** `/b2/upload-job?id=<jobId>`

---

## Alur yang disarankan untuk multipart + encode

Contoh kasus:

- `POST /b2/upload-folder-multipart?prefix=Kira%2FTest&encode=1&jobId=<jobId>`

Alur FE yang disarankan:

1. FE generate `jobId` sendiri.
2. FE mulai subscribe ke `/b2/upload-job-sse/:jobId`.
3. FE kirim request upload multipart sambil menyertakan `jobId`.
4. Backend membuat row job sejak awal request masuk.
5. FE akan menerima update status seperti:
   - `receiving`
   - `encoding`
   - `uploading`
   - `done` / `partial` / `error`

Catatan:

- Pada request multipart, response JSON memang baru diterima setelah body upload selesai terkirim.
- Karena itu, untuk tracking realtime encode, **jangan menunggu response upload**. Gunakan `jobId` yang sudah diketahui FE dari awal.

---

## Bentuk data job

Response job memakai row dari database `upload_jobs`.

Contoh:

```json
{
  "id": "custom_job_123",
  "prefix": "Anime/Episode",
  "status": "encoding",
  "current": "Anime/Episode/eps1.mp4",
  "done": 0,
  "total": 1,
  "percent": 23,
  "error": null,
  "created_at_ms": 1711270000000,
  "updated_at_ms": 1711270005234
}
```

### Penjelasan field

- `id`
  - ID job.
  - Sama dengan `jobId` yang dikembalikan endpoint upload.

- `prefix`
  - Prefix job jika tersedia.
  - Bisa dipakai untuk lookup via `/b2/upload-job-by-prefix`.

- `status`
  - Status proses saat ini.
  - Contoh yang umum:
    - `waiting_upload`
    - `receiving`
    - `downloading`
    - `encoding`
    - `uploading`
    - `done`
    - `partial`
    - `error`
    - `cancelled`

- `current`
  - File/object yang sedang diproses.

- `done`
  - Jumlah item selesai.

- `total`
  - Total item dalam job.

- `percent`
  - Persentase keseluruhan job.
  - Saat encode aktif, progress realtime ikut bergerak di sini.

- `error`
  - Pesan error jika job gagal.

- `created_at_ms`, `updated_at_ms`
  - Timestamp dalam milisecond.

---

## 1) Get job by id

### Endpoint

- **Method**: `GET`
- **URL**: `/b2/upload-job/:id`

atau

- **Method**: `GET`
- **URL**: `/b2/upload-job?id=<jobId>`

### Response sukses (200)

```json
{
  "id": "custom_job_123",
  "prefix": "Anime/Episode",
  "status": "uploading",
  "current": "Anime/Episode/eps1/index.m3u8",
  "done": 1,
  "total": 1,
  "percent": 78,
  "error": null,
  "created_at_ms": 1711270000000,
  "updated_at_ms": 1711270005234
}
```

### Error

- `400` jika `id` tidak dikirim
- `404` jika job tidak ditemukan

---

## 2) Get job by prefix

### Endpoint

- **Method**: `GET`
- **URL**: `/b2/upload-job-by-prefix?prefix=<prefix>`

### Query params

- `prefix` (wajib)
  - Prefix folder/path job.
  - Backend akan menormalisasi path ini.

### Response sukses (200)

Sama seperti format job tunggal.

### Error

- `400` jika `prefix` tidak dikirim
- `404` jika job tidak ditemukan

---

## 3) List jobs

### Endpoint

- **Method**: `GET`
- **URL**: `/b2/upload-jobs`

### Query params

- `active` (opsional)
  - `1` / `true` / `yes` → hanya job aktif
  - jika kosong → semua job

- `limit` (opsional)
  - default `50`
  - maksimum `200`

### Contoh

```bash
GET /b2/upload-jobs?active=1&limit=20
```

### Response sukses (200)

```json
{
  "jobs": [
    {
      "id": "job_1",
      "prefix": "Anime/A",
      "status": "encoding",
      "current": "Anime/A/eps1.mp4",
      "done": 0,
      "total": 1,
      "percent": 31,
      "error": null,
      "created_at_ms": 1711270000000,
      "updated_at_ms": 1711270005234
    }
  ]
}
```

---

## 4) SSE single job

### Endpoint

- **Method**: `GET`
- **URL**: `/b2/upload-job-sse/:id`

atau

- **Method**: `GET`
- **URL**: `/b2/upload-job-sse?id=<jobId>`

atau

- **Method**: `GET`
- **URL**: `/b2/upload-job-sse?prefix=<prefix>`

### Tujuan

Untuk mendapatkan update realtime satu job tertentu.

### Event yang dikirim

- `hello`
- `update`
- `not_found`
- `end`
- `error`

### Bentuk event

#### `hello`

```json
{
  "ok": true,
  "id": "custom_job_123",
  "prefix": null
}
```

#### `update`

Payload = object job terbaru.

```json
{
  "id": "custom_job_123",
  "prefix": "Anime/Episode",
  "status": "encoding",
  "current": "Anime/Episode/eps1.mp4",
  "done": 0,
  "total": 1,
  "percent": 42,
  "error": null,
  "created_at_ms": 1711270000000,
  "updated_at_ms": 1711270008234
}
```

#### `not_found`

```json
{
  "error": "Job not found yet"
}
```

#### `end`

```json
{
  "status": "done"
}
```

### Perilaku penting

- Koneksi akan ditutup otomatis saat status job menjadi:
  - `done`
  - `error`
  - `partial`
- Untuk status `cancelled`, FE sebaiknya tetap handle `update` terakhir lalu menutup koneksi sendiri jika perlu.

### Contoh FE

```js
const es = new EventSource(`/b2/upload-job-sse/${encodeURIComponent(jobId)}`);

es.addEventListener('update', (ev) => {
  const job = JSON.parse(ev.data);
  console.log('progress', job.percent, job.status, job.current);
});

es.addEventListener('end', (ev) => {
  const data = JSON.parse(ev.data);
  console.log('job end', data.status);
  es.close();
});

es.addEventListener('error', () => {
  // reconnect jika perlu
});
```

---

## 5) SSE all jobs

### Endpoint

- **Method**: `GET`
- **URL**: `/b2/upload-jobs-sse`

### Query params

- `active` (opsional)
  - `1` / `true` / `yes` → hanya job aktif

- `limit` (opsional)
  - default `50`

### Tujuan

Untuk dashboard / halaman admin yang ingin melihat daftar banyak job secara realtime.

### Event yang dikirim

- `hello`
- `update`
- `error`

### Bentuk event

#### `hello`

```json
{
  "ok": true,
  "activeOnly": true,
  "limit": 20
}
```

#### `update`

```json
{
  "jobs": [
    {
      "id": "job_1",
      "prefix": "Anime/A",
      "status": "uploading",
      "current": "Anime/A/eps1/index.m3u8",
      "done": 1,
      "total": 1,
      "percent": 78,
      "error": null,
      "created_at_ms": 1711270000000,
      "updated_at_ms": 1711270005234
    }
  ]
}
```

### Contoh FE

```js
const es = new EventSource('/b2/upload-jobs-sse?active=1&limit=20');

es.addEventListener('update', (ev) => {
  const data = JSON.parse(ev.data);
  console.log('jobs', data.jobs);
});
```

---

## 6) Cancel job

### Endpoint

- **Method**: `DELETE`
- **URL**: `/b2/upload-job/:id`

atau

- **Method**: `DELETE`
- **URL**: `/b2/upload-job?id=<jobId>`

### Response sukses (200)

```json
{
  "ok": true
}
```

### Catatan

- Jika job sedang encode, backend akan mencoba menghentikan proses `ffmpeg`.
- Setelah cancel, row job bisa ikut dihapus dari penyimpanan job.

---

## Alur FE yang disarankan

### Opsi 1: pakai response upload

Jika endpoint upload mengembalikan:

```json
{
  "jobId": "custom_job_123",
  "ssePath": "/b2/upload-job-sse/custom_job_123"
}
```

Maka FE bisa langsung:

- fetch `GET /b2/upload-job/custom_job_123`, atau
- subscribe `EventSource` ke `/b2/upload-job-sse/custom_job_123`

### Opsi 2: pakai prefix

Jika FE lebih nyaman berdasarkan folder/prefix:

- `GET /b2/upload-job-by-prefix?prefix=<prefix>`
- `GET /b2/upload-job-sse?prefix=<prefix>`

---

## Catatan penting

- Endpoint status ini membaca data dari penyimpanan job backend.
- `percent` adalah progress keseluruhan job, bukan progress byte upload murni.
- Saat encode aktif, `percent` akan berubah realtime mengikuti proses encode lalu lanjut ke fase upload.
- Untuk browser, SSE lebih cocok daripada polling jika ingin progress realtime di halaman upload.
