import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import {
  ListingsController,
  LocationsController,
  PropertiesController,
  PropertyAuthorizationsController,
} from './marketplace.controller';
import { MarketplaceService } from './marketplace.service';
import {
  DisabledMarketplaceTransactionObserver,
  MarketplaceTransactionObserver,
} from './marketplace-transaction-observer';

@Module({
  imports: [AuthModule],
  controllers: [
    PropertiesController,
    PropertyAuthorizationsController,
    ListingsController,
    LocationsController,
  ],
  providers: [
    MarketplaceService,
    { provide: MarketplaceTransactionObserver, useClass: DisabledMarketplaceTransactionObserver },
  ],
})
export class MarketplaceModule {}
