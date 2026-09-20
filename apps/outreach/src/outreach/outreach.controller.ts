import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { RunOutreachDto } from './dto';
import { OutreachService } from './outreach.service';

@Controller()
export class OutreachController {
  constructor(private readonly outreach: OutreachService) {}

  @Get('health')
  health() {
    return { ok: true, service: 'rb-outreach' };
  }

  @Post('outreach/run')
  @HttpCode(202)
  async run(
    @Body() body: RunOutreachDto,
    @Headers('authorization') authorization?: string,
  ) {
    const token = process.env.OUTREACH_API_TOKEN ?? '';
    if (token && authorization !== `Bearer ${token}`) {
      throw new UnauthorizedException();
    }
    if (!body.opportunityId && !body.personId) {
      throw new BadRequestException('opportunityId or personId is required');
    }
    return this.outreach.enqueue({
      opportunityId: body.opportunityId,
      personId: body.personId,
      source: 'manual',
    });
  }
}
