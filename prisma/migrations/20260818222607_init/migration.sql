-- Extension citext: hace que la comparacion de emails sea insensible a
-- mayusculas a nivel de base de datos, no a base de recordar un lower()
-- en cada consulta. Es una extension "trusted", asi que el dueno de la base
-- puede crearla sin ser superusuario.
CREATE EXTENSION IF NOT EXISTS citext;

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('runner', 'admin');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('male', 'female', 'other', 'unspecified');

-- CreateEnum
CREATE TYPE "Units" AS ENUM ('metric', 'imperial');

-- CreateEnum
CREATE TYPE "Theme" AS ENUM ('light', 'dark', 'system');

-- CreateEnum
CREATE TYPE "MarathonRegistrationStatus" AS ENUM ('open', 'closing_soon', 'full', 'closed');

-- CreateEnum
CREATE TYPE "ServiceFeeScope" AS ENUM ('global', 'marathon');

-- CreateEnum
CREATE TYPE "ServiceFeeType" AS ENUM ('percent', 'fixed', 'mixed');

-- CreateEnum
CREATE TYPE "RegistrationStatus" AS ENUM ('draft', 'pending_payment', 'confirmed', 'cancelled', 'refunded');

-- CreateEnum
CREATE TYPE "PaymentProviderName" AS ENUM ('mock');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('card', 'qr', 'bank_transfer');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('pending', 'paid', 'failed', 'refunded');

-- CreateEnum
CREATE TYPE "PlanLevel" AS ENUM ('beginner', 'intermediate', 'advanced');

-- CreateEnum
CREATE TYPE "TrainingSessionType" AS ENUM ('easy', 'tempo', 'intervals', 'long', 'rest', 'recovery');

-- CreateEnum
CREATE TYPE "TrainingPlanStatus" AS ENUM ('active', 'completed', 'abandoned');

-- CreateEnum
CREATE TYPE "TrainingPlanSessionStatus" AS ENUM ('pending', 'completed', 'skipped', 'rescheduled');

-- CreateEnum
CREATE TYPE "WorkoutSource" AS ENUM ('app', 'manual', 'external');

-- CreateEnum
CREATE TYPE "WorkoutType" AS ENUM ('free_run', 'plan_session', 'goal_distance', 'goal_time', 'race');

-- CreateEnum
CREATE TYPE "TrackingSessionStatus" AS ENUM ('active', 'paused', 'finished', 'discarded');

