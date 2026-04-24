# Admin Panel — Encode & HLS Management Guide

Panduan ini khusus untuk integrasi **Admin Panel** dengan backend encoder. Mencakup cara trigger encode, monitoring, sinkronisasi data, dan hapus HLS.

---

## Base URL

```
http://localhost:4000
```

---

## Flow Umum

```
Admin Panel
  │
  ├─ 1. Trigger encode episode   →  POST /encode/anime
  ├─ 2. Monitor progress (SSE)   →  GET  /encode/job-sse/:jobId
  ├─ 3. Cek status job           →  GET  /encode/anime/job/:jobId
  ├─ 4. Cancel job (opsional)    →  DELETE /encode/anime/job/:jobId
  │
  ├─ 5. Sinkronisasi data lama   →  POST /encode/anime/sync/:episodeId
  │      (untuk episode yang sudah DONE sebelum sistem ini)
  │
  ├─ 6. Lihat records lokal      →  GET  /encode/anime/records/:episodeId
  │
  └─ 7. Hapus HLS episode        →  DELETE /encode/anime/hls/episode/:episodeId
```

---

## 1. Trigger Encode Episode

**`POST /encode/anime`**

Mulai encode episode dari sumber yang ada di Admin API. Backend akan:
1. Ambil data episode dari Admin API
2. Download source file tertinggi yang tersedia (1080p → 720p → 480p → 360p)
3. Encode ke semua rendition ≤ source quality
4. Upload HLS segments ke B2
5. Callback otomatis ke Admin API dengan `hls_url`, `hls_master_url`, `hls_size`, `metadata`

### Catatan Penting: Hapus Source File

Jika environment variable `DELETE_SOURCE_AFTER_ENCODE=true`:

1. Callback ke Admin API akan kirim `source_quality: null` (URL di-clear)
2. **File source (.mkv/.mp4) akan dihapus dari B2** setelah encode sukses
3. Entry di catalog lokal juga dihapus
4. Hanya berlaku jika encode status = `done` (semua rendition sukses)

> **Warning:** Setelah dihapus, file source tidak bisa dikembalikan. Pastikan HLS sudah benar-benar berfungsi sebelum enable.

### Request Body

```json
{
  "episodeId": 202,
  "adminToken": "eyJhbGci..."
}
```

| Field | Wajib | Deskripsi |
|-------|-------|-----------|
| `episodeId` | ✅ | ID episode dari Admin API |
| `adminToken` | ✅ | JWT token Admin — dikirim dari FE, tidak disimpan di env |

### Response (200) — Job dimulai

```json
{
  "jobId": "aenc_mo9ezoo2_do4yd3",
  "ssePath": "/encode/job-sse/aenc_mo9ezoo2_do4yd3",
  "status": "queued",
  "episodeId": 202,
  "sourceUrl": "https://cdn-stable.nanimeid.xyz/file/NanimeID/DB/.../source_1080p.mkv"
}
```

> **Source selection:** Jika 1080p tidak ada, otomatis fallback ke 720p, dst. Rendition yang di-encode hanya yang ≤ source quality.

---

## 2. Monitor Progress (SSE)

**`GET /encode/job-sse/:jobId`**

Stream real-time progress encode via Server-Sent Events.

### Contoh (JavaScript)

```js
const es = new EventSource(`http://localhost:4000/encode/job-sse/${jobId}`);

