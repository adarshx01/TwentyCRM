from __future__ import annotations

from dataclasses import dataclass

from conversation.errors import DomainError


@dataclass(frozen=True)
class Manifest:
    version: str
    stages: frozenset[str]


MANIFESTS: dict[str, Manifest] = {
    "2026.1": Manifest(
        version="2026.1",
        stages=frozenset(
            {
                "NEW",
                "CONTACTED",
                "QUALIFIED",
                "DEMO_SCHEDULED",
                "DEMO_COMPLETED",
                "PROPOSAL",
                "NEGOTIATION",
                "CLOSED_WON",
                "CLOSED_LOST",
            }
        ),
    )
}

CLOSED_STAGES = frozenset({"CLOSED_WON", "CLOSED_LOST"})


def get_manifest(version: str) -> Manifest:
    try:
        return MANIFESTS[version]
    except KeyError as exc:
        raise DomainError("unknown_manifest", f"manifest {version} is not registered") from exc


def assert_stage(manifest: Manifest, stage: str) -> None:
    if stage not in manifest.stages:
        raise DomainError("invalid_stage", f"stage {stage} is not in manifest {manifest.version}")
