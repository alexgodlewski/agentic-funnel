import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { webEnv } from "./env";

let s3Client: S3Client | undefined;

export function hasAssetStorage(): boolean {
  return Boolean(
    webEnv.ASSET_BUCKET &&
      webEnv.ASSET_REGION &&
      webEnv.ASSET_ENDPOINT &&
      webEnv.ASSET_ACCESS_KEY_ID &&
      webEnv.ASSET_SECRET_ACCESS_KEY
  );
}

function getS3Client() {
  if (!s3Client) {
    if (!hasAssetStorage()) {
      throw new Error("Asset storage envs not configured");
    }
    s3Client = new S3Client({
      region: webEnv.ASSET_REGION!,
      endpoint: webEnv.ASSET_ENDPOINT!,
      forcePathStyle: true,
      credentials: {
        accessKeyId: webEnv.ASSET_ACCESS_KEY_ID!,
        secretAccessKey: webEnv.ASSET_SECRET_ACCESS_KEY!
      }
    });
  }
  return s3Client;
}

export async function buildSignedAssetUrl(storageKey: string, bucket?: string) {
  return getSignedUrl(
    getS3Client(),
    new GetObjectCommand({
      Bucket: bucket ?? webEnv.ASSET_BUCKET!,
      Key: storageKey
    }),
    { expiresIn: webEnv.ASSET_LINK_TTL_SECONDS }
  );
}
