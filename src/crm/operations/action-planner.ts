import type { OperationStep } from '../../database/schema';
import type { AllowedAction } from '../../common/schemas';

const step = (key: string, kind: string, payload: Record<string, unknown> = {}): OperationStep => ({
  key, kind, status: 'pending', payload, attempts: 0,
});

/**
 * Deterministic expansion of one validated action into journal steps (ACT-04).
 * Step keys are stable, so the CRM operation key `${operationId}:${key}` is the same
 * on every retry — that is what makes resuming and recovering safe.
 */
export function planSteps(action: AllowedAction): OperationStep[] {
  switch (action.type) {
    case 'capture_lead': {
      const steps: OperationStep[] = [];
      // Company first so a new contact can be linked to it on creation.
      if (action.existing?.companyId) steps.push(step('company', 'link_company', { id: action.existing.companyId }));
      else if (action.company) steps.push(step('company', 'create_company', { company: action.company }));
      if (action.existing?.personId) steps.push(step('person', 'link_person', { id: action.existing.personId }));
      else if (action.person) steps.push(step('person', 'create_person', { person: action.person }));
      if (action.existing?.personId && action.personFill && Object.keys(action.personFill).length) {
        steps.push(step('person_fill', 'update_person', { id: action.existing.personId, patch: action.personFill }));
      }
      if (action.existing?.opportunityId) steps.push(step('opportunity', 'link_opportunity', { id: action.existing.opportunityId }));
      else if (action.opportunity) steps.push(step('opportunity', 'create_opportunity', { opportunity: action.opportunity }));
      action.notes.forEach((n, i) => steps.push(step(`note:${i}`, 'create_note', { note: n })));
      action.tasks.forEach((t, i) => steps.push(step(`task:${i}`, 'create_task', { task: t })));
      return steps;
    }
    case 'update_stage':
      return [step('stage', 'update_stage', { id: action.opportunityId, stageId: action.newStageId, lostReason: action.lostReason, amount: action.amount, currency: action.currency })];
    case 'add_note':
      return [step('note', 'create_note', { note: action.note, target: { type: action.targetType, id: action.targetId } })];
    case 'create_task':
      return [step('task', 'create_task', { task: action.task, target: action.targetType && action.targetId ? { type: action.targetType, id: action.targetId } : undefined })];
    case 'reschedule':
      return [step('reschedule', 'update_task', { id: action.taskId, date: action.newDate, time: action.newTime, timezone: action.timezone })];
    case 'assign':
      return [
        step('assign', 'assign', { entity: action.targetType, id: action.targetId, ownerUserId: action.newOwnerUserId }),
        ...action.cascadeTaskIds.map((id, i) => step(`assign_task:${i}`, 'assign', { entity: 'task', id, ownerUserId: action.newOwnerUserId })),
      ];
    case 'archive':
      return [
        step('archive', 'archive', { entity: action.targetType, id: action.targetId }),
        ...action.cascadeTaskIds.map((id, i) => step(`archive_task:${i}`, 'archive', { entity: 'task', id })),
      ];
    case 'restore':
      return [step('restore', 'restore', { entity: action.targetType, id: action.targetId })];
  }
}

/** Human description of a step for "what was saved / what is retrying" (CAP-08). */
export function describeStep(s: OperationStep): string {
  const labels: Record<string, string> = {
    link_person: 'contact (existing)', create_person: 'contact', update_person: 'contact details', link_company: 'company (existing)',
    create_company: 'company', link_opportunity: 'opportunity (existing)', create_opportunity: 'opportunity', create_note: 'note',
    create_task: s.payload?.task && (s.payload.task as any).type === 'meeting' ? 'meeting' : 'task', update_stage: 'stage change',
    update_task: 'reschedule', assign: 'assignment', archive: 'archive', restore: 'restore',
  };
  return labels[s.kind] ?? s.kind;
}
