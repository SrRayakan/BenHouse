import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { ReadyController } from './ready.controller';
import { DatabaseModule } from './infrastructure/database/database.module';
import { AuthModule } from './auth/auth.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { MarketplaceModule } from './marketplace/marketplace.module';
import { MediaModule } from './media/media.module';

@Module({
  imports: [DatabaseModule, AuthModule, OrganizationsModule, MarketplaceModule, MediaModule],
  controllers: [HealthController, ReadyController],
})
export class AppModule {}
