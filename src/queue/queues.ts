/** Queue names (BullMQ). Exhausted jobs are recorded in `dead_letters` and kept in BullMQ's failed set. */
export const QUEUES = {
  AI_EXTRACTION: 'ai-extraction',
  CRM_WRITE: 'crm-write',
  OUTBOUND: 'outbound-msg',
  REMINDER: 'reminder',
  RECONCILIATION: 'reconciliation',
  EMAIL_INTAKE: 'email-intake',
  INBOUND: 'inbound-event',
  MAILBOX_POLL: 'mailbox-poll',
  SCHEDULE_TICK: 'schedule-tick',
  PLANNER: 'schedule-planner',
  // pg-boss allows one cron schedule per queue, so each periodic producer has its own queue.
  MAINT_FREQUENT: 'maint-frequent',
  MAINT_HOURLY: 'maint-hourly',
  MAINT_DAILY: 'maint-daily',
  FANOUT_RECONCILE: 'fanout-reconcile',
  FANOUT_MAILBOX: 'fanout-mailbox',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface QueueDefaults {
  retryLimit: number;
  retryDelay: number;
  retryBackoff: boolean;
  expireInSeconds: number;
}

/**
 * Retry/expiry policy per queue. expireInSeconds bounds how long a crashed
 * worker's job stays invisible before another worker reclaims it.
 */
export const QUEUE_DEFAULTS: Record<QueueName, QueueDefaults> = {
  [QUEUES.AI_EXTRACTION]: { retryLimit: 3, retryDelay: 5, retryBackoff: true, expireInSeconds: 180 },
  [QUEUES.CRM_WRITE]: { retryLimit: 5, retryDelay: 10, retryBackoff: true, expireInSeconds: 300 },
  [QUEUES.OUTBOUND]: { retryLimit: 5, retryDelay: 10, retryBackoff: true, expireInSeconds: 90 },
  [QUEUES.REMINDER]: { retryLimit: 5, retryDelay: 30, retryBackoff: true, expireInSeconds: 300 },
  [QUEUES.RECONCILIATION]: { retryLimit: 2, retryDelay: 30, retryBackoff: true, expireInSeconds: 600 },
  [QUEUES.EMAIL_INTAKE]: { retryLimit: 5, retryDelay: 15, retryBackoff: true, expireInSeconds: 300 },
  [QUEUES.INBOUND]: { retryLimit: 3, retryDelay: 3, retryBackoff: true, expireInSeconds: 120 },
  [QUEUES.MAILBOX_POLL]: { retryLimit: 2, retryDelay: 30, retryBackoff: true, expireInSeconds: 300 },
  [QUEUES.SCHEDULE_TICK]: { retryLimit: 1, retryDelay: 5, retryBackoff: false, expireInSeconds: 120 },
  [QUEUES.PLANNER]: { retryLimit: 2, retryDelay: 30, retryBackoff: true, expireInSeconds: 600 },
  [QUEUES.MAINT_FREQUENT]: { retryLimit: 1, retryDelay: 30, retryBackoff: false, expireInSeconds: 300 },
  [QUEUES.MAINT_HOURLY]: { retryLimit: 1, retryDelay: 60, retryBackoff: false, expireInSeconds: 900 },
  [QUEUES.MAINT_DAILY]: { retryLimit: 1, retryDelay: 60, retryBackoff: false, expireInSeconds: 3600 },
  [QUEUES.FANOUT_RECONCILE]: { retryLimit: 1, retryDelay: 30, retryBackoff: false, expireInSeconds: 300 },
  [QUEUES.FANOUT_MAILBOX]: { retryLimit: 1, retryDelay: 30, retryBackoff: false, expireInSeconds: 300 },
};


export interface JobMeta {
  tenantId?: string;
  userId?: string;
  correlationId: string;
  idempotencyKey?: string;
  /** Number of times the job was deferred (rate budget / concurrency), capped */
  deferrals?: number;
}

export type JobPayload<T> = T & { _m: JobMeta };

// ── Typed job bodies ───────────────────────────────────────────
export interface InboundEventJob { eventId: string }                        // inbound_events.id + event body persisted in payload
export interface MediaDescriptor { mediaId: string; mimeType: string; url?: string; filename?: string; size?: number }
export interface AiExtractionJob { draftId: string; kind: 'card' | 'voice'; sourceEventId: string; channel: 'whatsapp' | 'teams' | 'dev'; connectionId: string; /** Message timestamp: relative dates resolve against it (CAP-05) */ receivedAt: string; descriptor: MediaDescriptor }
export interface CrmWriteJob { operationId: string }
export interface OutboundJob { deliveryId: string }
export interface ReminderJob { scheduleId: string }
export interface ReconcileJob { tenantId: string }
export interface EmailIntakeJob { recordId: string }
export interface MailboxPollJob { sourceId: string }
export type EmptyJob = Record<string, never>;
