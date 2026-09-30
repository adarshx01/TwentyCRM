from __future__ import annotations

import json
import time
from typing import Protocol


class WorkQueue(Protocol):
    def enqueue(self, payload: dict) -> None: ...

    def drain(self) -> list[dict]: ...

    def reserve(self, timeout: float = 1) -> dict | None: ...

    def retry(self, payload: dict, delay_seconds: float) -> None: ...


class MemoryQueue:
    """In-process stand-in for Redis. Journals are not stored here."""

    def __init__(self) -> None:
        self._items: list[dict] = []

    def enqueue(self, payload: dict) -> None:
        self._items.append(payload)

    def drain(self) -> list[dict]:
        now = time.time()
        due = [item for item in self._items if float(item.get("not_before", 0)) <= now]
        self._items = [item for item in self._items if float(item.get("not_before", 0)) > now]
        return due

    def reserve(self, timeout: float = 1) -> dict | None:
        due = self.drain()
        if not due:
            return None
        head, rest = due[0], due[1:]
        self._items = rest + self._items
        return head

    def retry(self, payload: dict, delay_seconds: float) -> None:
        item = dict(payload)
        item["not_before"] = time.time() + delay_seconds
        self._items.append(item)

    def promote_due(self) -> None:
        return None


class RedisQueue:
    """List-backed Redis queue plus a delayed sorted set for retries.

    Production journals stay in Postgres. This list only names work to do.
    """

    def __init__(self, url: str, key: str = "conversation:inbound") -> None:
        try:
            import redis
        except ImportError as exc:
            raise RuntimeError("QUEUE_BACKEND=redis requires the redis package") from exc
        self._redis = redis.Redis.from_url(url)
        self._key = key
        self._delayed = key + ":delayed"

    def enqueue(self, payload: dict) -> None:
        self._redis.rpush(self._key, json.dumps(payload))

    def drain(self) -> list[dict]:
        self.promote_due()
        items: list[dict] = []
        while True:
            raw = self._redis.lpop(self._key)
            if raw is None:
                break
            items.append(_decode(raw))
        return items

    def reserve(self, timeout: float = 1) -> dict | None:
        self.promote_due()
        raw = self._redis.blpop(self._key, timeout=max(1, int(timeout)))
        if raw is None:
            return None
        _key, body = raw
        return _decode(body)

    def retry(self, payload: dict, delay_seconds: float) -> None:
        self._redis.zadd(self._delayed, {json.dumps(payload): time.time() + delay_seconds})

    def promote_due(self) -> None:
        now = time.time()
        raws = self._redis.zrangebyscore(self._delayed, 0, now)
        for raw in raws:
            if self._redis.zrem(self._delayed, raw):
                self._redis.rpush(self._key, raw)


def _decode(raw: object) -> dict:
    if isinstance(raw, bytes):
        raw = raw.decode()
    parsed = json.loads(str(raw))
    if not isinstance(parsed, dict):
        raise RuntimeError("queue item is not an object")
    return parsed
