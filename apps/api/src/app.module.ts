import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { ReadyController } from './ready.controller';
import { DatabaseModule } from './infrastructure/database/database.module';

@Module({
  imports: [DatabaseModule],
  controllers: [HealthController, ReadyController],
})
export class AppModule {}
