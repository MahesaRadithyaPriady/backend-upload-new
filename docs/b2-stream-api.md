# API Stream File (B2)

Endpoint ini digunakan untuk melakukan streaming file langsung dari Backblaze B2, dengan dukungan header `Range` (cocok untuk video).

## Endpoint

- **Method**: `GET`
- **URL**:
  - `/b2/stream/:id`
  - `/b2/stream?id=<encodedId>` (alternatif via query)

`id` adalah `fileName` di B2, misalnya:

```text
Kira/Anime/Akujiki Reijou to Kyouketsu Koushaku/Eps.6/ARKK-06-360p-SAMEHADAKU.CARE.mp4
```

Sebelum memanggil endpoint ini, `id` sebaiknya diambil dari:

- `/b2/list` (general)
- `/b2/videos` (khusus video)

## Header Request

- `Range` (opsional)
  - Contoh: `Range: bytes=0-` atau `Range: bytes=100000-200000`
  - Jika dikirim, server akan mengembalikan status `206 Partial Content` dengan header `Content-Range`.

## Perilaku Response

Endpoint ini akan:

1. Menghasilkan **signed download URL** (download authorization) untuk `fileName` (`id`) di bucket B2,
   dengan masa berlaku terbatas (misalnya 1 jam).
2. Merespon dengan **redirect HTTP 302** ke URL signed tersebut.

Setelah redirect, browser / `<video>` akan melakukan request langsung ke server B2 menggunakan URL
yang sudah mengandung token authorization. Dengan demikian:

- Bucket B2 dapat tetap **private**.
- Semua header streaming (`Content-Type`, `Content-Length`, `Accept-Ranges`, `Content-Range`, dll.)
  ditangani sepenuhnya oleh B2.

### Status Code

- `302 Found`
  - Redirect ke direct B2 download URL.

- `400 Bad Request`
  - Jika `id` tidak dikirim.

- `500 Internal Server Error`
  - Jika terjadi error saat mengambil data dari B2.

## Contoh Penggunaan

### 1. Streaming via path param

```bash
GET /b2/stream/Kira%2FAnime%2FAkujiki%20Reijou%20to%20Kyouketsu%20Koushaku%2FEps.6%2FARKK-06-360p-SAMEHADAKU.CARE.mp4
```

### 2. Streaming via query param

```bash
GET /b2/stream?id=Kira%2FAnime%2FAo%20no%20Orchestra%20Season%202%2FEps.5%2FAoO-S2-5-360p-SAMEHADAKU.CARE.mp4
```

### 3. Integrasi dengan `<video>` tag (HTML)

Misal kamu sudah ambil satu video dari `/b2/videos`, lalu dapat field `id`.

```html
<video
  src="/b2/stream/Kira%2FAnime%2FAkujiki%20Reijou%20to%20Kyouketsu%20Koushaku%2FEps.6%2FARKK-06-360p-SAMEHADAKU.CARE.mp4"
  controls
></video>
```

Atau jika ingin pakai query param:

```html
<video
  src="/b2/stream?id=Kira%2FAnime%2FAo%20no%20Orchestra%20Season%202%2FEps.5%2FAoO-S2-5-360p-SAMEHADAKU.CARE.mp4"
  controls
></video>
```

Browser akan otomatis mengirim header `Range` saat melakukan seek / buffering, dan backend akan meneruskan ke B2.

## Catatan

- Endpoint ini **tidak** lagi bergantung pada Google Drive, seluruh data diambil langsung dari Backblaze B2.
- Pastikan environment B2 sudah dikonfigurasi dengan benar (`B2_APPLICATION_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BUCKET_NAME`/`B2_BUCKET_ID`).
