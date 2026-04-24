# Multi-Rendition Encode API

Encodes a video into 4 adaptive renditions (1080p / 720p / 480p / 360p) using **NVIDIA NVENC** (with CPU fallback), outputs fMP4/HLS `.m4s` segments optimised for bad-network streaming.

---

## Output Structure

Given source B2 key: `NanimeID/DB/Otonari.../Eps.1/OnTs-01-1080p-NanimeID.mkv`

```
temp/
└── NanimeID/DB/Otonari.../Eps.1/OnTs-01-1080p-NanimeID/
    ├── master.m3u8                  ← master playlist (points to all renditions)
    ├── 1080p/
    │   ├── 1080p.m3u8
    │   ├── 1080p_init.mp4
    │   ├── 1080p_00000.m4s
    │   └── ...
    ├── 720p/
    │   ├── 720p.m3u8
    │   ├── 720p_init.mp4
    │   └── ...
    ├── 480p/
    │   └── ...
    └── 360p/
        └── ...
```

When uploaded to B2, the same structure is mirrored relative to the source file's parent directory:

```
NanimeID/DB/Otonari.../Eps.1/master.m3u8
NanimeID/DB/Otonari.../Eps.1/1080p/1080p.m3u8
NanimeID/DB/Otonari.../Eps.1/1080p/1080p_init.mp4
NanimeID/DB/Otonari.../Eps.1/1080p/1080p_00000.m4s
...
```

The master playlist at `Eps.1/master.m3u8` references:
- `1080p/1080p.m3u8`
- `720p/720p.m3u8`
- `480p/480p.m3u8`
- `360p/360p.m3u8`

---

## Rendition Specs

| Label | Resolution  | Video Bitrate | Maxrate | Audio  | Segment Duration |
|-------|-------------|---------------|---------|--------|------------------|
| 1080p | 1920×1080   | 3000 kbps     | 3500k   | 192k   | 6 s              |
| 720p  | 1280×720    | 1800 kbps     | 2200k   | 128k   | 6 s              |
| 480p  | 854×480     | 1000 kbps     | 1300k   | 128k   | 6 s              |
| 360p  | 640×360     | 500 kbps      | 700k    | 96k    | 6 s              |

- **Codec (video)**: `h264_nvenc` NVIDIA NVENC → auto-fallback `libx264` CPU
- **NVENC quality**: `vbr_hq`, CQ 19, `spatial_aq + temporal_aq` (stable bitrate, smooth seek)
- **Container**: fMP4 HLS (`.m4s` segments + `_init.mp4`) — wajib ada `_init.mp4` per rendition
- **Audio**: AAC 48 kHz stereo, `aresample=async=1` (mencegah audio glitch saat skip)
- **Segment duration**: 6 s default (configurable 1–10 s via `segmentDuration` body param)
- **GOP**: `segmentDuration × 30` frames, `-sc_threshold 0` (keyframe align per segment, no scene-cut interrupt)
- **Sync**: `-vsync 1` + `-async 1` untuk timestamp stabil
- **Aspect ratio**: preserved; black bars added if needed
- **Playlist type**: `vod` — player bisa seek langsung tanpa buffer ulang dari awal

---

## Endpoints

### `GET /encode/info`
Returns ffmpeg path, NVENC availability, rendition list, temp dir.

**Response:**
```json
{
  "nvenc": true,
  "renditions": [
    { "label": "1080p", "width": 1920, "height": 1080, "videoBitrate": "3000k" },
    ...
  ],
  "segmentDuration": 6,
  "tempRoot": "/app/temp"
}
```

---

### `POST /encode/start`
Encode only → output saved to `temp/`. **No upload to B2, original file untouched.**

**Request body (JSON):**
```json
{
  "objectKey": "NanimeID/DB/Otonari.../Eps.1/OnTs-01-1080p-NanimeID.mkv",
  "localInputPath": "/absolute/path/to/source.mkv",
  "segmentDuration": 6,
  "renditions": ["1080p", "720p", "480p", "360p"],
  "jobId": "optional-custom-id"
}
```

Or pass a URL instead of local path:
```json
{
  "objectKey": "NanimeID/DB/Otonari.../Eps.1/OnTs-01-1080p-NanimeID.mkv",
  "sourceUrl": "https://cdn-stable.nanimeid.xyz/file/NanimeID/DB/Otonari_No_Tensi_Sama_S1/Eps.1/OnTs-01-1080p-NanimeID.mkv"
}
```

