import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';
import {
  OrganizationAdministrationController,
  OrganizationInvitationController,
} from './organization-administration.controller';
import { OrganizationAdministrationService } from './organization-administration.service';
import {
  DisabledOrganizationTransactionObserver,
  OrganizationTransactionObserver,
} from './organization-transaction-observer';

@Module({
  imports: [AuthModule],
  controllers: [
    OrganizationsController,
    OrganizationAdministrationController,
    OrganizationInvitationController,
  ],
  providers: [
    OrganizationsService,
    OrganizationAdministrationService,
    {
      provide: OrganizationTransactionObserver,
      useClass: DisabledOrganizationTransactionObserver,
    },
  ],
})
export class OrganizationsModule {}