es.onmessage = (e) => {
  const data = JSON.parse(e.data);
  console.log(data);
  // { status: 'encoding', percent: 45, current: '720p', done: 1, total: 4 }

  if (data.status === 'done' || data.status === 'error') {
    es.close();
  }
};
```

### Status Values

| Status | Deskripsi |
|--------|-----------|
| `queued` | Job antri, belum mulai |
| `preparing` | Persiapan |
| `downloading` | Download source dari B2 |
| `downloaded` | Download selesai |
| `encoding` | Sedang encode renditions |
| `uploading` | Upload HLS ke B2 |
| `done` | Selesai, callback sudah dikirim ke Admin API |
| `partial` | Sebagian quality gagal |
| `error` | Gagal semua |
| `cancelled` | Di-cancel oleh user |

### SSE Event Data

```json
{
  "status": "encoding",
  "percent": 60,
  "current": "480p",
  "done": 2,
  "total": 4,
  "error": null
}
```

---

## 3. Cek Status Job

**`GET /encode/anime/job/:jobId`**

```json
{
  "id": "aenc_mo9ezoo2_do4yd3",
  "status": "done",
  "percent": 100,
  "done": 4,
  "total": 4,
  "error": null
}
```

---

## 4. Cancel Job

**`DELETE /encode/anime/job/:jobId`**

Hentikan encode yang sedang berjalan.

```json
{ "cancelled": true, "jobId": "aenc_mo9ezoo2_do4yd3" }
```

---

## 5. Sinkronisasi Episode Lama

Untuk episode yang sudah di-encode **sebelum sistem ini ada** (data HLS sudah ada di Admin API tapi belum tersimpan di DB lokal).

### Single Episode

**`POST /encode/anime/sync/:episodeId`**

```json
{ "adminToken": "eyJhbGci..." }
```

**Response:**
```json
{
  "episodeId": 202,
  "synced": 4,
  "message": "Berhasil sinkronisasi 4 quality",
  "results": [
    {
      "namaQuality": "1080p",
      "hlsUrl": "https://cdn.../1080p/1080p.m3u8",
      "masterUrl": "https://cdn.../master.m3u8",
      "masterSize": 452501789,
      "resolution": "1920x1080",
      "bitrate": "3000k",
      "segments": 190
    }
  ],
  "records": [ ... ]
}
```

> Sync juga otomatis **callback ke Admin API** untuk update `hls_master_url`, `hls_size`, dan `metadata` yang sebelumnya null.

### Bulk (Banyak Episode Sekaligus)

**`POST /encode/anime/sync/bulk`**

```json
{
  "adminToken": "eyJhbGci...",
  "episodeIds": [201, 202, 203]
}
```

**Response:**
```json
{
  "results": [
    { "episodeId": 201, "ok": true, "synced": 4 },
    { "episodeId": 202, "ok": true, "synced": 3 },
    { "episodeId": 203, "ok": false, "error": "Admin API 404: ..." }
  ]
}
```

### Fallback Otomatis saat Sync

Jika data di Admin API null (episode lama):

| Field | Fallback |
|-------|----------|
| `hls_master_url` | Di-derive dari `hls_url`: strip `/{quality}/{quality}.m3u8` → tambah `/master.m3u8` |
| `hls_size` | Sum semua file di folder quality dari catalog B2 lokal |
| `resolution` | Dari spec rendition (`1920x1080`, `1280x720`, dll) |
| `bitrate` | Dari spec rendition (`3000k`, `1800k`, dll) |
| `segments` | Count file `.m4s` di catalog B2 |

---

## 6. Lihat Records Lokal

### Semua Records

**`GET /encode/anime/records`**

Query params: `status` (`done`/`error`), `page`, `limit`

### Per Episode

**`GET /encode/anime/records/:episodeId`**

```json
[
  {
    "id": 1,
    "episodeId": 202,
    "namaQuality": "1080p",
    "status": "done",
    "hlsUrl": "https://cdn.../1080p/1080p.m3u8",
    "masterUrl": "https://cdn.../master.m3u8",
    "masterSize": 452501789,
    "masterSizeFormatted": "431.58 MB",
    "resolution": "1920x1080",
    "bitrate": "3000k",
    "segments": 190,
    "duration": 1418.6,
    "encodedAt": "2026-04-21T00:30:04.242Z",
    "syncedAt": "2026-04-22T03:01:53.033Z"
  }
]
```

---

## 7. Auto Encode Anime Populer (Background Job)

Job background yang secara otomatis mengambil anime populer dari Admin API dan encode episode yang masih pending.

### Environment Variables

| Variable | Default | Deskripsi |
|----------|---------|-----------|
| `ENABLE_POPULAR_ENCODE_JOB` | `false` | Enable/disable job otomatis |
| `POPULAR_ENCODE_INTERVAL_MS` | `300000` (5 menit) | Interval pengecekan dalam ms |
| `POPULAR_ENCODE_FETCH_ALL` | `true` | `true` = ambil semua anime via pagination, `false` = hanya `limit` anime |
| `POPULAR_ENCODE_LIMIT` | `20` | Batch size per request (jika `fetchAll=true`, ini adalah page size) |
| `POPULAR_ENCODE_DAILY_LIMIT` | `20` | Maksimal anime yang di-encode per hari (tracking di DB) |
| `ADMIN_API_TOKEN` | - | Bearer token untuk autentikasi ke Admin API (background job) |

### Setup Database (Migration)

**WAJIB** jalankan migration untuk membuat tabel tracking:

```bash
# Jalankan migrate script (otomatis)
npm run migrate:popular:encode

# Atau manual step-by-step:
npx prisma generate
npx prisma db push
npx prisma migrate dev --name add_popular_encode_progress
```

Jika error, cek:
- `DATABASE_URL` di `.env` sudah benar
- PostgreSQL server running
- Prisma CLI terinstall: `npm install`

### Database Tracking

Progress tersimpan di tabel `PopularEncodeProgress`:

| Field | Deskripsi |
|-------|-----------|
| `dateKey` | Tanggal (YYYY-MM-DD) |
| `animeEncoded` | Jumlah anime yang sudah di-encode hari ini |
| `lastAnimeId` | ID anime terakhir yang diproses |
| `lastEpisodeId` | ID episode terakhir yang diproses |
| `lastEpisodeNumber` | Nomor episode terakhir |
| `completed` | Apakah daily limit sudah tercapai |
| `errorCount` | Jumlah error hari ini |

Jika job gagal/crash, saat restart akan **resume dari anime/episode terakhir** yang tersimpan di DB.

### Reset Daily Limit (Manual)

Jika daily limit tercapai tapi Anda ingin melanjutkan encoding, atau ingin reset karena banyak error/skips:

```bash
# Reset via npm script
npm run reset:daily:limit

# Windows PowerShell
npm run reset:daily:limit:win