**Response (immediate):**
```json
{
  "jobId": "enc_abc123_xyz",
  "ssePath": "/encode/job-sse/enc_abc123_xyz",
  "status": "queued",
  "upload_b2": false,
  "objectKey": "NanimeID/...",
  "renditions": ["1080p", "720p", "480p", "360p"],
  "segmentDuration": 6
}
```

> `upload_b2: false` is present from the very first response so the FE knows immediately this job will NOT upload to B2.
Encoding happens async. Poll `/encode/job/:id` or subscribe to SSE.

---

### `POST /encode/start-and-upload`
Encode → upload semua segments ke B2 → register di catalog → hapus temp files lokal.

Same body as `/encode/start`.

> ⚠️ **Source file di B2 TIDAK dihapus** — baik saat encode maupun saat upload selesai. File original tetap ada di B2 karena masih dipakai di production. Hanya encoded renditions baru yang diupload ke subfolder.

---

### `GET /encode/job/:id`
Get job status.

**Response:**
```json
{
  "id": "enc_abc123_xyz",
  "status": "encoding",
  "current": "720p (NVENC)",
  "done": 1,
  "total": 4,
  "percent": 35,
  "error": null,
  "updated_at_ms": 1713700000000
}
```

Status values:

| Status | Meaning |
|---|---|
| `queued` | Job accepted, not started |
| `preparing` | Setting up temp dir |
| `downloading` | Downloading source from URL |
| `encoding` | ffmpeg running |
| `uploading` | Uploading to B2 (`start-and-upload` only) |
| `done_encode_only` | ✅ Encode done, **NOT uploaded to B2** (`upload_b2: false`) |
| `partial_encode_only` | Some renditions failed, rest encoded, **NOT uploaded** |
| `done` | ✅ Encoded + uploaded to B2 (`upload_b2: true`) |
| `partial` | Some renditions failed, rest uploaded |
| `error` | All renditions failed |
| `cancelled` | Cancelled by user |

---

### `GET /encode/jobs`
List recent encode jobs (last 50).

---

### `DELETE /encode/job/:id`
Cancel a running encode job. Sends abort signal to ffmpeg.

---

### `GET /encode/job-sse/:id`
Server-Sent Events stream for real-time progress.

Events: `hello`, `update`, `not_found`, `end`, `error`

**Example (EventSource):**
```js
const es = new EventSource(`/encode/job-sse/${jobId}`);
es.addEventListener('update', (e) => {
  const job = JSON.parse(e.data);
  console.log(job.percent, job.status, job.current);
});
es.addEventListener('end', (e) => {
  const { status, upload_b2 } = JSON.parse(e.data);
  if (upload_b2 === false) {
    // encode-only: DO NOT call main API to mark as done
    console.log('Encode done, files in temp/, not uploaded.');
  } else {
    // uploaded to B2: safe to call main API callback
    callMainApiMarkDone(jobId);
  }
  es.close();
});
```

---

## Environment Variables

| Variable            | Default        | Description                                |
|---------------------|----------------|--------------------------------------------|
| `ENCODE_TEMP_DIR`   | `./temp`       | Directory for temporary encode output      |
| `ENCODE_SEGMENT_DURATION` | `6`    | HLS segment duration in seconds (1–10)     |
| `FFMPEG_PATH`       | auto-detect    | Absolute path to ffmpeg binary             |
| `FFPROBE_PATH`      | auto-detect    | Absolute path to ffprobe binary            |
| `DELETE_SOURCE_AFTER_ENCODE` | `false` | Jika `true`, hapus file source (.mkv/.mp4) dari B2 setelah encode sukses + callback ke Admin API |

---

## Frontend Integration Example

```js
// Gunakan /encode/start untuk test (tidak upload ke B2, source aman)
const res = await fetch('/encode/start', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    objectKey: 'NanimeID/DB/Otonari.../Eps.1/OnTs-01-1080p-NanimeID.mkv',
    sourceUrl: 'https://cdn-stable.nanimeid.xyz/file/NanimeID/DB/Otonari_No_Tensi_Sama_S1/Eps.1/OnTs-01-1080p-NanimeID.mkv',
  }),
});
const { jobId, ssePath, upload_b2 } = await res.json();
// upload_b2 === false → jangan callback API utama saat selesai

const es = new EventSource(ssePath);
es.addEventListener('update', (e) => {
  const { percent, status, current } = JSON.parse(e.data);
  console.log(`[${status}] ${percent}% — ${current}`);
});
es.addEventListener('end', (e) => {
  const { status, upload_b2 } = JSON.parse(e.data);
  if (upload_b2 === false) {
    // /encode/start: encode selesai, tersimpan di temp/, TIDAK upload ke B2
    // → jangan trigger callback API utama (source di B2 masih utuh)
    console.log('Encode done, files in temp/. Source B2 untouched.');
  } else {
    // /encode/start-and-upload: sudah upload ke B2
    // → aman callback API utama untuk mark as done
    callMainApiMarkDone(jobId);
  }
  es.close();
});
```

