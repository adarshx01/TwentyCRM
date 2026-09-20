import { Module } from '@nestjs/common';
import { TwentyClient } from './twenty.client';

@Module({
  providers: [TwentyClient],
  exports: [TwentyClient],
})
export class TwentyModule {}
