CREATE TABLE "api_rate_limits" (
    "id" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "window_start" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "api_rate_limits_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "api_rate_limits_expires_at_idx" ON "api_rate_limits"("expires_at");
