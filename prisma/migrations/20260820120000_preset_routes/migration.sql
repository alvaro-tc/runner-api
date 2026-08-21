-- CreateTable
CREATE TABLE "routes" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "city" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'BO',
    "distanceMeters" INTEGER NOT NULL,
    "startLat" DOUBLE PRECISION NOT NULL,
    "startLng" DOUBLE PRECISION NOT NULL,
    "geoJson" JSONB NOT NULL,
    "elevationGainMeters" INTEGER,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "routes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "routes_slug_key" ON "routes"("slug");

-- CreateIndex
CREATE INDEX "routes_city_idx" ON "routes"("city");

-- AlterTable
ALTER TABLE "marathons" ADD COLUMN "routeId" TEXT;

-- CreateIndex
CREATE INDEX "marathons_routeId_idx" ON "marathons"("routeId");

-- AddForeignKey
ALTER TABLE "marathons" ADD CONSTRAINT "marathons_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "routes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
