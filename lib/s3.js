import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

function ensureEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

let s3Client = null;

export function getS3() {
  if (s3Client) return { s3: s3Client };

  const endpoint = ensureEnv('B2_S3_ENDPOINT');
  const region = process.env.B2_S3_REGION || 'us-east-1';
  const accessKeyId = ensureEnv('B2_S3_ACCESS_KEY_ID');
  const secretAccessKey = process.env.B2_S3_SECRET_ACCESS_KEY || process.env.B2_S3_SECRET_APPLICATION_KEY;
  if (!secretAccessKey) {
    throw new Error('Missing required env var: B2_S3_SECRET_ACCESS_KEY (or B2_S3_SECRET_APPLICATION_KEY)');
  }

  s3Client = new S3Client({
    region,
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });

  return { s3: s3Client };
}

export async function createPresignedPutUrl({ bucket, key, contentType, expiresInSeconds = 600 } = {}) {
  if (!bucket) throw new Error('bucket is required for createPresignedPutUrl');
  if (!key) throw new Error('key is required for createPresignedPutUrl');

  const { s3 } = getS3();
  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType || 'application/octet-stream',
  });

  const url = await getSignedUrl(s3, cmd, { expiresIn: expiresInSeconds });
  return { url, method: 'PUT' };
}
