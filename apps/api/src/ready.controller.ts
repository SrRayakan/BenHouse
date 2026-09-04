import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from './infrastructure/database/database.service';

@Controller('ready')
export class ReadyController {
  constructor(private readonly database: DatabaseService) {}

  @Get()
  async getReady(): Promise<{ status: 'ok'; service: 'api'; database: 'ready'; postgis: 'ready' }> {
    try {
      await this.database.verifyInfrastructure();
      return { status: 'ok', service: 'api', database: 'ready', postgis: 'ready' };
    } catch {
      throw new ServiceUnavailableException('Infraestructura de persistencia no disponible.');
    }
  }
}
