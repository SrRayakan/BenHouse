import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  getHealth(): { status: 'ok'; service: 'api' } {
    return { status: 'ok', service: 'api' };
  }
}
