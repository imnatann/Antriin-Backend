import { Module, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { InfrastructureModule } from '../../infrastructure/infrastructure.module';
import { AUTH_OTP_DELIVERY } from './auth.constants';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthRateLimitGuard } from './auth-rate-limit.guard';
import { AuthService } from './auth.service';

class UnavailableOtpDelivery {
  async send(): Promise<void> {
    throw new ServiceUnavailableException({
      code: 'otp_delivery_unavailable',
      message: 'OTP delivery is not configured',
    });
  }
}

@Module({
  imports: [DatabaseModule, InfrastructureModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthGuard,
    AuthRateLimitGuard,
    { provide: AUTH_OTP_DELIVERY, useClass: UnavailableOtpDelivery },
  ],
  exports: [AuthService, AuthGuard],
})
export class AuthModule {}
