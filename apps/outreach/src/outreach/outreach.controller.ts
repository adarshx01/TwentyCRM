import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { RunOutreachDto } from './dto';
import { OutreachService } from './outreach.service';
import { statusHtml, wiringStatus } from './status.page';

@Controller()
export class OutreachController {
  constructor(private readonly outreach: OutreachService) {}

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  root() {
    return statusHtml();
  }

  @Get('health')
  health() {
    return wiringStatus();
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
