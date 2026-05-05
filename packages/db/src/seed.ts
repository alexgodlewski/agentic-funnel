import { createDatabase, schema } from "./index";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required to seed asset bundles");
}

const seedBundles = [
  {
    sku: "starter-playbook",
    name: "Starter Playbook",
    storageBucket: process.env.ASSET_BUCKET ?? "downloads",
    storageKey: "starter-funnel/core/starter-playbook.pdf",
    mimeType: "application/pdf"
  },
  {
    sku: "templates-pack",
    name: "Checkout Templates Pack",
    storageBucket: process.env.ASSET_BUCKET ?? "downloads",
    storageKey: "starter-funnel/order-bump-1/checkout-templates.zip",
    mimeType: "application/zip"
  },
  {
    sku: "audio-companion",
    name: "Audio Companion",
    storageBucket: process.env.ASSET_BUCKET ?? "downloads",
    storageKey: "starter-funnel/order-bump-2/audio-companion.zip",
    mimeType: "application/zip"
  },
  {
    sku: "implementation-workshop",
    name: "Implementation Workshop",
    storageBucket: process.env.ASSET_BUCKET ?? "downloads",
    storageKey: "starter-funnel/oto/implementation-workshop.zip",
    mimeType: "application/zip"
  },
  {
    sku: "quickstart-mini",
    name: "Quickstart Mini Course",
    storageBucket: process.env.ASSET_BUCKET ?? "downloads",
    storageKey: "starter-funnel/downsell/quickstart-mini.zip",
    mimeType: "application/zip"
  }
];

const { db, pool } = createDatabase(DATABASE_URL);

try {
  for (const bundle of seedBundles) {
    await db
      .insert(schema.assetBundles)
      .values(bundle)
      .onConflictDoUpdate({
        target: schema.assetBundles.sku,
        set: {
          name: bundle.name,
          storageBucket: bundle.storageBucket,
          storageKey: bundle.storageKey,
          mimeType: bundle.mimeType,
          updatedAt: new Date()
        }
      });
  }
} finally {
  await pool.end();
}
