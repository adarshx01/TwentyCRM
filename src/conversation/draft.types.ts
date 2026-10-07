export type Source = 'card' | 'voice' | 'text' | 'user' | 'email';

export interface PersonDraft {
  name?: string;
  title?: string;
  email?: string;
  phoneRaw?: string;
  phoneE164?: string | null;
  phoneCountryAssumed?: boolean;
}

export interface CompanyDraft {
  name?: string;
  website?: string;
  address?: string;
}

export interface TaskDraft {
  title: string;
  type: 'follow_up' | 'meeting' | 'call' | 'task';
  dueDate?: string;
  dueTime?: string;
  timezone: string;
  location?: string;
  /** The user's original wording, shown next to the resolved absolute date (CAP-05) */
  expression?: string;
}

export interface NoteDraft {
  text: string;
  type: 'observation' | 'meeting_note' | 'transcript';
  source: Source;
}

export interface Clarification {
  id: string;
  kind: 'match_person' | 'match_company' | 'opportunity_target' | 'date' | 'meeting_time' | 'person_unclear' | 'free';
  question: string;
  options?: Array<{ id: string; label: string }>;
  /** Index of the task this question is about */
  taskIndex?: number;
}

export interface MatchSummary {
  id: string;
  label: string;
  email?: string;
  phone?: string;
  company?: string;
  updatedAt: string;
  /** Values currently stored on the existing record, for blank-only filling (CAP-06) */
  existing: { email?: string; phone?: string; title?: string; companyId?: string };
  openOpportunities?: Array<{ id: string; title: string; stageId: string }>;
}

export interface UncertainField {
  field: string;
  reason: string;
  candidates?: string[];
}

export interface CaptureData {
  kind: 'capture';
  person?: PersonDraft;
  company?: CompanyDraft;
  opportunity: { title?: string; stageId: string; interest?: string; amount?: number; currency?: string };
  notes: NoteDraft[];
  tasks: TaskDraft[];
  fieldSources: Record<string, Source>;
  uncertain: UncertainField[];
  clarifications: Clarification[];
  matches: { people: MatchSummary[]; companies: Array<{ id: string; label: string; website?: string }>; hiddenCount: number; signature?: string };
  decisions: { person?: 'new' | string; company?: 'new' | string; opportunity?: 'new' | string };
  /** Fields the user explicitly asked to overwrite on an existing record */
  overwrite: Array<'email' | 'phone' | 'title'>;
  pending: { card: number; voice: number };
  awaitingContext: boolean;
  contextSkipped: boolean;
  /** Set once the user has been asked for context, so we ask only once */
  contextAsked: boolean;
  /** Source event ids whose media/AI result was already applied (job replays are no-ops) */
  processed: string[];
}

export interface MutationData {
  kind: 'mutation';
  /** Plain-language lines describing the change, rendered in the preview */
  summaryLines: string[];
  warnings: string[];
  /** Set while the user must pick which record they meant (never guess a target) */
  /** Set when the draft approves an intake review item (IN-11): commits through the same idempotent operation */
  intakeRecordId?: string;
  pendingChoice?: { intent: Record<string, unknown>; choices: Array<{ entity: 'person' | 'company' | 'opportunity' | 'task'; id: string; label: string }> };
}

export type DraftData = CaptureData | MutationData;

export function emptyCapture(stageId: string): CaptureData {
  return {
    kind: 'capture', opportunity: { stageId }, notes: [], tasks: [], fieldSources: {}, uncertain: [], clarifications: [],
    matches: { people: [], companies: [], hiddenCount: 0 }, decisions: {}, overwrite: [], pending: { card: 0, voice: 0 },
    awaitingContext: false, contextSkipped: false, contextAsked: false, processed: [],
  };
}
