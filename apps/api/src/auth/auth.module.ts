import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { authConfigProvider } from './auth.config';
import { AuthRateLimitService } from './rate-limit.service';
import { AuthService } from './auth.service';
import { OriginGuard } from './origin.guard';
import { SystemClock } from './clock';
import { AUTH_CONFIG } from './auth.config';
import type { AuthConfig } from '@benhouse/config';
import { PASSWORD_ENGINE, PasswordEngine } from './password';

@Module({
  controllers: [AuthController],
  providers: [
    authConfigProvider,
    {
      provide: PASSWORD_ENGINE,
      inject: [AUTH_CONFIG],
      useFactory: (config: AuthConfig) => new PasswordEngine(config.argon2),
    },
    SystemClock,
    OriginGuard,
    AuthRateLimitService,
    AuthService,
  ],
})
export class AuthModule {}
