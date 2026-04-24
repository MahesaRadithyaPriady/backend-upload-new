-- CreateTable
CREATE TABLE "hls_encode_records" (
    "id" SERIAL NOT NULL,
    "episode_id" INTEGER NOT NULL,
    "job_id" TEXT NOT NULL,
    "nama_quality" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "hls_url" TEXT,
    "master_url" TEXT,
    "master_size" BIGINT,
    "error_message" TEXT,
    "resolution" TEXT,
    "bitrate" TEXT,
    "segments" INTEGER,
    "duration" DOUBLE PRECISION,
    "encoded_at" TIMESTAMP(3),
    "synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "hls_encode_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hls_encode_records_episode_id_idx" ON "hls_encode_records"("episode_id");

-- CreateIndex
CREATE INDEX "hls_encode_records_job_id_idx" ON "hls_encode_records"("job_id");

-- CreateIndex
CREATE INDEX "hls_encode_records_status_idx" ON "hls_encode_records"("status");

-- CreateIndex
CREATE UNIQUE INDEX "hls_encode_records_episode_id_nama_quality_key" ON "hls_encode_records"("episode_id", "nama_quality");