Setelah `/encode/start-and-upload` selesai, player bisa load:
```
https://cdn-stable.nanimeid.xyz/file/NanimeID/DB/Otonari.../Eps.1/master.m3u8
```

---

## Anime Encode — Wrapped Endpoint

Endpoint khusus untuk encode episode anime dari Admin Panel. **FE hanya kirim `episodeId`** — backend server ini yang:
1. Fetch detail episode (termasuk URL 1080p) dari Admin API
2. Download source 1080p ke temp lokal
3. Encode ke semua rendition (1080p → 720p → 480p → 360p)
4. Upload semua ke B2
5. **Callback ke Admin API** (`POST /admin/hls/callback/bulk`) — bukan FE yang callback

### Mekanisme Flow

```
FE Admin Panel
  │
  └─ POST /encode/anime { episodeId }
       │
       ▼
  Backend (server ini)
  ├─ 1. GET ADMIN_API_BASE/admin/hls/episodes/:episodeId
  │       → ambil source_quality URL dari quality "1080p"
  │
  ├─ 2. Download source 1080p → temp/dl-xxx/input.mkv
  │
  ├─ 3. Encode paralel → temp/DB/AnimeName/Eps.XX/
  │       1080p/ 720p/ 480p/ 360p/ + master.m3u8
  │
  ├─ 4. Upload paralel ke B2
  │       DB/AnimeName/Eps.XX/master.m3u8
  │       DB/AnimeName/Eps.XX/1080p/1080p.m3u8
  │       DB/AnimeName/Eps.XX/1080p/1080p_init.mp4
  │       DB/AnimeName/Eps.XX/1080p/1080p_00000.m4s ...
  │       (dan seterusnya untuk 720p, 480p, 360p)
  │
  ├─ 5. Hapus temp files lokal
  │
  └─ 6. POST ADMIN_API_BASE/admin/hls/callback/bulk
          {
            episode_id: 101,
            results: [
              { nama_quality: "1080p", success: true, hls_url: "https://cdn.../1080p/1080p.m3u8", metadata: {...} },
              { nama_quality: "720p",  success: true, hls_url: "...", metadata: {...} },
              { nama_quality: "480p",  success: true, hls_url: "...", metadata: {...} },
              { nama_quality: "360p",  success: true, hls_url: "...", metadata: {...} }
            ]
          }
```

> **Sumber encode**: Selalu dari quality **1080p** (`source_quality` di DB Admin). Semua rendition lain di-encode ulang dari sumber ini.  
> **Source B2 tidak dihapus** — file original tetap utuh di B2.  
> **Callback dilakukan server, bukan FE** — FE tidak perlu tahu kapan selesai, cukup subscribe SSE untuk monitoring progress.

### `POST /encode/anime`

**Request body:**
```json
{
  "episodeId": 101,
  "jobId": "optional-custom-id",
  "adminToken": "<bearer token dari session FE>"
}
```

| Field | Wajib | Deskripsi |
|---|---|---|
| `episodeId` | ✅ | ID episode dari Admin API |
| `jobId` | ❌ | Custom job ID (auto-generate jika tidak diisi) |
| `adminToken` | ✅ | Bearer token Admin API — wajib dikirim dari FE |

**Response (immediate):**
```json
{
  "jobId": "aenc_abc123_xyz",
  "ssePath": "/encode/job-sse/aenc_abc123_xyz",
  "status": "queued",
  "upload_b2": true,
  "episodeId": 101,
  "sourceUrl": "https://cdn.../source_1080p.mkv",
  "objectKey": "DB/AnimeName/Eps.01/source_1080p.mkv",
  "renditions": ["1080p", "720p", "480p", "360p"]
}
```

Job status flow: `queued` → `preparing` → `downloading` → `downloaded` → `encoding` → `uploading` → `done` / `partial` / `error`

**Cancel job:**
```
DELETE /encode/anime/job/:jobId
```

**Check status:**
```
GET /encode/anime/job/:jobId
```

**SSE monitoring** — gunakan SSE yang sama dari `/encode/job-sse/:jobId`.

### Env Vars Tambahan

| Variable | Default | Deskripsi |
|---|---|---|
| `ADMIN_API_BASE` | - | Base URL Admin API, e.g. `http://localhost:3000/2.1.0` |
| `B2_CDN_BASE` | - | CDN base URL untuk generate `hls_url`, e.g. `https://cdn-stable.nanimeid.xyz/file/NanimeID` |

