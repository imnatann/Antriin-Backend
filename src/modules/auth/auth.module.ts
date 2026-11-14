import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseModule } from '../../database/database.module';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { AUTH_OTP_DELIVERY } from './auth.constants';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthRateLimitGuard } from './auth-rate-limit.guard';
import { AuthService } from './auth.service';
import { createOtpDelivery } from './otp-delivery.factory';

@Module({
  imports: [DatabaseModule, InfrastructureModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthGuard,
    AuthRateLimitGuard,
    {
      provide: AUTH_OTP_DELIVERY,
      inject: [ConfigService],
      useFactory: createOtpDelivery,
    },
  ],
  exports: [AuthService, AuthGuard],
})
export class AuthModule {}
