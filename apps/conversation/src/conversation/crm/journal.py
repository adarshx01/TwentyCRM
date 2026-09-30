from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from conversation.crm.client import CrmClient
from conversation.crm.proposal import ActionProposal
from conversation.errors import DomainError
from conversation.models import Operation, OperationStep

STEP_ORDER = ("company", "person", "opportunity", "note", "task")


class Journal:
    """Resume CRM writes without deleting records that already exist."""

    def __init__(self, session: Session) -> None:
        self.session = session

    def execute(self, operation: Operation, proposal: ActionProposal, client: CrmClient) -> Operation:
        steps = self._ensure_steps(operation, proposal)
        by_key = {step.step_key: step for step in steps}
        try:
            company_id = self._company(by_key["company"], proposal, client)
            person_id = self._person(by_key["person"], proposal, client, company_id)
            if person_id is None:
                raise DomainError("journal_failed", "person step did not produce an id")
            opportunity_id = self._opportunity(
                by_key["opportunity"], proposal, client, person_id=person_id, company_id=company_id
            )
            if opportunity_id is None:
                raise DomainError("journal_failed", "opportunity step did not produce an id")
            self._note(
                by_key["note"],
                proposal,
                client,
                person_id=person_id,
                company_id=company_id,
                opportunity_id=opportunity_id,
            )
            self._task(
                by_key["task"],
                proposal,
                client,
                person_id=person_id,
                company_id=company_id,
                opportunity_id=opportunity_id,
            )
        except DomainError:
            operation.status = "failed"
            self.session.flush()
            raise
        except Exception as exc:
            operation.status = "failed"
            self.session.flush()
            raise DomainError("journal_failed", str(exc)) from exc
        operation.status = "completed"
        self.session.flush()
        return operation

    def _ensure_steps(self, operation: Operation, proposal: ActionProposal) -> list[OperationStep]:
        existing = self.session.scalars(
            select(OperationStep).where(
                OperationStep.operation_id == operation.id,
                OperationStep.tenant_id == operation.tenant_id,
            )
        ).all()
        by_key = {step.step_key: step for step in existing}
        for key in STEP_ORDER:
            if key not in by_key:
                step = OperationStep(
                    tenant_id=operation.tenant_id,
                    operation_id=operation.id,
                    step_key=key,
                    status="pending",
                )
                self.session.add(step)
                by_key[key] = step
        self.session.flush()
        return [by_key[key] for key in STEP_ORDER]

    def _company(self, step: OperationStep, proposal: ActionProposal, client: CrmClient) -> str | None:
        if step.status in {"completed", "skipped"}:
            return step.external_id
        if proposal.company is None:
            step.status = "skipped"
            step.external_id = None
            return None
        try:
            found = client.find_company_by_domain(proposal.company.domain_name)
            step.external_id = found or client.create_company(proposal.company)
            step.status = "completed"
            step.error = None
            self.session.flush()
            return step.external_id
        except Exception as exc:
            step.status = "failed"
            step.error = str(exc)
            self.session.flush()
            raise

    def _person(
        self,
        step: OperationStep,
        proposal: ActionProposal,
        client: CrmClient,
        company_id: str | None,
    ) -> str | None:
        if step.status in {"completed", "skipped"}:
            return step.external_id
        try:
            found = client.find_person_by_email(proposal.person.email)
            step.external_id = found or client.create_person(proposal.person, company_id)
            step.status = "completed"
            step.error = None
            self.session.flush()
            return step.external_id
        except Exception as exc:
            step.status = "failed"
            step.error = str(exc)
            self.session.flush()
            raise

    def _opportunity(
        self,
        step: OperationStep,
        proposal: ActionProposal,
        client: CrmClient,
        *,
        person_id: str,
        company_id: str | None,
    ) -> str | None:
        if step.status in {"completed", "skipped"}:
            return step.external_id
        try:
            step.external_id = client.create_opportunity(
                proposal, person_id=person_id, company_id=company_id
            )
            step.status = "completed"
            step.error = None
            self.session.flush()
            return step.external_id
        except Exception as exc:
            step.status = "failed"
            step.error = str(exc)
            self.session.flush()
            raise

    def _note(
        self,
        step: OperationStep,
        proposal: ActionProposal,
        client: CrmClient,
        *,
        person_id: str,
        company_id: str | None,
        opportunity_id: str,
    ) -> None:
        if step.status in {"completed", "skipped"}:
            return
        if proposal.note is None:
            step.status = "skipped"
            return
        try:
            step.external_id = client.create_note(
                proposal,
                person_id=person_id,
                company_id=company_id,
                opportunity_id=opportunity_id,
            )
            step.status = "completed"
            step.error = None
            self.session.flush()
        except Exception as exc:
            step.status = "failed"
            step.error = str(exc)
            self.session.flush()
            raise

    def _task(
        self,
        step: OperationStep,
        proposal: ActionProposal,
        client: CrmClient,
        *,
        person_id: str,
        company_id: str | None,
        opportunity_id: str,
    ) -> None:
        if step.status in {"completed", "skipped"}:
            return
        if proposal.task is None:
            step.status = "skipped"
            return
        try:
            step.external_id = client.create_task(
                proposal,
                person_id=person_id,
                company_id=company_id,
                opportunity_id=opportunity_id,
            )
            step.status = "completed"
            step.error = None
            self.session.flush()
        except Exception as exc:
            step.status = "failed"
            step.error = str(exc)
            self.session.flush()
            raise


def idempotency_key(draft_id: uuid.UUID, version: int, content_hash: str) -> str:
    return f"draft:{draft_id}:v{version}:{content_hash}"