-- CreateEnum
CREATE TYPE "PositionSource" AS ENUM ('app_batch', 'osmand', 'traccar');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" CITEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'runner',
    "emailVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "city" TEXT,
    "country" TEXT NOT NULL DEFAULT 'BO',
    "birthDate" DATE,
    "gender" "Gender" NOT NULL DEFAULT 'unspecified',
    "weightGrams" INTEGER,
    "heightCm" INTEGER,
    "defaultBibNumber" TEXT,
    "injuryFlags" JSONB NOT NULL DEFAULT '[]',
    "avgSleepMinutes" INTEGER,
    "hydrationHabit" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_preferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "units" "Units" NOT NULL DEFAULT 'metric',
    "theme" "Theme" NOT NULL DEFAULT 'system',
    "locale" TEXT NOT NULL DEFAULT 'es-BO',
    "notifications" JSONB NOT NULL DEFAULT '{}',
    "privacy" JSONB NOT NULL DEFAULT '{}',
    "onboardingSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shoes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "distanceMeters" INTEGER NOT NULL DEFAULT 0,
    "alertThresholdMeters" INTEGER NOT NULL DEFAULT 800000,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "deviceName" TEXT,
    "platform" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedFromId" TEXT,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "uniqueId" TEXT NOT NULL,
    "name" TEXT,
    "platform" TEXT,
    "appVersion" TEXT,
    "osVersion" TEXT,
    "pushToken" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marathons" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/La_Paz',
    "city" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'BO',
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "distanceMeters" INTEGER NOT NULL,
    "capacity" INTEGER NOT NULL,
    "slotsTaken" INTEGER NOT NULL DEFAULT 0,
    "priceCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BOB',
    "registrationStatus" "MarathonRegistrationStatus" NOT NULL DEFAULT 'open',
    "registrationClosesAt" TIMESTAMP(3),
    "routeGeoJson" JSONB,
    "schedule" JSONB NOT NULL DEFAULT '[]',
    "includes" JSONB NOT NULL DEFAULT '[]',
    "kitPickup" JSONB,
    "coverUrl" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "serviceFeeConfigId" TEXT,

    CONSTRAINT "marathons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marathon_categories" (
    "id" TEXT NOT NULL,
    "marathonId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "minAge" INTEGER,
    "maxAge" INTEGER,
    "gender" "Gender",
    "extraPriceCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marathon_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marathon_extras" (
    "id" TEXT NOT NULL,
    "marathonId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "stock" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "marathon_extras_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_fee_configs" (
    "id" TEXT NOT NULL,
    "scope" "ServiceFeeScope" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "type" "ServiceFeeType" NOT NULL DEFAULT 'percent',
    "percentBps" INTEGER,
    "fixedCents" INTEGER,
    "minCents" INTEGER,
    "maxCents" INTEGER,
    "label" TEXT NOT NULL DEFAULT 'Cargo por servicio',
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_fee_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registrations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "marathonId" TEXT NOT NULL,
    "categoryId" TEXT,
    "status" "RegistrationStatus" NOT NULL DEFAULT 'draft',
    "step" INTEGER NOT NULL DEFAULT 1,
    "bibNumber" TEXT,
    "personalData" JSONB NOT NULL DEFAULT '{}',
    "extras" JSONB NOT NULL DEFAULT '[]',
    "subtotalCents" INTEGER NOT NULL DEFAULT 0,
    "serviceFeeCents" INTEGER NOT NULL DEFAULT 0,
    "serviceFeeSnapshot" JSONB,
    "totalCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'BOB',
    "termsAcceptedAt" TIMESTAMP(3),
    "registeredAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "provider" "PaymentProviderName" NOT NULL DEFAULT 'mock',
    "method" "PaymentMethod" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'pending',
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BOB',
    "methodDetails" JSONB NOT NULL DEFAULT '{}',
    "idempotencyKey" TEXT NOT NULL,
    "externalId" TEXT,
    "receiptUrl" TEXT,
    "failureReason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_plan_templates" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "goalDistanceMeters" INTEGER NOT NULL,
    "level" "PlanLevel" NOT NULL,
    "totalWeeks" INTEGER NOT NULL,
    "weeklySessions" INTEGER NOT NULL,
    "avgWeeklyDistanceMeters" INTEGER NOT NULL,
    "coverUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "training_plan_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_plan_template_sessions" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "week" INTEGER NOT NULL,
    "weekday" INTEGER NOT NULL,
    "type" "TrainingSessionType" NOT NULL,
    "targetDistanceMeters" INTEGER,
    "targetDurationSeconds" INTEGER,
    "paceFactor" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "description" TEXT,
    "isKeySession" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "training_plan_template_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_plans" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "templateId" TEXT,
    "marathonId" TEXT,
    "name" TEXT NOT NULL,
    "totalWeeks" INTEGER NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "paceBasisSecPerKm" INTEGER NOT NULL,
    "status" "TrainingPlanStatus" NOT NULL DEFAULT 'active',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "training_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_plan_sessions" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "templateSessionId" TEXT,
    "week" INTEGER NOT NULL,
    "weekday" INTEGER NOT NULL,
    "scheduledDate" DATE NOT NULL,
    "type" "TrainingSessionType" NOT NULL,
    "targetDistanceMeters" INTEGER,
    "targetDurationSeconds" INTEGER,
    "paceMinSecPerKm" INTEGER,
    "paceMaxSecPerKm" INTEGER,
    "suggestedRoute" JSONB,
    "status" "TrainingPlanSessionStatus" NOT NULL DEFAULT 'pending',
    "rescheduledFromDate" DATE,
    "workoutId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "training_plan_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workouts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientUuid" TEXT NOT NULL,
    "source" "WorkoutSource" NOT NULL DEFAULT 'app',
    "type" "WorkoutType" NOT NULL DEFAULT 'free_run',
    "planSessionId" TEXT,
    "registrationId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "durationSeconds" INTEGER NOT NULL DEFAULT 0,
    "movingSeconds" INTEGER NOT NULL DEFAULT 0,
    "distanceMeters" INTEGER NOT NULL DEFAULT 0,
    "avgPaceSecPerKm" INTEGER,
    "avgSpeedMps" DOUBLE PRECISION,
    "elevationGainMeters" INTEGER NOT NULL DEFAULT 0,
    "calories" INTEGER,
    "bestKmIndex" INTEGER,
    "clientReported" JSONB,
    "feeling" INTEGER,
    "notes" TEXT,
    "isSynced" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "workouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workout_splits" (
    "id" TEXT NOT NULL,
    "workoutId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "distanceMeters" INTEGER NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "paceSecPerKm" INTEGER NOT NULL,
    "elevationGainMeters" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "workout_splits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workout_laps" (
    "id" TEXT NOT NULL,
    "workoutId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "targetPaceSecPerKm" INTEGER,
    "actualPaceSecPerKm" INTEGER,
    "durationSeconds" INTEGER NOT NULL,

    CONSTRAINT "workout_laps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracking_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workoutId" TEXT,
    "marathonId" TEXT,
    "deviceId" TEXT,
    "status" "TrackingSessionStatus" NOT NULL DEFAULT 'active',
    "ingestToken" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastPositionAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tracking_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "positions" (
    "id" BIGSERIAL NOT NULL,
    "trackingSessionId" TEXT NOT NULL,
    "workoutId" TEXT,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "altitude" DOUBLE PRECISION,
    "speedMps" DOUBLE PRECISION,
    "accuracyMeters" DOUBLE PRECISION,
    "heading" DOUBLE PRECISION,
    "batteryLevel" INTEGER,
    "source" "PositionSource" NOT NULL DEFAULT 'app_batch',
    "clientPointId" TEXT NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id","recordedAt")
) PARTITION BY RANGE ("recordedAt");
-- ^ Particionada por mes. La PK incluye recordedAt porque Postgres exige que
--   toda clave unica de una tabla particionada contenga la clave de particion.

-- CreateTable
CREATE TABLE "race_results" (
    "id" TEXT NOT NULL,
    "registrationId" TEXT NOT NULL,
    "workoutId" TEXT,
    "finishTimeSeconds" INTEGER NOT NULL,
    "chipTimeSeconds" INTEGER,
    "avgPaceSecPerKm" INTEGER,
    "avgSpeedMps" DOUBLE PRECISION,
    "distanceMeters" INTEGER NOT NULL,
    "elevationGainMeters" INTEGER NOT NULL DEFAULT 0,
    "bestKmIndex" INTEGER,
    "overallRank" INTEGER,
    "categoryRank" INTEGER,
    "finishedAt" TIMESTAMP(3) NOT NULL,
    "shareCardUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "race_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "race_checkpoints" (
    "id" TEXT NOT NULL,
    "raceResultId" TEXT NOT NULL,
    "kmMark" INTEGER NOT NULL,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "passedAt" TIMESTAMP(3) NOT NULL,
    "splitSeconds" INTEGER NOT NULL,

    CONSTRAINT "race_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE UNIQUE INDEX "user_profiles_userId_key" ON "user_profiles"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "user_preferences_userId_key" ON "user_preferences"("userId");

-- CreateIndex
CREATE INDEX "shoes_userId_isPrimary_idx" ON "shoes"("userId", "isPrimary");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_refreshTokenHash_key" ON "auth_sessions"("refreshTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_rotatedFromId_key" ON "auth_sessions"("rotatedFromId");

-- CreateIndex
CREATE INDEX "auth_sessions_userId_deviceId_idx" ON "auth_sessions"("userId", "deviceId");

-- CreateIndex
CREATE INDEX "auth_sessions_expiresAt_idx" ON "auth_sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_tokenHash_key" ON "password_reset_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_userId_idx" ON "password_reset_tokens"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "devices_uniqueId_key" ON "devices"("uniqueId");

-- CreateIndex
CREATE INDEX "devices_userId_idx" ON "devices"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "marathons_slug_key" ON "marathons"("slug");

-- CreateIndex
CREATE INDEX "marathons_startsAt_idx" ON "marathons"("startsAt");

-- CreateIndex
CREATE INDEX "marathons_registrationStatus_startsAt_idx" ON "marathons"("registrationStatus", "startsAt");

-- CreateIndex
CREATE INDEX "marathons_city_idx" ON "marathons"("city");

-- CreateIndex
CREATE INDEX "marathon_categories_marathonId_idx" ON "marathon_categories"("marathonId");

-- CreateIndex
CREATE INDEX "marathon_extras_marathonId_idx" ON "marathon_extras"("marathonId");

-- CreateIndex
CREATE INDEX "registrations_userId_status_idx" ON "registrations"("userId", "status");

-- CreateIndex
CREATE INDEX "registrations_marathonId_status_idx" ON "registrations"("marathonId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "registrations_marathonId_bibNumber_key" ON "registrations"("marathonId", "bibNumber");

-- CreateIndex
CREATE UNIQUE INDEX "payments_idempotencyKey_key" ON "payments"("idempotencyKey");

-- CreateIndex
CREATE INDEX "payments_registrationId_status_idx" ON "payments"("registrationId", "status");

-- CreateIndex
CREATE INDEX "payments_status_createdAt_idx" ON "payments"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "training_plan_templates_slug_key" ON "training_plan_templates"("slug");

-- CreateIndex
CREATE INDEX "training_plan_templates_goalDistanceMeters_level_idx" ON "training_plan_templates"("goalDistanceMeters", "level");

-- CreateIndex
CREATE INDEX "training_plan_template_sessions_templateId_week_idx" ON "training_plan_template_sessions"("templateId", "week");

-- CreateIndex
CREATE UNIQUE INDEX "training_plan_template_sessions_templateId_week_weekday_key" ON "training_plan_template_sessions"("templateId", "week", "weekday");

-- CreateIndex
CREATE INDEX "training_plans_userId_isActive_idx" ON "training_plans"("userId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "training_plan_sessions_workoutId_key" ON "training_plan_sessions"("workoutId");

-- CreateIndex
CREATE INDEX "training_plan_sessions_planId_scheduledDate_idx" ON "training_plan_sessions"("planId", "scheduledDate");

-- CreateIndex
CREATE INDEX "training_plan_sessions_planId_week_idx" ON "training_plan_sessions"("planId", "week");

-- CreateIndex
CREATE UNIQUE INDEX "workouts_clientUuid_key" ON "workouts"("clientUuid");

-- CreateIndex
CREATE INDEX "workouts_userId_startedAt_idx" ON "workouts"("userId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "workouts_userId_type_startedAt_idx" ON "workouts"("userId", "type", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "workouts_registrationId_idx" ON "workouts"("registrationId");

-- CreateIndex
CREATE UNIQUE INDEX "workout_splits_workoutId_index_key" ON "workout_splits"("workoutId", "index");

-- CreateIndex
CREATE UNIQUE INDEX "workout_laps_workoutId_index_key" ON "workout_laps"("workoutId", "index");

-- CreateIndex
CREATE UNIQUE INDEX "tracking_sessions_workoutId_key" ON "tracking_sessions"("workoutId");

-- CreateIndex
CREATE UNIQUE INDEX "tracking_sessions_ingestToken_key" ON "tracking_sessions"("ingestToken");

-- CreateIndex
CREATE INDEX "tracking_sessions_userId_status_idx" ON "tracking_sessions"("userId", "status");

-- CreateIndex
CREATE INDEX "tracking_sessions_marathonId_status_idx" ON "tracking_sessions"("marathonId", "status");

-- CreateIndex
CREATE INDEX "positions_trackingSessionId_recordedAt_idx" ON "positions"("trackingSessionId", "recordedAt");

-- CreateIndex
CREATE INDEX "positions_userId_recordedAt_idx" ON "positions"("userId", "recordedAt");

-- CreateIndex
CREATE INDEX "positions_workoutId_recordedAt_idx" ON "positions"("workoutId", "recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "positions_clientPointId_recordedAt_key" ON "positions"("clientPointId", "recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "race_results_registrationId_key" ON "race_results"("registrationId");

-- CreateIndex
CREATE UNIQUE INDEX "race_results_workoutId_key" ON "race_results"("workoutId");

-- CreateIndex
CREATE INDEX "race_results_overallRank_idx" ON "race_results"("overallRank");

-- CreateIndex
CREATE UNIQUE INDEX "race_checkpoints_raceResultId_kmMark_key" ON "race_checkpoints"("raceResultId", "kmMark");

-- AddForeignKey
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shoes" ADD CONSTRAINT "shoes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_rotatedFromId_fkey" FOREIGN KEY ("rotatedFromId") REFERENCES "auth_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marathons" ADD CONSTRAINT "marathons_serviceFeeConfigId_fkey" FOREIGN KEY ("serviceFeeConfigId") REFERENCES "service_fee_configs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marathon_categories" ADD CONSTRAINT "marathon_categories_marathonId_fkey" FOREIGN KEY ("marathonId") REFERENCES "marathons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marathon_extras" ADD CONSTRAINT "marathon_extras_marathonId_fkey" FOREIGN KEY ("marathonId") REFERENCES "marathons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_fee_configs" ADD CONSTRAINT "service_fee_configs_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_marathonId_fkey" FOREIGN KEY ("marathonId") REFERENCES "marathons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "marathon_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "registrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_plan_template_sessions" ADD CONSTRAINT "training_plan_template_sessions_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "training_plan_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_plans" ADD CONSTRAINT "training_plans_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_plans" ADD CONSTRAINT "training_plans_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "training_plan_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_plans" ADD CONSTRAINT "training_plans_marathonId_fkey" FOREIGN KEY ("marathonId") REFERENCES "marathons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_plan_sessions" ADD CONSTRAINT "training_plan_sessions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "training_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_plan_sessions" ADD CONSTRAINT "training_plan_sessions_templateSessionId_fkey" FOREIGN KEY ("templateSessionId") REFERENCES "training_plan_template_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_plan_sessions" ADD CONSTRAINT "training_plan_sessions_workoutId_fkey" FOREIGN KEY ("workoutId") REFERENCES "workouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workouts" ADD CONSTRAINT "workouts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workouts" ADD CONSTRAINT "workouts_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "registrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workout_splits" ADD CONSTRAINT "workout_splits_workoutId_fkey" FOREIGN KEY ("workoutId") REFERENCES "workouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workout_laps" ADD CONSTRAINT "workout_laps_workoutId_fkey" FOREIGN KEY ("workoutId") REFERENCES "workouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_sessions" ADD CONSTRAINT "tracking_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_sessions" ADD CONSTRAINT "tracking_sessions_workoutId_fkey" FOREIGN KEY ("workoutId") REFERENCES "workouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_sessions" ADD CONSTRAINT "tracking_sessions_marathonId_fkey" FOREIGN KEY ("marathonId") REFERENCES "marathons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tracking_sessions" ADD CONSTRAINT "tracking_sessions_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_workoutId_fkey" FOREIGN KEY ("workoutId") REFERENCES "workouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "positions" ADD CONSTRAINT "positions_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "race_results" ADD CONSTRAINT "race_results_registrationId_fkey" FOREIGN KEY ("registrationId") REFERENCES "registrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "race_results" ADD CONSTRAINT "race_results_workoutId_fkey" FOREIGN KEY ("workoutId") REFERENCES "workouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "race_checkpoints" ADD CONSTRAINT "race_checkpoints_raceResultId_fkey" FOREIGN KEY ("raceResultId") REFERENCES "race_results"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══ Particionado de positions (ver prisma/sql/positions-partitioning.sql) ═══

-- Particionado mensual de `positions`.
--
-- Este bloque se inserta a mano en la migracion inicial porque Prisma no sabe
-- expresar particionado. Se mantiene aqui aparte para poder releerlo sin
-- bucear en un archivo de 800 lineas; la copia que MANDA es la que vive dentro
-- de `prisma/migrations/*_init/migration.sql`.
--
-- Por que particionar: `positions` es la unica tabla que crece sin techo. Un
-- corredor genera ~1 punto/segundo, asi que una maraton de 4 horas son ~14.400
-- filas por persona. Particionar por mes permite archivar o borrar un mes
-- entero con un DROP TABLE instantaneo, en vez de un DELETE que bloquea.

-- ─────────────────────────────────────────────────────────────────────────────
-- Crea (si no existe) la particion mensual que contiene la fecha dada.
--
-- La llama el job mensual y tambien el arranque, para no depender de que el job
-- haya corrido. Es idempotente: llamarla dos veces no falla.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION create_positions_partition(target_date DATE)
RETURNS TEXT AS $$
DECLARE
  range_start DATE := date_trunc('month', target_date)::DATE;
  range_end   DATE := (date_trunc('month', target_date) + INTERVAL '1 month')::DATE;
  part_name   TEXT := 'positions_' || to_char(range_start, 'YYYY_MM');
BEGIN
  IF to_regclass(format('public.%I', part_name)) IS NOT NULL THEN
    RETURN part_name || ' (ya existia)';
  END IF;

  EXECUTE format(
    'CREATE TABLE %I PARTITION OF positions FOR VALUES FROM (%L) TO (%L)',
    part_name, range_start, range_end
  );

  RETURN part_name || ' (creada)';
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────────────────────
-- Particiones iniciales: 6 meses hacia atras (para los seeds historicos) y 18
-- hacia adelante. El job mensual va creando las siguientes.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  m DATE := (date_trunc('month', CURRENT_DATE) - INTERVAL '6 months')::DATE;
BEGIN
  WHILE m < (date_trunc('month', CURRENT_DATE) + INTERVAL '18 months')::DATE LOOP
    PERFORM create_positions_partition(m);
    m := (m + INTERVAL '1 month')::DATE;
  END LOOP;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Particion de respaldo.
--
-- Sin ella, un punto con fecha fuera de todo rango hace fallar el INSERT y se
-- pierde un dato de GPS que el usuario no puede volver a generar. Prefiero un
-- punto en la particion equivocada a un punto perdido.
--
-- OJO al operar: si `positions_default` llega a contener filas de un mes, crear
-- despues la particion de ese mes falla (Postgres tiene que validar que no se
-- solapan). Se arregla moviendo esas filas antes de crear la particion.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS positions_default PARTITION OF positions DEFAULT;
