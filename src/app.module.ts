import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AppConfigModule } from './config/config.module';
import { AppConfigService } from './config/app-config.service';
import { buildLoggerOptions } from './config/logger.config';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { MailModule } from './modules/mail/mail.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { AuthModule } from './modules/auth/auth.module';
import { StorageModule } from './modules/storage/storage.module';
import { UsersModule } from './modules/users/users.module';
import { MarathonsModule } from './modules/marathons/marathons.module';
import { RoutesModule } from './modules/routes/routes.module';
import { PricingModule } from './modules/pricing/pricing.module';
import { RegistrationsModule } from './modules/registrations/registrations.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { TrainingPlansModule } from './modules/training-plans/training-plans.module';
import { WorkoutsModule } from './modules/workouts/workouts.module';
import { TrackingModule } from './modules/tracking/tracking.module';
import { RacesModule } from './modules/races/races.module';
import { HomeModule } from './modules/home/home.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { AdminModule } from './modules/admin/admin.module';
// TEMPORAL — inscripcion desde la web publica. Ver `docs/pago-qr-manual.md`.
import { PublicModule } from './modules/public/public.module';
import { AppInfoModule } from './modules/app-info/app-info.module';
import { LinksModule } from './modules/links/links.module';

@Module({
  imports: [
    AppConfigModule,
    LoggerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: buildLoggerOptions,
    }),
    DatabaseModule,
    MailModule,
    NotificationsModule,
    StorageModule,
    AuthModule,
    UsersModule,
    MarathonsModule,
    RoutesModule,
    PricingModule,
    RegistrationsModule,
    PaymentsModule,
    TrainingPlansModule,
    WorkoutsModule,
    TrackingModule,
    RacesModule,
    HomeModule,
    RealtimeModule,
    AdminModule,
    PublicModule,
    AppInfoModule,
    LinksModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
  ],
})
export class AppModule {}
