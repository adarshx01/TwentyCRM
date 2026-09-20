import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { OutreachModule } from './outreach/outreach.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
    }),
    OutreachModule,
  ],
})
export class AppModule {}