# Atau langsung
node utils/reset-daily-limit.js
```

Script ini akan:
- Reset counter `animeEncoded` ke 0
- Reset `completed` ke false
- Clear `lastAnimeId`, `lastEpisodeId`, `lastEpisodeNumber`
- Reset `errorCount` ke 0

> **Catatan:** Gunakan dengan bijak. Daily limit ada untuk mencegah overload server.

### Routes Kontrol

#### Start Job
**`POST /encode/anime/popular/start`**

```json
{
  "success": true,
  "message": "Popular encode job started",
  "status": {
    "running": true,
    "cycleRunning": false,
    "enabled": true,
    "intervalMs": 300000,
    "dailyLimit": 20,
    "dailyProgress": {
      "encodedToday": 5,
      "remaining": 15,
      "completed": false
    }
  }
}
```

#### Stop Job
**`POST /encode/anime/popular/stop`**

```json
{
  "success": true,
  "message": "Popular encode job stopped",
  "status": { "running": false, ... }
}
```

#### Status Job
**`GET /encode/anime/popular/status`**

```json
{
  "status": {
    "running": true,
    "cycleRunning": false,
    "enabled": true,
    "intervalMs": 300000
  }
}
```

### Flow Job

```
Setiap 5 menit (default):
  ↓
Fetch /admin/hls/popular?hlsStatus=PENDING
  - Jika POPULAR_ENCODE_FETCH_ALL=true: pagination sampai habis (semua anime)
  - Jika false: hanya POPULAR_ENCODE_LIMIT anime pertama
  ↓
Untuk setiap episode dengan quality PENDING/FAILED:
  - Skip jika sudah ada job running
  - Trigger POST /encode/anime (encode otomatis)
  - Delay 2 detik antar episode
```

### Log

```
[popularEncode] Starting cycle...
[popularEncode] Triggering encode for episode 202 (Attack on Titan Ep.3)
[popularEncode] Episode 202 encode started: jobId=aenc_xxx
[popularEncode] Cycle complete: encoded=3, skipped=5, errors=0
```

---

## 8. Hapus HLS

### Hapus Satu File

**`DELETE /encode/anime/hls/file`**

```json
{ "url": "https://cdn-stable.nanimeid.xyz/file/NanimeID/DB/.../1080p/seg001.m4s" }
```

**Response:**
```json
{ "success": true, "deleted": "DB/.../1080p/seg001.m4s" }
```

---

### Hapus Semua File di Folder (Prefix)

**`DELETE /encode/anime/hls/prefix`**

Kirim `prefix` atau `url` (URL mana saja dalam folder):

```json
{ "prefix": "DB/anime_37/Eps.03/1080p/" }
```
atau
```json
{ "url": "https://cdn-stable.nanimeid.xyz/file/NanimeID/DB/anime_37/Eps.03/1080p/1080p.m3u8" }
```

**Response:**
```json
{
  "success": true,
  "prefix": "DB/anime_37/Eps.03/1080p/",
  "deletedCount": 192,
  "failedCount": 0,
  "deleted": ["DB/anime_37/Eps.03/1080p/_init.mp4", "..."],
  "failed": []
}
```

---

### Hapus HLS Semua Quality dari Episode

**`DELETE /encode/anime/hls/episode/:episodeId`**

Body opsional — jika tidak dikirim, semua quality dihapus:

```json
{ "qualities": ["1080p", "720p"] }
```

**Response:**
```json
{
  "episodeId": 202,
  "results": [
    { "namaQuality": "1080p", "deletedCount": 192, "failedCount": 0, "failed": [] },
    { "namaQuality": "720p",  "deletedCount": 192, "failedCount": 0, "failed": [] }
  ]
}
```

> **Catatan:**
> - Menghapus semua segment + playlist dari B2
> - Menghapus dari catalog B2 lokal
> - Menghapus `hls_encode_records` lokal
> - **Source `.mkv` di B2 tidak ikut dihapus**

---

## Ringkasan Endpoint

| Method | Endpoint | Deskripsi |
|--------|----------|-----------|
| `POST` | `/encode/anime` | Trigger encode episode |
| `GET` | `/encode/job-sse/:jobId` | Monitor SSE progress |
| `GET` | `/encode/anime/job/:jobId` | Status job |
| `DELETE` | `/encode/anime/job/:jobId` | Cancel job |
| `POST` | `/encode/anime/sync/:episodeId` | Sync 1 episode dari Admin API |
| `POST` | `/encode/anime/sync/bulk` | Sync banyak episode sekaligus |
| `GET` | `/encode/anime/records` | List semua records lokal |
| `GET` | `/encode/anime/records/:episodeId` | Records per episode |
| `DELETE` | `/encode/anime/hls/file` | Hapus 1 file HLS |
| `DELETE` | `/encode/anime/hls/prefix` | Hapus semua file di folder |
| `DELETE` | `/encode/anime/hls/episode/:episodeId` | Hapus HLS semua/sebagian quality episode |
| `POST` | `/encode/anime/popular/start` | Start background job auto-encode |
| `POST` | `/encode/anime/popular/stop` | Stop background job |
| `GET` | `/encode/anime/popular/status` | Status background job |