### Contoh FE Admin Panel

```js
// Trigger encode dari admin panel
const res = await fetch('/encode/anime', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ episodeId: 101, adminToken: currentUserToken }),
});
const { jobId, ssePath } = await res.json();

// Monitor progress via SSE
const es = new EventSource(ssePath);
es.addEventListener('update', (e) => {
  const { status, percent, current } = JSON.parse(e.data);
  console.log(`[${status}] ${percent}% — ${current}`);
});
es.addEventListener('end', (e) => {
  const { status } = JSON.parse(e.data);
  // Server sudah otomatis callback ke Admin API
  // FE tinggal refresh data episode dari Admin API
  console.log('Encode selesai, status:', status);
  es.close();
  refreshEpisodeData(101);
});
```

---

## HLS Encode Records & Sinkronisasi

### Model `HlsEncodeRecord` (DB Lokal — `hls_encode_records`)

Setiap kali `POST /encode/anime` selesai, hasilnya otomatis disimpan ke tabel lokal ini. Untuk episode yang sudah `DONE` sebelumnya, gunakan route sync.

| Field | Tipe | Deskripsi |
|---|---|---|
| `episodeId` | Int | ID episode dari Admin API |
| `jobId` | String | ID encode job |
| `namaQuality` | String | `1080p` / `720p` / `480p` / `360p` |
| `status` | String | `done` / `error` |
| `hlsUrl` | String? | URL rendition `.m3u8` per-quality |
| `masterUrl` | String? | URL `master.m3u8` — diambil dari `episode.hls_master_url` di Admin API |
| `masterSize` | BigInt? | Ukuran total segmen HLS dalam bytes — diambil dari `quality.hls_size` di Admin API |
| `resolution` | String? | e.g. `1920x1080` |
| `bitrate` | String? | e.g. `3000k` |
| `segments` | Int? | Jumlah segment `.m4s` |
| `duration` | Float? | Durasi video (detik) |
| `encodedAt` | DateTime? | Waktu encode selesai |
| `syncedAt` | DateTime? | Waktu terakhir sinkronisasi dari Admin API |

> Unique constraint: `(episodeId, namaQuality)` — upsert aman jika encode ulang.

---

### Sync Routes

#### `POST /encode/anime/sync/bulk`

Sinkronisasi banyak episode sekaligus — ambil semua quality `DONE` dari Admin API, simpan ke `hls_encode_records` lokal.
- `masterUrl` → dari `episode.hls_master_url`; jika null, **di-derive otomatis** dari `hls_url` (strip `/{quality}/{quality}.m3u8` → tambah `master.m3u8`)
- `masterSize` → dari `quality.hls_size`; jika null, **fallback ke catalog B2** (lookup `files.filePath`)

**Body:**
```json
{
  "adminToken": "...",
  "episodeIds": [101, 102, 103]
}
```

**Response:**
```json
{
  "results": [
    { "episodeId": 101, "ok": true, "synced": 4 },
    { "episodeId": 102, "ok": true, "synced": 3 },
    { "episodeId": 103, "ok": false, "error": "Admin API 404: ..." }
  ]
}
```

---

#### `POST /encode/anime/sync/:episodeId`

Sinkronisasi satu episode. Token via `Authorization: Bearer <token>` header atau body `adminToken`.

**Response:**
```json
{
  "episodeId": 101,
  "synced": 4,
  "message": "Berhasil sinkronisasi 4 quality",
  "results": [
    {
      "namaQuality": "1080p",
      "hlsUrl": "https://cdn.../1080p/1080p.m3u8",
      "masterUrl": "https://cdn.../master.m3u8",
      "masterSize": 524288000
    }
  ],
  "records": [ ...semua record episode... ]
}
```

> **Fallback otomatis:**
> - `masterUrl` null → di-derive dari `hls_url` pertama yang ada: strip `/{quality}/{quality}.m3u8`, tambah `/master.m3u8`
> - `masterSize` null → lookup dari catalog B2 (`files` table) berdasarkan `filePath` = URL tanpa CDN base

---

#### `GET /encode/anime/records`

List semua record encode. Query params: `status` (`done`/`error`), `page`, `limit`.

---

#### `GET /encode/anime/records/:episodeId`

Semua record untuk satu episode.

