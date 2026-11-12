import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard, CurrentUser } from './auth.guard';
import { AuthRateLimitGuard } from './auth-rate-limit.guard';
import type { AuthenticatedPrincipal } from './auth.guard';
import {
  CreateCampusEmailVerificationDto,
  CreateOtpChallengeDto,
  VerifyOtpDto,
} from './auth.dto';
import { AuthService } from './auth.service';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('otp-challenges')
  @UseGuards(AuthRateLimitGuard)
  @ApiOperation({ summary: 'Request a login OTP over email or phone channel' })
  @ApiResponse({ status: 201, description: 'OTP delivery accepted' })
  @ApiResponse({ status: 429, description: 'OTP resend cooldown is active' })
  @ApiResponse({ status: 503, description: 'OTP delivery is unavailable' })
  async createOtpChallenge(@Body() body: CreateOtpChallengeDto) {
    const challenge = await this.auth.createLoginChallenge(body);
    return { data: challenge };
  }

  @Post('otp-challenges/:challengeId/verify')
  @HttpCode(200)
  @UseGuards(AuthRateLimitGuard)
  @ApiOperation({
    summary: 'Verify an OTP and create an opaque bearer session',
  })
  @ApiResponse({ status: 200, description: 'OTP verified and session created' })
  async verifyOtp(
    @Param('challengeId', new ParseUUIDPipe()) challengeId: string,
    @Body() body: VerifyOtpDto,
  ) {
    return {
      data: await this.auth.verifyLoginChallenge(challengeId, body.code),
    };
  }

  @Post('campus-email-verifications')
  @UseGuards(AuthGuard, AuthRateLimitGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Request campus email verification for this account',
  })
  async createCampusEmailVerification(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() body: CreateCampusEmailVerificationDto,
  ) {
    return {
      data: await this.auth.createCampusEmailVerification(
        user.userId,
        body.email,
      ),
    };
  }

  @Post('campus-email-verifications/:challengeId/verify')
  @HttpCode(200)
  @UseGuards(AuthGuard, AuthRateLimitGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Verify the current user’s campus email OTP' })
  async verifyCampusEmail(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Param('challengeId', new ParseUUIDPipe()) challengeId: string,
    @Body() body: VerifyOtpDto,
  ) {
    return {
      data: await this.auth.verifyCampusEmailChallenge(
        user.userId,
        challengeId,
        body.code,
      ),
    };
  }

  @Get('campus-email-verifications/current')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get the current user’s campus email status' })
  async currentCampusEmailVerification(
    @CurrentUser() user: AuthenticatedPrincipal,
  ) {
    return {
      data: await this.auth.currentCampusEmailVerification(user.userId),
    };
  }

  @Post('sessions/refresh')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Rotate the current bearer session token' })
  async refreshSession(@CurrentUser() user: AuthenticatedPrincipal) {
    return {
      data: await this.auth.refreshSession(user.sessionId, user.userId),
    };
  }

  @Delete('sessions/current')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke the current bearer session' })
  async revokeCurrentSession(@CurrentUser() user: AuthenticatedPrincipal) {
    await this.auth.revokeSession(user.sessionId, user.userId);
    return { data: { revoked: true } };
  }
}
