import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { hostnameFromUrlOrHost, originFromHost } from '../common/domain';

const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 500_000;
const MAX_TEXT = 6000;

export type ResearchResult = {
  host: string | null;
  url: string | null;
  summary: string;
  fetched: boolean;
};

@Injectable()
export class ResearchService {
  private readonly log = new Logger(ResearchService.name);

  async research(params: {
    website?: string | null;
    domainName?: string | null;
    email?: string | null;
    companyName?: string | null;
  }): Promise<ResearchResult> {
    const host =
      hostnameFromUrlOrHost(params.website) ??
      hostnameFromUrlOrHost(params.domainName) ??
      hostnameFromUrlOrHost(params.email?.includes('@') ? params.email.split('@')[1] : null);

    if (!host) {
      return {
        host: null,
        url: null,
        fetched: false,
        summary: params.companyName
          ? `${params.companyName} (no website or company domain on file).`
          : 'No company website on file.',
      };
    }

    const origin = originFromHost(host);
    const pages = [origin, `${origin}/about`];
    const chunks: string[] = [];

    for (const url of pages) {
      try {
        const html = await this.getHtml(url);
        if (!html) {
          continue;
        }
        const text = this.extractText(html);
        if (text) {
          chunks.push(`Source: ${url}\n${text}`);
        }
      } catch (err) {
        this.log.warn(`Fetch failed ${url}: ${(err as Error).message}`);
      }
    }

    if (!chunks.length) {
      return {
        host,
        url: origin,
        fetched: false,
        summary: `${params.companyName ?? host} appears to operate at ${host}. Website text could not be retrieved.`,
      };
    }

    const combined = chunks.join('\n\n').slice(0, MAX_TEXT);
    return {
      host,
      url: origin,
      fetched: true,
      summary: combined,
    };
  }

  private async getHtml(url: string): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': 'RecruitmentBricksOutreach/0.1 (+https://recruitmentbricks.ai)',
          Accept: 'text/html,application/xhtml+xml',
        },
      });
      if (!res.ok) {
        return null;
      }
      const contentType = res.headers.get('content-type') ?? '';
      if (contentType && !contentType.includes('html') && !contentType.includes('text')) {
        return null;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.subarray(0, MAX_BYTES).toString('utf8');
    } finally {
      clearTimeout(timer);
    }
  }

  private extractText(html: string): string {
    const $ = cheerio.load(html);
    $('script, style, noscript, svg, nav, footer, iframe').remove();
    const title = $('title').first().text().trim();
    const description = $('meta[name="description"]').attr('content')?.trim() ?? '';
    const headings = $('h1, h2')
      .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim())
      .get()
      .filter(Boolean)
      .slice(0, 8);
    const paragraphs = $('p')
      .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim())
      .get()
      .filter((t) => t.length > 40)
      .slice(0, 12);
    return [title && `Title: ${title}`, description && `Description: ${description}`, ...headings, ...paragraphs]
      .filter(Boolean)
      .join('\n');
  }
}
