  # Admin HLS Encode API Documentation

  Dokumentasi endpoint Admin untuk mengelola proses konversi video episode ke format **HLS (HTTP Live Streaming)** multi-quality adaptive.

  > **Catatan penting:** Upload dan proses encode **tidak** dilakukan di sini. Backend hanya menyediakan:
  > 1. Data episode + quality yang perlu di-encode
  > 2. Endpoint callback untuk encoder eksternal melaporkan hasil encode
  > 3. Update otomatis `hls_url` ke quality yang sudah selesai

  ---

  ## Base URL
  `/2.1.0/admin/hls`

  ## Permission
  - **Permission:** `manga-admin`
  - Semua endpoint butuh `Authorization: Bearer <admin_token>`

  ---

  ## Flow Encode HLS

  ```
  Admin Panel (FE)
    │
    ├─ 1. GET /hls/popular?limit=20       → anime populer yang perlu di-encode (prioritas by view count)
    ├─ 2. GET /hls/episodes?animeId=&q=  → cari anime/episode
    ├─ 3. GET /hls/episodes/:episodeId   → lihat quality & status encode
    ├─ 4. PATCH /hls/episodes/:id/qualities/:quality/processing  → tandai mulai encode
    │
    │  [FE/Encoder eksternal mulai encode + upload ke B2]
    │
    └─ 5. POST /hls/callback             → encoder callback setelah selesai upload ke B2
          (otomatis update hls_url, hls_status=DONE)
  ```

  ---

  ## HLS Status

  | Status | Deskripsi |
  |--------|-----------|
  | `PENDING` | Belum pernah di-encode |
  | `PROCESSING` | Sedang di-encode / upload ke B2 |
  | `DONE` | Selesai, `hls_url` tersedia |
  | `FAILED` | Gagal encode, ada `hls_error` |
  | `SKIPPED` | Sengaja di-skip oleh admin |

  ---

  ## Quality yang Didukung

  `1080p`, `720p`, `480p`, `360p`

  ---

  ## Endpoints

  ---

  ### 1. HLS Encode Stats

  **GET** `/v1/admin/hls/stats`

  Statistik progress encode keseluruhan.

  #### Response (200)
  ```json
  {
    "success": true,
    "message": "OK",
    "data": {
      "total": 1200,
      "by_status": {
        "PENDING": 800,
        "PROCESSING": 5,
        "DONE": 380,
        "FAILED": 10,
        "SKIPPED": 5
      },
      "completion_rate": 31.67
    }
  }
  ```

  ---

  ### 2. Search Episodes + Quality Status

  **GET** `/v1/admin/hls/episodes`

  Mencari episode beserta semua quality dan HLS status masing-masing.

  #### Query Parameters

  | Param | Type | Default | Deskripsi |
  |-------|------|---------|-----------|
  | `q` | string | - | Keyword cari nama anime atau judul episode |
  | `animeId` | number | - | Filter by ID anime |
  | `episodeNumber` | number | - | Filter by nomor episode |
  | `hlsStatus` | string | - | Filter by status (`PENDING`, `PROCESSING`, `DONE`, `FAILED`, `SKIPPED`) |
  | `page` | number | 1 | Halaman |
  | `limit` | number | 20 | Jumlah hasil (max 100) |

  #### Contoh Request
  ```
  GET /v1/admin/hls/episodes?q=naruto&hlsStatus=PENDING&page=1&limit=20
  GET /v1/admin/hls/episodes?animeId=5&episodeNumber=3
  ```

  #### Response (200)
  ```json
  {
    "success": true,
    "message": "OK",
    "data": {
      "page": 1,
      "limit": 20,
      "total": 45,
      "totalPages": 3,
      "items": [
        {
          "id": 101,
          "nomor_episode": 3,
          "judul_episode": "Episode 3",
          "thumbnail_episode": "https://cdn.example.com/ep3.jpg",
          "durasi_episode": 1440,
          "tanggal_rilis_episode": "2025-01-10T00:00:00.000Z",
          "anime": {
            "id": 5,
            "judul_anime": "Naruto",
            "thumbnail_anime": "https://cdn.example.com/naruto.jpg",
            "content_type": "ANIME"
          },
          "qualities": [
            {
              "id": 201,
              "nama_quality": "1080p",
              "source_quality": "https://cdn.example.com/naruto_ep3_1080p.mp4",
              "hls_status": "DONE",
              "hls_url": "https://cdn.example.com/hls/naruto_ep3_1080p/index.m3u8",
              "hls_encoded_at": "2025-01-11T10:00:00.000Z",
              "hls_error": null,
              "hls_job_id": "job_abc123",
              "createdAt": "2025-01-10T00:00:00.000Z",
              "updatedAt": "2025-01-11T10:00:00.000Z"
            },
            {
              "id": 202,
              "nama_quality": "720p",
              "source_quality": "https://cdn.example.com/naruto_ep3_720p.mp4",
              "hls_status": "PENDING",
              "hls_url": null,
              "hls_encoded_at": null,
              "hls_error": null,
              "hls_job_id": null,
              "createdAt": "2025-01-10T00:00:00.000Z",
              "updatedAt": "2025-01-10T00:00:00.000Z"
            }
          ],
          "hls_summary": {
            "total": 4,
            "done": 1,
            "pending": 3,
            "processing": 0,
            "failed": 0,
            "skipped": 0,
            "all_done": false
          }
        }
      ]
    }
  }
  ```

  ---

  ### 3. List Episodes Pending Encode

  **GET** `/v1/admin/hls/episodes/pending`

  Shortcut untuk melihat episode yang punya setidaknya 1 quality masih `PENDING`.

  #### Query Parameters

  | Param | Type | Default | Deskripsi |
  |-------|------|---------|-----------|
  | `page` | number | 1 | Halaman |
  | `limit` | number | 20 | Jumlah (max 100) |

  #### Response (200)
  Sama dengan format search episodes di atas.

  ---

  ### 4. Detail Episode & Quality

  **GET** `/v1/admin/hls/episodes/:episodeId`

  Mengambil detail lengkap satu episode beserta semua quality dan HLS metadata-nya.

  #### Path Parameter
  | Param | Type | Deskripsi |
  |-------|------|-----------|
  | `episodeId` | number | ID episode |

  #### Response (200)
  ```json
  {
    "success": true,
    "message": "OK",
    "data": {
      "id": 101,
      "nomor_episode": 3,
      "judul_episode": "Episode 3",
      "thumbnail_episode": "https://cdn.example.com/ep3.jpg",
      "durasi_episode": 1440,
      "tanggal_rilis_episode": "2025-01-10T00:00:00.000Z",
      "anime": { "id": 5, "judul_anime": "Naruto", ... },
      "qualities": [
        {
          "id": 201,
          "nama_quality": "1080p",
          "source_quality": "https://...",
          "hls_status": "DONE",
          "hls_url": "https://cdn.example.com/hls/naruto_ep3_1080p/index.m3u8",
          "hls_encoded_at": "2025-01-11T10:00:00.000Z",
          "hls_error": null,
          "hls_job_id": "job_abc123",
          "hls_metadata": {
            "duration": 1440,
            "bitrate": "4500k",
            "resolution": "1920x1080",
            "segments": 24
          },
          "createdAt": "...",
          "updatedAt": "..."
        }
      ],
      "hls_summary": {
        "total": 4,
        "done": 1,
        "pending": 3,
        "processing": 0,
        "failed": 0,
        "skipped": 0,
        "all_done": false
      }
    }
  }
  ```

  #### Response (404)
  ```json
  { "success": false, "message": "Episode tidak ditemukan" }
  ```

  ---

  ### 5. Tandai Quality sebagai PROCESSING

  **PATCH** `/v1/admin/hls/episodes/:episodeId/qualities/:namaQuality/processing`

  Menandai bahwa quality tertentu sedang dalam proses encode. Dipanggil oleh FE sesaat sebelum memulai job encode.

  #### Path Parameters
  | Param | Type | Deskripsi |
  |-------|------|-----------|
  | `episodeId` | number | ID episode |
  | `namaQuality` | string | Quality yang akan di-encode: `1080p`, `720p`, `480p`, `360p` |

  #### Request Body (JSON, opsional)
  ```json
  {
    "job_id": "job_xyz789"
  }
  ```

  #### Response (200)
  ```json
  {
    "success": true,
    "message": "Status diubah ke PROCESSING",
    "data": {
      "id": 202,
      "episode_id": 101,
      "nama_quality": "720p",
      "hls_status": "PROCESSING",
      "hls_job_id": "job_xyz789",
      ...
    }
  }
  ```

  #### Error
  - `400` jika quality sudah `DONE`
  - `400` jika nama_quality tidak valid

  ---

  ### 6. Callback dari Encoder (Single Quality)

  **POST** `/v1/admin/hls/callback`

  Dipanggil oleh **encoder eksternal** setelah selesai encode dan upload ke B2. Backend otomatis mengupdate `hls_url` dan `hls_status`.

  #### Request Body (JSON)
  ```json
  {
    "episode_id": 101,
    "nama_quality": "720p",
    "success": true,
    "hls_url": "https://cdn.example.com/hls/naruto_ep3_720p/index.m3u8",
    "job_id": "job_xyz789",
    "metadata": {
      "duration": 1440,
      "bitrate": "2500k",
      "resolution": "1280x720",
      "segments": 24
    }
  }
  ```

  ##### Contoh sukses dengan HLS master:
  ```json
  {
    "episode_id": 101,
    "nama_quality": "720p",
    "success": true,
    "hls_url": "https://cdn.example.com/hls/naruto_ep3_720p/index.m3u8",
    "hls_master_url": "https://cdn.example.com/hls/naruto_ep3/master.m3u8",
    "hls_size": 524288000,
    "job_id": "job_xyz789"
  }
  ```

  ##### Jika encode GAGAL:
  ```json
  {
    "episode_id": 101,
    "nama_quality": "480p",
    "success": false,
    "error_message": "FFmpeg exited with code 1: Out of memory"
  }
  ```

  | Field | Type | Wajib | Deskripsi |
  |-------|------|-------|-----------|
  | `episode_id` | number | ✅ | ID episode |
  | `nama_quality` | string | ✅ | Quality yang selesai di-encode |
  | `success` | boolean | ✅ | `true` jika berhasil, `false` jika gagal |
  | `hls_url` | string | Jika success=true | URL manifest `.m3u8` dari B2/CDN |
  | `error_message` | string | Jika success=false | Pesan error dari encoder |
  | `source_quality` | string | ❌ | URL video source asli (opsional, untuk quality baru yang belum ada di DB) |
  | `hls_master_url` | string | ❌ | URL master playlist `.m3u8` — disimpan ke tabel **Episode** (1 per episode, adaptive otomatis) |
