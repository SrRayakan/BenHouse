import { Module } from '@nestjs/common';
import { configuredStorage, StorageProvider } from '@benhouse/storage';
import { AuthModule } from '../auth/auth.module';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import {
  MarketplaceTransactionObserver,
  DisabledMarketplaceTransactionObserver,
} from '../marketplace/marketplace-transaction-observer';

@Module({
  imports: [AuthModule],
  controllers: [MediaController],
  providers: [
    MediaService,
    { provide: StorageProvider, useFactory: () => configuredStorage() },
    { provide: MarketplaceTransactionObserver, useClass: DisabledMarketplaceTransactionObserver },
  ],
})
export class MediaModule {}
