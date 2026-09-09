import { Injectable, OnModuleDestroy } from '@nestjs/common';
import {
  createPrismaClient,
  type PrismaClient,
  verifyDatabaseConnection,
  verifyDatabaseInfrastructure,
  verifyPostgis,
} from '@benhouse/database';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly client = createPrismaClient();

  get prisma(): PrismaClient {
    return this.client;
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }

  async connect(): Promise<void> {
    await this.client.$connect();
  }

  async disconnect(): Promise<void> {
    await this.client.$disconnect();
  }

  async verifyConnection(): Promise<void> {
    await verifyDatabaseConnection(this.client);
  }

  async verifyPostgis(): Promise<void> {
    await verifyPostgis(this.client);
  }

  async verifyInfrastructure(): Promise<void> {
    await verifyDatabaseInfrastructure(this.client);
  }
}
