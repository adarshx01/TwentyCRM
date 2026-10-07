import type { PipelineConfig } from '../../database/schema';

/**
 * Custom fields the service provisions on the pinned Twenty release (CFG-02).
 * Provisioning is idempotent: existing fields are left alone.
 * See docs/twenty-mapping.md for the native/custom mapping table.
 */
export interface FieldSpec {
  name: string;
  label: string;
  type: 'TEXT' | 'BOOLEAN' | 'NUMBER' | 'DATE_TIME';
  defaultValue?: unknown;
}

const common: FieldSpec[] = [
  { name: 'beeOperationKey', label: 'Bee operation key', type: 'TEXT' },
  { name: 'beeOwnerMemberId', label: 'Bee owner', type: 'TEXT' },
  { name: 'beeTeamId', label: 'Bee team', type: 'TEXT' },
  { name: 'beeArchived', label: 'Bee archived', type: 'BOOLEAN', defaultValue: false },
  { name: 'beeSource', label: 'Bee source', type: 'TEXT' },
  { name: 'beeSourceEventIds', label: 'Bee source events', type: 'TEXT' },
];

export const REQUIRED_FIELDS: Record<string, FieldSpec[]> = {
  person: [...common, { name: 'beePhoneE164', label: 'Phone E.164', type: 'TEXT' }, { name: 'beePhoneRaw', label: 'Phone raw', type: 'TEXT' }, { name: 'beePhoneDigits', label: 'Phone digits', type: 'TEXT' }],
  company: [...common],
  opportunity: [...common, { name: 'beeInterest', label: 'Interest', type: 'TEXT' }, { name: 'beeLostReason', label: 'Lost reason', type: 'TEXT' }],
  note: [...common, { name: 'beeNoteType', label: 'Note type', type: 'TEXT' }, { name: 'beeEventTime', label: 'Event time', type: 'TEXT' }, { name: 'beeChannel', label: 'Channel', type: 'TEXT' }, { name: 'beeAttachmentRefs', label: 'Attachment refs', type: 'TEXT' }],
  task: [
    ...common,
    { name: 'beeTaskKind', label: 'Task kind', type: 'TEXT' },
    { name: 'beeStatus', label: 'Bee status', type: 'TEXT' },
    { name: 'beeDueDate', label: 'Local due date', type: 'TEXT' },
    { name: 'beeHasTime', label: 'Has time', type: 'BOOLEAN', defaultValue: false },
    { name: 'beeTimezone', label: 'Timezone', type: 'TEXT' },
    { name: 'beeDurationMin', label: 'Duration minutes', type: 'NUMBER' },
    { name: 'beeLocation', label: 'Location', type: 'TEXT' },
    // Denormalized links so tasks can be filtered server-side; the native taskTargets are written too (UI relations).
    { name: 'beePersonId', label: 'Linked contact', type: 'TEXT' },
    { name: 'beeCompanyId', label: 'Linked company', type: 'TEXT' },
    { name: 'beeOpportunityId', label: 'Linked opportunity', type: 'TEXT' },
    { name: 'beeCompletedAt', label: 'Completed at', type: 'TEXT' },
  ],
};

/** Custom object backing the tenant-restricted Intake Review view (IN-11). */
export const INTAKE_REVIEW_OBJECT = {
  nameSingular: 'intakeReview',
  namePlural: 'intakeReviews',
  labelSingular: 'Intake review',
  labelPlural: 'Intake reviews',
  fields: [
    { name: 'beeRecordId', label: 'Intake record', type: 'TEXT' },
    { name: 'beeSourceId', label: 'Source', type: 'TEXT' },
    { name: 'beeStatus', label: 'Status', type: 'TEXT', defaultValue: 'pending' },
    { name: 'beeReason', label: 'Reason', type: 'TEXT' },
    { name: 'beeFields', label: 'Proposed fields', type: 'TEXT' },
    { name: 'beeOperationRef', label: 'Operation', type: 'TEXT' },
    { name: 'beeReviewedBy', label: 'Reviewed by', type: 'TEXT' },
    { name: 'beeReceivedAt', label: 'Received', type: 'TEXT' },
  ] as FieldSpec[],
};

/** Stable stage ID → Twenty SELECT option value. Labels may change; IDs may not (CFG-04). */
export const stageToOption = (id: string): string => id.toUpperCase().replace(/[^A-Z0-9]+/g, '_');

export function stageOptions(pipeline: PipelineConfig): Array<{ value: string; label: string; position: number; color: string }> {
  const colors = ['blue', 'turquoise', 'sky', 'purple', 'orange', 'green', 'red', 'gray'];
  return [...pipeline.stages]
    .sort((a, b) => a.order - b.order)
    .map((s, i) => ({ value: stageToOption(s.id), label: s.label, position: i, color: colors[i % colors.length] }));
}
