from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from conversation.clock import Clock, as_utc
from conversation.crm.manifest import CLOSED_STAGES
from conversation.models import Outbox, Schedule

UPCOMING_DAYS = 7


@dataclass(frozen=True)
class TaskPayload:
    task_id: str
    title: str
    due_at: datetime
    assignee_membership_id: uuid.UUID
    tenant_id: uuid.UUID
    stage: str | None = None


@dataclass(frozen=True)
class DigestPlan:
    tenant_id: uuid.UUID
    membership_id: uuid.UUID
    period_key: str
    overdue: tuple[str, ...]
    today: tuple[str, ...]
    upcoming: tuple[str, ...]

    @property
    def is_empty(self) -> bool:
        return not (self.overdue or self.today or self.upcoming)

    def render(self) -> str:
        lines = [f"Follow-ups {self.period_key}"]
        if self.overdue:
            lines.append("Overdue: " + "; ".join(self.overdue))
        if self.today:
            lines.append("Today: " + "; ".join(self.today))
        if self.upcoming:
            lines.append("Upcoming: " + "; ".join(self.upcoming))
        return "\n".join(lines)


class ChannelPort:
    def send_digest(self, *, tenant_id: uuid.UUID, membership_id: uuid.UUID, body: str) -> None:
        raise NotImplementedError


class RecordingChannelPort(ChannelPort):
    def __init__(self) -> None:
        self.sent: list[tuple[uuid.UUID, uuid.UUID, str]] = []
        self.fail = False

    def send_digest(self, *, tenant_id: uuid.UUID, membership_id: uuid.UUID, body: str) -> None:
        if self.fail:
            raise RuntimeError("channel unavailable")
        self.sent.append((tenant_id, membership_id, body))


def plan_digest(tasks: list[TaskPayload], membership_id: uuid.UUID, now: datetime) -> DigestPlan | None:
    """REM-01–04. One membership, open tasks only, three due buckets."""
    current = as_utc(now)
    day = current.date()
    horizon = day + timedelta(days=UPCOMING_DAYS)
    mine = [
        task
        for task in tasks
        if task.assignee_membership_id == membership_id and task.stage not in CLOSED_STAGES
    ]
    if not mine:
        return None
    tenant_id = mine[0].tenant_id
    overdue: list[str] = []
    today: list[str] = []
    upcoming: list[str] = []
    for task in mine:
        due = as_utc(task.due_at).date()
        if due < day:
            overdue.append(task.title)
        elif due == day:
            today.append(task.title)
        elif due <= horizon:
            upcoming.append(task.title)
    plan = DigestPlan(
        tenant_id=tenant_id,
        membership_id=membership_id,
        period_key=day.isoformat(),
        overdue=tuple(overdue),
        today=tuple(today),
        upcoming=tuple(upcoming),
    )
    if plan.is_empty:
        return None
    return plan


class ReminderService:
    def __init__(self, session: Session, clock: Clock) -> None:
        self.session = session
        self.clock = clock

    def schedule(self, tasks: list[TaskPayload]) -> list[Schedule]:
        now = self.clock.now()
        membership_ids = {task.assignee_membership_id for task in tasks}
        created: list[Schedule] = []
        for membership_id in membership_ids:
            plan = plan_digest(tasks, membership_id, now)
            if plan is None:
                continue
            existing = self.session.scalar(
                select(Schedule).where(
                    Schedule.tenant_id == plan.tenant_id,
                    Schedule.membership_id == plan.membership_id,
                    Schedule.kind == "digest",
                    Schedule.period_key == plan.period_key,
                )
            )
            if existing is not None:
                created.append(existing)
                continue
            row = Schedule(
                tenant_id=plan.tenant_id,
                membership_id=plan.membership_id,
                kind="digest",
                period_key=plan.period_key,
                next_run_at=now,
                payload={
                    "body": plan.render(),
                    "overdue": list(plan.overdue),
                    "today": list(plan.today),
                    "upcoming": list(plan.upcoming),
                },
                status="pending",
            )
            self.session.add(row)
            self.session.flush()
            self.session.add(
                Outbox(
                    tenant_id=plan.tenant_id,
                    kind="digest",
                    payload={"schedule_id": str(row.id), "body": plan.render()},
                    status="pending",
                )
            )
            created.append(row)
        self.session.flush()
        return created

    def dispatch_due(self, port: ChannelPort) -> int:
        """REM-06–07. Failed sends stay pending. Tasks are not deleted."""
        now = self.clock.now()
        due = self.session.scalars(
            select(Schedule).where(Schedule.status == "pending", Schedule.kind == "digest", Schedule.next_run_at <= now)
        ).all()
        sent = 0
        for row in due:
            if self._send(row, port):
                sent += 1
        self.session.flush()
        return sent

    def dispatch_one(self, schedule_id: uuid.UUID, port: ChannelPort) -> bool:
        row = self.session.get(Schedule, schedule_id)
        if row is None or row.status != "pending" or row.kind != "digest":
            return False
        if as_utc(row.next_run_at) > self.clock.now():
            return False
        return self._send(row, port)

    def _send(self, row: Schedule, port: ChannelPort) -> bool:
        body = str((row.payload or {}).get("body", ""))
        try:
            port.send_digest(tenant_id=row.tenant_id, membership_id=row.membership_id, body=body)
        except Exception as exc:
            payload = dict(row.payload or {})
            payload["last_error"] = str(exc)[:500]
            row.payload = payload
            row.status = "pending"
            self.session.flush()
            return False
        row.status = "sent"
        self.session.flush()
        return True
