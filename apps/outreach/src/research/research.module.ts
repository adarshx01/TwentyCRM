import { Module } from '@nestjs/common';
import { ResearchService } from './research.service';

@Module({
  providers: [ResearchService],
  exports: [ResearchService],
})
export class ResearchModule {}
