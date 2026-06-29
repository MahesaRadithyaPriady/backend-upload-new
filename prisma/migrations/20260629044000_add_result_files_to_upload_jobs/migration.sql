-- AddColumn: result_files to upload_jobs
ALTER TABLE "upload_jobs" ADD COLUMN "result_files" JSONB;
