import dotenv from 'dotenv';
import { S3Client, ListBucketsCommand, HeadBucketCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

dotenv.config();

function ensureEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function main() {
  const endpoint = ensureEnv('B2_S3_ENDPOINT');
  const region = process.env.B2_S3_REGION || 'us-east-1';
  const accessKeyId = ensureEnv('B2_S3_ACCESS_KEY_ID');
  const secretAccessKey =
    process.env.B2_S3_SECRET_ACCESS_KEY ||
    process.env.B2_S3_SECRET_APPLICATION_KEY ||
    (() => {
      throw new Error('Missing required env var: B2_S3_SECRET_ACCESS_KEY (or B2_S3_SECRET_APPLICATION_KEY)');
    })();
  const bucket = process.env.B2_S3_BUCKET_NAME || process.env.B2_BUCKET_NAME || '';

  const s3 = new S3Client({
    region,
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });

  const result = {
    ok: false,
    endpoint,
    region,
    bucket: bucket || null,
    steps: [],
  };

  try {
    const buckets = await s3.send(new ListBucketsCommand({}));
    result.steps.push({ step: 'ListBuckets', ok: true, buckets: (buckets?.Buckets || []).map((b) => b.Name) });

    if (bucket) {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
      result.steps.push({ step: 'HeadBucket', ok: true, bucket });

      const objs = await s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }));
      result.steps.push({
        step: 'ListObjectsV2',
        ok: true,
        keyCount: Number(objs?.KeyCount) || 0,
        sampleKeys: (objs?.Contents || []).slice(0, 3).map((o) => o.Key),
      });
    } else {
      result.steps.push({
        step: 'HeadBucket',
        ok: false,
        error: 'Bucket not provided. Set B2_S3_BUCKET_NAME (or B2_BUCKET_NAME) to test bucket access.',
      });
    }

    result.ok = true;
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    result.ok = false;
    result.error = {
      name: err?.name || null,
      message: err?.message || String(err),
      $metadata: err?.$metadata || null,
      Code: err?.Code || null,
      code: err?.code || null,
      statusCode: err?.$metadata?.httpStatusCode || err?.statusCode || null,
    };
    // eslint-disable-next-line no-console
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }
}

main();
