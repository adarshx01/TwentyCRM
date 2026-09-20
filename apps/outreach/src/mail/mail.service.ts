import { Injectable, Logger } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { loadConfig } from '../config/app.config';
import type { DraftEmail } from '../common/llm-json';

export type SendResult = { sent: boolean; skippedReason?: string; provider?: string };

@Injectable()
export class MailService {
  private readonly log = new Logger(MailService.name);

  async send(params: {
    to: string;
    draft: DraftEmail;
    autoRequested: boolean;
  }): Promise<SendResult> {
    const cfg = loadConfig();
    const body = params.draft.bodyText.replaceAll(
      '{{unsubscribe}}',
      'If this is not relevant, reply STOP and we will not email again.',
    );

    if (!cfg.sendEnabled) {
      this.log.log(`[dry-run] To: ${params.to}\nSubject: ${params.draft.subject}\n\n${body}`);
      return { sent: false, skippedReason: 'OUTREACH_SEND_ENABLED=false' };
    }
    if (!params.autoRequested) {
      this.log.log(`[draft mode] not sending to ${params.to}`);
      return { sent: false, skippedReason: 'outreachMode is DRAFT' };
    }

    if (cfg.resendApiKey) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: `${cfg.fromName} <${cfg.fromEmail}>`,
          to: [params.to],
          subject: params.draft.subject,
          text: body,
        }),
      });
      if (!res.ok) {
        throw new Error(`Resend ${res.status} ${await res.text()}`);
      }
      return { sent: true, provider: 'resend' };
    }

    if (cfg.smtpHost) {
      const transport = nodemailer.createTransport({
        host: cfg.smtpHost,
        port: cfg.smtpPort,
        secure: cfg.smtpPort === 465,
        auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPassword } : undefined,
      });
      await transport.sendMail({
        from: `${cfg.fromName} <${cfg.fromEmail}>`,
        to: params.to,
        subject: params.draft.subject,
        text: body,
      });
      return { sent: true, provider: 'smtp' };
    }

    this.log.warn('Send enabled but no Resend or SMTP configured; logging only');
    this.log.log(`[no-provider] To: ${params.to}\nSubject: ${params.draft.subject}\n\n${body}`);
    return { sent: false, skippedReason: 'no email provider' };
  }
}