**Response:**
```json
{
  "episodeId": 101,
  "records": [
    {
      "id": 1,
      "episodeId": 101,
      "namaQuality": "1080p",
      "status": "done",
      "hlsUrl": "https://cdn.../1080p/1080p.m3u8",
      "masterUrl": "https://cdn.../master.m3u8",
      "masterSize": 2048,
      "resolution": "1920x1080",
      "bitrate": "3000k",
      "segments": 10,
      "duration": 1440.0,
      "encodedAt": "2026-04-21T07:00:00.000Z",
      "syncedAt": "2026-04-21T07:05:00.000Z"
    }
  ]
}
```

---

#### `POST /encode/anime/records/:episodeId/refresh-size`

Re-sync `masterUrl` dan `masterSize` untuk semua quality episode dari Admin API. Token wajib.

**Body/Header:** `adminToken` atau `Authorization: Bearer <token>`

**Response:**
```json
{
  "episodeId": 101,
  "masterUrl": "https://cdn.../master.m3u8",
  "updated": [
    { "namaQuality": "1080p", "masterSize": 524288000 },
    { "namaQuality": "720p",  "masterSize": 314572800 }
  ]
}
```

---

### Flow Sinkronisasi Episode Lama

Untuk episode yang sudah di-encode sebelum sistem ini ada:

```
POST /encode/anime/sync/bulk
{ "adminToken": "...", "episodeIds": [101, 102, ...] }
```

Server: fetch Admin API → ambil quality `DONE` → resolve `masterUrl` (Admin API atau derive dari `hls_url`) → resolve `masterSize` (Admin API atau catalog B2) → upsert `hls_encode_records` → `syncedAt = now()`.

---

## HLS Delete Routes

### `DELETE /encode/anime/hls/file`

Hapus **satu file** dari B2 berdasarkan CDN URL.

**Body:**
```json
{ "url": "https://cdn-stable.nanimeid.xyz/file/NanimeID/DB/.../1080p/seg001.m4s" }
```

**Response:**
```json
{ "success": true, "deleted": "DB/.../1080p/seg001.m4s" }
```

---

### `DELETE /encode/anime/hls/prefix`

Hapus **semua file** di bawah prefix folder tertentu dari B2 + catalog lokal. Berguna untuk hapus satu quality folder.

**Body (pilih salah satu):**
```json
{ "prefix": "DB/anime_37/Eps.03/1080p/" }
```
atau
```json
{ "url": "https://cdn-stable.nanimeid.xyz/file/NanimeID/DB/anime_37/Eps.03/1080p/1080p.m3u8" }
```
> Jika `url` dikirim tanpa `prefix`, prefix akan di-derive otomatis dari URL (strip filename, ambil folder).

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

### `DELETE /encode/anime/hls/episode/:episodeId`

Hapus HLS **semua quality** (atau quality tertentu) dari satu episode — hapus semua file di folder quality dari B2, hapus dari catalog lokal, dan hapus `hls_encode_records` lokal.

**Body (opsional):**
```json
{ "qualities": ["1080p", "720p"] }
```
> Jika `qualities` tidak dikirim atau kosong, **semua quality** dari episode akan dihapus.

**Response:**
```json
{
  "episodeId": 202,
  "results": [
    { "namaQuality": "1080p", "deletedCount": 192, "failedCount": 0, "failed": [] },
    { "namaQuality": "720p",  "deletedCount": 192, "failedCount": 0, "failed": [] },
    { "namaQuality": "480p",  "deletedCount": 192, "failedCount": 0, "failed": [] },
    { "namaQuality": "360p",  "deletedCount": 192, "failedCount": 0, "failed": [] }
  ]
}
```

> **Catatan:** Route ini hanya menghapus file HLS (segments + playlist). File source `.mkv` di B2 **tidak ikut dihapus**.

---

## Notes

- **NVENC** auto-detected. Fallback ke `libx264` CPU jika GPU tidak tersedia.
- **Segments 6 detik** fMP4 (`.m4s`) + `_init.mp4` wajib per rendition — tanpa init tidak bisa diplay.
- **Source file di B2 tidak pernah dihapus** — baik oleh `/encode/start` maupun `/encode/start-and-upload`. File original tetap ada dan tetap bisa diakses di production.
- `/encode/start` — **aman untuk testing**: encode saja, output ke `temp/`, tidak ada yang diupload atau dihapus di B2.
- `/encode/start-and-upload` — upload renditions ke B2, hapus temp lokal setelah sukses. Source B2 tetap utuh.
- `upload_b2: false` di response/SSE = sinyal ke FE untuk **tidak** memanggil callback API utama.
- GOP di-align per segment (keyframe tiap awal segment) → seek halus tanpa freeze.
- Audio `aresample=async=1` + `-async 1` → tidak ada audio glitch saat skip.
