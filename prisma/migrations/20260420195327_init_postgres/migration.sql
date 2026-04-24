-- CreateTable
CREATE TABLE "file_mapping" (
    "driveFileId" TEXT NOT NULL,
    "b2ObjectKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "file_mapping_pkey" PRIMARY KEY ("driveFileId")
);

-- CreateTable
CREATE TABLE "drive_b2_mapping" (
    "driveFileId" TEXT NOT NULL,
    "drivePath" TEXT,
    "driveFolderId" TEXT,
    "driveDriveId" TEXT,
    "b2ObjectKey" TEXT NOT NULL,
    "b2Prefix" TEXT,
    "b2CatalogFolderId" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'linked',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "drive_b2_mapping_pkey" PRIMARY KEY ("driveFileId")
);

-- CreateTable
CREATE TABLE "folders" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "parent_id" INTEGER,
    "file_count" INTEGER DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "files" (
    "id" SERIAL NOT NULL,
    "folder_id" INTEGER,
    "file_name" TEXT NOT NULL,
    "file_path" TEXT NOT NULL,
    "size" BIGINT NOT NULL DEFAULT 0,
    "content_type" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_master" INTEGER NOT NULL DEFAULT 0,
    "is_low" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "upload_jobs" (
    "id" TEXT NOT NULL,
    "prefix" TEXT,
    "status" TEXT,
    "current" TEXT,
    "done" INTEGER DEFAULT 0,
    "total" INTEGER DEFAULT 0,
    "percent" INTEGER DEFAULT 0,
    "error" TEXT,
    "created_at_ms" BIGINT,
    "updated_at_ms" BIGINT,

    CONSTRAINT "upload_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "drive_b2_mapping_b2ObjectKey_key" ON "drive_b2_mapping"("b2ObjectKey");

-- CreateIndex
CREATE INDEX "drive_b2_mapping_drivePath_idx" ON "drive_b2_mapping"("drivePath");

-- CreateIndex
CREATE UNIQUE INDEX "folders_prefix_key" ON "folders"("prefix");

-- CreateIndex
CREATE UNIQUE INDEX "files_file_path_key" ON "files"("file_path");

-- CreateIndex
CREATE INDEX "upload_jobs_prefix_idx" ON "upload_jobs"("prefix");

-- CreateIndex
CREATE INDEX "idx_upload_jobs_updated" ON "upload_jobs"("updated_at_ms");

-- AddForeignKey
ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
