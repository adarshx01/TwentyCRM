import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/configuration';
import { DevChannel } from '../dev/dev.channel';

/**
 * In-CRM chat (the Bee app inside Twenty). Replies are appended to a per-user Redis list that the Twenty app polls.
 * Unlike the dev channel it is production-grade: it is on whenever CRM_CHAT_TOKEN is set.
 */
@Injectable()
export class WebChannel extends DevChannel {
  protected override readonly prefix: string = 'web';

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super(config);
    (this as { enabled: boolean }).enabled = !!config.web.token;
  }
}
