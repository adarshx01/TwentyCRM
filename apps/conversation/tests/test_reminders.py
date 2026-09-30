import uuid
from datetime import datetime, timedelta, timezone

from conversation.reminders.planner import RecordingChannelPort, TaskPayload, plan_digest


def test_digest_is_per_membership_and_skips_closed(world):
    tenant, _admin, sales = _tenant(world)
    other = uuid.uuid4()
    now = world.clock.now()
    tasks = [
        TaskPayload("1", "Overdue", now - timedelta(days=1), sales.id, tenant.id, "NEW"),
        TaskPayload("2", "Today", now, sales.id, tenant.id, "CONTACTED"),
        TaskPayload("3", "Soon", now + timedelta(days=3), sales.id, tenant.id, "PROPOSAL"),
        TaskPayload("4", "Won", now, sales.id, tenant.id, "CLOSED_WON"),
        TaskPayload("5", "Theirs", now, other, tenant.id, "NEW"),
    ]
    plan = plan_digest(tasks, sales.id, now)
    assert plan is not None
    assert plan.overdue == ("Overdue",)
    assert plan.today == ("Today",)
    assert plan.upcoming == ("Soon",)
    assert plan_digest(tasks, other, now).today == ("Theirs",)

    first = world.reminders.schedule(tasks)
    second = world.reminders.schedule(tasks)
    assert len(first) == 2
    assert {row.id for row in second} == {row.id for row in first}

    port = RecordingChannelPort()
    assert world.reminders.dispatch_due(port) == 2
    assert len(port.sent) == 2
    port.fail = True
    # Already sent rows are not deleted and are not retried as pending.
    assert world.reminders.dispatch_due(port) == 0
    assert all(row.status == "sent" for row in first)


def test_failed_dispatch_stays_pending(world):
    tenant, _admin, sales = _tenant(world)
    now = world.clock.now()
    tasks = [TaskPayload("1", "Today", now, sales.id, tenant.id, "NEW")]
    rows = world.reminders.schedule(tasks)
    port = RecordingChannelPort()
    port.fail = True
    assert world.reminders.dispatch_due(port) == 0
    assert rows[0].status == "pending"
    port.fail = False
    assert world.reminders.dispatch_due(port) == 1
    assert rows[0].status == "sent"


def _tenant(world):
    from tests.conftest import open_tenant

    return open_tenant(world, "acme", "acme-sales")


def test_plan_uses_utc_dates():
    membership = uuid.uuid4()
    tenant = uuid.uuid4()
    now = datetime(2026, 10, 1, 23, 30, tzinfo=timezone.utc)
    plan = plan_digest(
        [TaskPayload("1", "Late", now, membership, tenant, None)],
        membership,
        now,
    )
    assert plan is not None
    assert plan.period_key == "2026-10-01"
    assert plan.today == ("Late",)
