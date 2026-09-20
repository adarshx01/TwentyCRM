import { Injectable, Logger } from '@nestjs/common';
import { loadConfig } from '../config/app.config';
import { parseDraftJson, type DraftEmail } from '../common/llm-json';

const SOLUTION_BLURBS: Record<string, string> = {
  AES: 'Action-Enabled System: next-best hiring action, then execute it in one click.',
  VOICEBOT: 'VoiceBot: AI voice pre-screening and structured L1 interviews.',
  RESUME_ANALYZER: 'Resume Analyzer: explainable JD–resume matching.',
  WHATSAPP: 'WhatsApp & calling: candidate engagement after voice screening.',
  REVERSE_MATCH: 'Reverse Match: internal mobility against open requisitions.',
  CAREER_PAGES: 'Career pages and job broadcast for employer brand.',
  ANALYTICS: 'Hiring analytics: pipeline, velocity, source quality.',
};

@Injectable()
export class ComposeService {
  private readonly log = new Logger(ComposeService.name);

  async draft(params: {
    companyName: string;
    contactFirstName: string;
    buyerRole?: string | null;
    solutionInterest?: string | null;
    researchSummary: string;
    host?: string | null;
  }): Promise<DraftEmail> {
    const cfg = loadConfig();
    if (cfg.openaiApiKey) {
      try {
        return await this.fromLlm(params, cfg.openaiApiKey, cfg.openaiBaseUrl, cfg.openaiModel);
      } catch (err) {
        this.log.warn(`LLM draft failed, using template: ${(err as Error).message}`);
      }
    }
    return this.template(params);
  }

  template(params: {
    companyName: string;
    contactFirstName: string;
    buyerRole?: string | null;
    solutionInterest?: string | null;
    researchSummary: string;
    host?: string | null;
  }): DraftEmail {
    const first = params.contactFirstName || 'there';
    const solutionKey = (params.solutionInterest ?? 'AES').toUpperCase();
    const blurb = SOLUTION_BLURBS[solutionKey] ?? SOLUTION_BLURBS.AES;
    const snippet = params.researchSummary.split('\n').filter(Boolean).slice(0, 4).join(' ');
    const hostLine = params.host ? ` I was reading ${params.host}.` : '';
    const knownRoles: Record<string, string> = {
      CHRO: 'CHRO',
      TA_HEAD: 'TA Head',
      RECRUITER: 'recruiter',
      HIRING_MANAGER: 'hiring manager',
    };
    const roleKey = (params.buyerRole ?? '').toUpperCase().replace(/\s+/g, '_');
    const role = knownRoles[roleKey] ? ` As ${knownRoles[roleKey]},` : '';

    const bodyText = `Hi ${first},

${role}${hostLine} ${snippet ? `A few things that stood out: ${snippet.slice(0, 400)}` : `${params.companyName} looks like a team that takes hiring seriously.`}

Recruitment Bricks is built for TA teams that want the next action, not another tracker. ${blurb}

If useful, I can walk through a 20-minute demo on your current funnel: https://recruitmentbricks.ai/request-a-demo

Best,
Recruitment Bricks

{{unsubscribe}}`;

    return {
      subject: `${params.companyName}: a faster hiring loop than another ATS tab`,
      bodyText: bodyText.replace(/\n{3,}/g, '\n\n').trim(),
      whyThisAngle: 'Template fallback using company research snippet and solutionInterest.',
    };
  }

  private async fromLlm(
    params: {
      companyName: string;
      contactFirstName: string;
      buyerRole?: string | null;
      solutionInterest?: string | null;
      researchSummary: string;
      host?: string | null;
    },
    apiKey: string,
    baseUrl: string,
    model: string,
  ): Promise<DraftEmail> {
    const solutionKey = (params.solutionInterest ?? 'AES').toUpperCase();
    const blurb = SOLUTION_BLURBS[solutionKey] ?? SOLUTION_BLURBS.AES;
    const sys = `You write first-touch B2B emails for Recruitment Bricks, an AI hiring platform (VoiceBot, explainable matching, WhatsApp engagement, reverse match, action-enabled recruiting).
Return JSON only: { "subject": string, "bodyText": string, "whyThisAngle": string }.
Rules:
- No fake customers, logos, pricing, or invented metrics.
- 120-180 words.
- One CTA: book a demo at https://recruitmentbricks.ai/request-a-demo
- End the body with a line that is exactly {{unsubscribe}}
- Warm, specific, not salesy spam.
- Use only facts from the research text; if research is thin, stay generic and honest.`;

    const user = JSON.stringify({
      companyName: params.companyName,
      contactFirstName: params.contactFirstName,
      buyerRole: params.buyerRole,
      solution: blurb,
      website: params.host,
      research: params.researchSummary.slice(0, 5000),
    });

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ],
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`OpenAI ${res.status} ${text.slice(0, 300)}`);
    }
    const json = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('Empty LLM content');
    }
    return parseDraftJson(content);
  }
}
