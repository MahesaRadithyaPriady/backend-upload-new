-- CreateTable
CREATE TABLE "popular_encode_progress" (
    "id" SERIAL NOT NULL,
    "date_key" TEXT NOT NULL,
    "anime_encoded" INTEGER NOT NULL DEFAULT 0,
    "last_anime_id" INTEGER,
    "last_episode_id" INTEGER,
    "last_episode_number" TEXT,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "popular_encode_progress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "popular_encode_progress_date_key_key" ON "popular_encode_progress"("date_key");

-- CreateIndex
CREATE INDEX "popular_encode_progress_date_key_idx" ON "popular_encode_progress"("date_key");
