import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';
import {
  DisabledOrganizationTransactionObserver,
  OrganizationTransactionObserver,
} from './organization-transaction-observer';

@Module({
  imports: [AuthModule],
  controllers: [OrganizationsController],
  providers: [
    OrganizationsService,
    {
      provide: OrganizationTransactionObserver,
      useClass: DisabledOrganizationTransactionObserver,
    },
  ],
})
export class OrganizationsModule {}
