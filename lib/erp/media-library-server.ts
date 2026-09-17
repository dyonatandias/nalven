export const mediaUsageSelect = {
  products: true,
  productSeoImages: true,
  productVideos: true,
  productVideoThumbnails: true,
  productBrandLogos: true,
  productGallery: true,
  productAttributeOptions: true,
  productVariationImages: true,
  productVariationGallery: true,
  productDownloads: true,
  logoSettings: true,
} as const;

export function publicMediaAsset<
  T extends {
    id: string;
    name: string;
    originalName: string;
    mimeType: string;
    kind: string;
    sizeBytes: number;
    altText: string;
    description: string | null;
    tags: string[];
    folder: string;
    source: string;
    version: number;
    expiresAt: Date | null;
    uploadedByName: string;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
    favorites?: { userId: string }[];
    _count?: Record<string, number>;
  },
>(asset: T, duplicateCount = 0) {
  return {
    id: asset.id,
    name: asset.name,
    originalName: asset.originalName,
    mimeType: asset.mimeType,
    kind: asset.kind,
    sizeBytes: asset.sizeBytes,
    altText: asset.altText,
    description: asset.description,
    tags: asset.tags,
    folder: asset.folder,
    source: asset.source,
    version: asset.version,
    expiresAt: asset.expiresAt,
    uploadedByName: asset.uploadedByName,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
    deletedAt: asset.deletedAt,
    favorite: Boolean(asset.favorites?.length),
    versionCount: asset._count?.versions || 0,
    duplicateCount,
    usageCount: mediaUsageCount(asset._count),
    url: `/api/erp/library/${asset.id}/file`,
  };
}

export function mediaUsageCount(counts?: Record<string, number>) {
  return counts
    ? Object.entries(counts).reduce(
        (sum, [key, count]) => (key === "versions" ? sum : sum + count),
        0,
      )
    : 0;
}
