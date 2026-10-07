import { Module, Global } from '@nestjs/common';
import { APP_CONFIG, loadConfig } from './configuration';

@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: () => loadConfig(),
    },
  ],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
