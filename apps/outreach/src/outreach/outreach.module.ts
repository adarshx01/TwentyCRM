import { Module } from '@nestjs/common';
import { ComposeModule } from '../compose/compose.module';
import { MailModule } from '../mail/mail.module';
import { ResearchModule } from '../research/research.module';
import { TwentyModule } from '../twenty/twenty.module';
import { OutreachController } from './outreach.controller';
import { OutreachService } from './outreach.service';
import { WebhookController } from './webhook.controller';

@Module({
  imports: [TwentyModule, ResearchModule, ComposeModule, MailModule],
  controllers: [OutreachController, WebhookController],
  providers: [OutreachService],
})
export class OutreachModule {}
