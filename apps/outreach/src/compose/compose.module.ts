import { Module } from '@nestjs/common';
import { ComposeService } from './compose.service';

@Module({
  providers: [ComposeService],
  exports: [ComposeService],
})
export class ComposeModule {}
