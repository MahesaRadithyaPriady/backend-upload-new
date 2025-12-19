# API List Video (B2)

Endpoint ini mengembalikan hanya file video (mp4, mkv, webm, avi, mov, m4v, dll.) dari Backblaze B2 dan menjelaskan cara mengambil source stream untuk diputar.

## Endpoint

- **Method**: `GET`
- **URL**: `/b2/videos`

## Query Parameters

- `prefix` (opsional, string)
  - Prefix path di dalam bucket B2.
  - Contoh:
    - `prefix=` (kosong) → scan semua file mulai dari awal bucket.
    - `prefix=Kira/Anime` → hanya file video di bawah `Kira/Anime/` dan subfoldernya.

- `pageToken` (opsional, string)
  - Token untuk pagination.
  - Isi dari field `nextPageToken` pada response sebelumnya.

- `pageSize` (opsional, number)
  - Default: `1000`.
  - Batas minimal: `1`.
  - Batas maksimal: `1000`.

## Filter Tipe File

Backend akan menganggap sebuah objek sebagai **video** jika:

- `contentType` dari B2 diawali `video/`, **atau**
- Ekstensi filename (lowercase) termasuk salah satu:
  - `.mp4`, `.mkv`, `.webm`, `.avi`, `.mov`, `.m4v`

## Bentuk Response

```json
{
  "files": [
    {
      "id": "Kira/Anime/Akujiki Reijou to Kyouketsu Koushaku/Eps.6/ARKK-06-360p-SAMEHADAKU.CARE.mp4",
      "name": "ARKK-06-360p-SAMEHADAKU.CARE.mp4",
      "mimeType": "video/mp4",
      "size": 43992778,
      "modifiedTime": "2025-12-14T09:30:32.698Z"
    },
    {
      "id": "Kira/Anime/Ao no Orchestra Season 2/Eps.5/AoO-S2-5-360p-SAMEHADAKU.CARE.mp4",
      "name": "AoO-S2-5-360p-SAMEHADAKU.CARE.mp4",
      "mimeType": "video/mp4",
      "size": 45363702,
      "modifiedTime": "2025-12-14T08:21:53.563Z"
    }
  ],
  "nextPageToken": "Kira/Anime/Disney Twisted-Wonderland ... .mp4"
}
```

### Penjelasan Field

- `files[]`
  - `id`
    - Path penuh file di B2 (sama dengan `fileName`).
  - `name`
    - Nama file saja (segmen terakhir dari path).
  - `mimeType`
    - Tipe konten, biasanya `video/mp4`, `video/x-matroska`, dll.
  - `size`
    - Ukuran file dalam byte.
  - `modifiedTime`
    - Waktu upload (dari `uploadTimestamp` B2) dalam bentuk ISO string.

- `nextPageToken`
  - Token untuk halaman berikutnya (diambil dari `nextFileName` B2).
  - Jika `null`, berarti tidak ada halaman berikutnya.

## Streaming Video dari Hasil List

Setiap item di `files[]` memiliki `id` yang sama dengan `fileName` di B2.

Untuk memutar video tersebut, gunakan endpoint `/b2/stream`:

- **Param path**:

  ```bash
  GET /b2/stream/<encodedId>
  ```

- **Query string**:

  ```bash
  GET /b2/stream?id=<encodedId>
  ```

Contoh penggunaan dengan tag `<video>`:

```html
<video
  src="/b2/stream/Kira%2FAnime%2FAkujiki%20Reijou%20to%20Kyouketsu%20Koushaku%2FEps.6%2FARKK-06-360p-SAMEHADAKU.CARE.mp4"
  controls
></video>
```

Detail lengkap perilaku streaming (header `Range`, status 200/206, dll.) ada di dokumen `b2-stream-api.md`.
