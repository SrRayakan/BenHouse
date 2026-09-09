import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { ReadyController } from './ready.controller';
import { DatabaseModule } from './infrastructure/database/database.module';
import { AuthModule } from './auth/auth.module';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [HealthController, ReadyController],
})
export class AppModule {}
