import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { workerEnv } from "./env";

let s3Client: S3Client | undefined;

function getS3Client() {
  if (!s3Client) {
    s3Client = new S3Client({
      region: workerEnv.ASSET_REGION,
      endpoint: workerEnv.ASSET_ENDPOINT,
      forcePathStyle: true,
      credentials: {
        accessKeyId: workerEnv.ASSET_ACCESS_KEY_ID,
        secretAccessKey: workerEnv.ASSET_SECRET_ACCESS_KEY
      }
    });
  }

  return s3Client;
}

export async function buildSignedAssetUrl(storageKey: string, bucket = workerEnv.ASSET_BUCKET) {
  return getSignedUrl(
    getS3Client(),
    new GetObjectCommand({
      Bucket: bucket,
      Key: storageKey
    }),
    {
      expiresIn: workerEnv.ASSET_LINK_TTL_SECONDS
    }
  );
}
