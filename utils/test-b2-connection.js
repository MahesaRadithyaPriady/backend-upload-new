import { getB2 } from '../lib/b2.js';

async function main() {
  const result = {
    ok: false,
    bucketName: process.env.B2_BUCKET_NAME || null,
    hasKeyId: Boolean(process.env.B2_APPLICATION_KEY_ID),
    hasKey: Boolean(process.env.B2_APPLICATION_KEY),
    steps: [],
  };

  try {
    const { b2, bucketId, downloadUrl } = await getB2();
    result.steps.push({ step: 'authorize', ok: true, bucketId, downloadUrl });

    const list = await b2.listFileNames({
      bucketId,
      maxFileCount: 5,
    });

    const files = Array.isArray(list?.data?.files) ? list.data.files : [];
    result.steps.push({
      step: 'listFileNames',
      ok: true,
      fileCount: files.length,
      sample: files.map((f) => ({
        fileName: f.fileName,
        contentLength: f.contentLength,
        contentType: f.contentType,
        uploadTimestamp: f.uploadTimestamp,
      })),
      nextFileName: list?.data?.nextFileName ?? null,
    });

    result.ok = true;
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    result.ok = false;
    result.error = {
      name: err?.name || null,
      message: err?.message || String(err),
      code: err?.code || null,
      status: err?.status || err?.response?.status || err?.response?.data?.status || null,
      responseData: err?.response?.data || null,
      stack: err?.stack || null,
    };
    // eslint-disable-next-line no-console
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }
}

main();