| `hls_size` | number | ❌ | Ukuran segmen HLS per quality dalam bytes — disimpan ke **EpisodeQuality** |
  | `job_id` | string | ❌ | ID job encoder |
  | `metadata` | object | ❌ | Metadata encode (bitrate, resolution, dll) |

  > **Auto-create:** Jika quality `nama_quality` belum ada di DB, row akan **otomatis dibuat** (upsert). Berguna jika encoder menambah quality baru (misal `480p`) yang belum terdaftar sebelumnya.

  #### Response (200) - Berhasil
  ```json
  {
    "success": true,
    "message": "Callback berhasil diproses",
    "data": {
      "id": 202,
      "episode_id": 101,
      "nama_quality": "720p",
      "hls_status": "DONE",
      "hls_url": "https://cdn.example.com/hls/naruto_ep3_720p/index.m3u8",
      "hls_encoded_at": "2025-01-11T11:30:00.000Z",
      ...
    }
  }
  ```

  ---

  ### 7. Callback Bulk dari Encoder (Semua Quality)

  **POST** `/v1/admin/hls/callback/bulk`

  Encoder melaporkan hasil encode semua quality sekaligus dalam satu request.

  #### Request Body (JSON)
  ```json
  {
    "episode_id": 101,
    "results": [
      {
        "nama_quality": "1080p",
        "success": true,
        "hls_url": "https://cdn.example.com/hls/naruto_ep3_1080p/index.m3u8",
        "job_id": "job_abc1",
        "metadata": { "bitrate": "4500k", "resolution": "1920x1080" }
      },
      {
        "nama_quality": "720p",
        "success": true,
        "hls_url": "https://cdn.example.com/hls/naruto_ep3_720p/index.m3u8",
        "job_id": "job_abc2"
      },
      {
        "nama_quality": "480p",
        "success": false,
        "error_message": "Encoding failed: unsupported codec"
      },
      {
        "nama_quality": "360p",
        "success": true,
        "hls_url": "https://cdn.example.com/hls/naruto_ep3_360p/index.m3u8"
      }
    ]
  }
  ```

  #### Response (200)
  ```json
  {
    "success": true,
    "message": "Sebagian quality gagal diproses",
    "data": [
      { "nama_quality": "1080p", "status": "ok", "reason": null },
      { "nama_quality": "720p",  "status": "ok", "reason": null },
      { "nama_quality": "480p",  "status": "error", "reason": "Encoding failed: unsupported codec" },
      { "nama_quality": "360p",  "status": "ok", "reason": null }
    ]
  }
  ```

  ---

  ### 8. Override Status Manual (Admin)

  **PATCH** `/v1/admin/hls/episodes/:episodeId/qualities/:namaQuality/override`

  Admin dapat memaksa mengubah status quality secara manual (contoh: reset FAILED ke PENDING, atau set SKIPPED).

  #### Path Parameters
  | Param | Type | Deskripsi |
  |-------|------|-----------|
  | `episodeId` | number | ID episode |
  | `namaQuality` | string | Nama quality |

  #### Request Body (JSON)
  ```json
  {
    "hls_status": "PENDING",
    "hls_url": null,
    "reset_error": true
  }
  ```

  | Field | Type | Wajib | Deskripsi |
  |-------|------|-------|-----------|
  | `hls_status` | string | ✅ | Status baru (`PENDING`, `PROCESSING`, `DONE`, `FAILED`, `SKIPPED`) |
  | `hls_url` | string | ❌ | Set HLS URL (opsional, jika status DONE) |
  | `reset_error` | boolean | ❌ | Hapus `hls_error` jika `true` |

  > **Catatan:** Jika `hls_status=PENDING`, semua field HLS (`hls_url`, `hls_error`, `hls_encoded_at`, `hls_job_id`, `hls_metadata`) direset otomatis.

  #### Response (200)
  ```json
  {
    "success": true,
    "message": "Status quality berhasil diubah",
    "data": {
      "id": 202,
      "episode_id": 101,
      "nama_quality": "480p",
      "hls_status": "PENDING",
      "hls_url": null,
      ...
    }
  }
  ```

  ---

  ### 9. Popular Anime untuk Encode (by View Count)

  **GET** `/v1/admin/hls/popular`

  Mengambil anime populer (berdasarkan view count) yang memiliki episode yang perlu di-encode. Berguna untuk memprioritaskan encode anime yang sering ditonton.

  #### Query Parameters

  | Param | Type | Default | Deskripsi |
  |-------|------|---------|-----------|
  | `limit` | number | 20 | Jumlah anime (max 100) |
  | `minViews` | number | 0 | Minimum view count |
  | `hlsStatus` | string | - | Filter quality dengan status: `PENDING`, `PROCESSING`, `FAILED`. Jika tidak diisi, default menampilkan episode dengan status PENDING/PROCESSING/FAILED |

  #### Contoh Request
  ```
  GET /v1/admin/hls/popular?limit=10&minViews=1000
  GET /v1/admin/hls/popular?hlsStatus=PENDING&limit=5
  ```

  #### Response (200)
  ```json
  {
    "success": true,
    "message": "OK",
    "data": {
      "total_anime": 2,
      "anime_list": [
        {
          "id": 5,
          "nama_anime": "Attack on Titan",
          "gambar_anime": "https://cdn.example.com/aot.jpg",
          "view_anime": 150000,
          "rating_anime": 9.2,
          "status_anime": "Ongoing",
          "total_episodes": 25,
          "episodes_need_encode": 3,
          "episodes": [
            {
              "id": 101,
              "anime_id": 5,
              "judul_episode": "Episode 1: To You, 2,000 Years Later",
              "nomor_episode": 1,
              "thumbnail_episode": "https://cdn.example.com/ep1.jpg",
              "durasi_episode": 1440,
              "hls_master_url": null,
              "qualities": [
                {
                  "id": 1,
                  "nama_quality": "1080p",
                  "source_quality": "https://cdn.example.com/videos/ep1_1080p.mp4",
                  "hls_status": "PENDING",
                  "hls_url": null,
                  "hls_size": null,
                  "hls_encoded_at": null,
                  "hls_error": null
                },
                {
                  "id": 2,
                  "nama_quality": "720p",
                  "source_quality": "https://cdn.example.com/videos/ep1_720p.mp4",
                  "hls_status": "DONE",
                  "hls_url": "https://cdn.example.com/hls/ep1_720p/index.m3u8",
                  "hls_size": 314572800,
                  "hls_encoded_at": "2024-01-15T10:30:00.000Z",
                  "hls_error": null
                }
              ],
              "hls_summary": {
                "total": 2,
                "done": 1,
                "pending": 1,
                "processing": 0,
                "failed": 0,
                "skipped": 0,
                "all_done": false
              }
            }
          ]
        }
      ]
    }
  }
  ```

  #### Field Response

  | Field | Tipe | Deskripsi |
  |-------|------|-----------|
  | `total_anime` | number | Total anime yang punya episode perlu encode |
  | `anime_list` | array | List anime dengan episode |
  | `anime.view_anime` | number | Total view count (popularity) |
  | `anime.total_episodes` | number | Total semua episode anime |
  | `anime.episodes_need_encode` | number | Jumlah episode yang perlu encode |
  | `episode.hls_summary` | object | Ringkasan status encode per episode |
  | `episode.qualities` | array | Detail quality dengan HLS status |

  ---

  ## Schema Perubahan (Prisma)

  Field baru yang ditambahkan ke model `EpisodeQuality`:

  ```prisma
// hls_master_url ada di model Episode (bukan EpisodeQuality)
model Episode {
  // ... field lainnya ...
  hls_master_url String?  // URL master playlist .m3u8 (adaptive, berisi semua rendition)
}

model EpisodeQuality {
    id             Int              @id @default(autoincrement())
    episode_id     Int
    nama_quality   String           // "1080p" | "720p" | "480p" | "360p"
    source_quality String           // URL video original (input untuk encoder)

    // HLS fields
    hls_status     HlsEncodeStatus  @default(PENDING)
    hls_url        String?          // URL rendition playlist .m3u8 per-quality
  hls_size       BigInt?          // Ukuran total segmen HLS dalam bytes

  // hls_master_url disimpan di tabel Episode (1 per episode)
    hls_encoded_at DateTime?
    hls_error      String?
    hls_job_id     String?
    hls_metadata   Json?            // {bitrate, resolution, segments, duration, ...}

    createdAt      DateTime         @default(now())
    updatedAt      DateTime         @updatedAt

    episode Episode @relation(fields: [episode_id], references: [id], onDelete: Cascade)
    
    @@unique([episode_id, nama_quality])
    @@index([hls_status])
    @@index([episode_id, hls_status])
  }

  enum HlsEncodeStatus {
    PENDING
    PROCESSING
    DONE
    FAILED
    SKIPPED
  }
  ```

  > **Migration:** Jalankan `npx prisma migrate dev --name add_hls_fields_to_episode_quality`

  ---

  ## Files

  | File | Deskripsi |
  |------|-----------|
  | `src/services/adminHlsEncode.service.js` | Business logic (search, stats, callback, popular) |
  | `src/controllers/adminHlsEncode.controller.js` | HTTP handlers |
  | `src/routes/admin.routes.js` | Routes (prefix `/hls`) |
  | `prisma/schema.prisma` | Model `EpisodeQuality` + enum `HlsEncodeStatus` |

  ## New Endpoint Summary

  | # | Endpoint | Method | Deskripsi |
  |---|----------|--------|-----------|
  | 9 | `/v1/admin/hls/popular` | GET | Anime populer (by views) dengan episode yang perlu di-encode |
