from __future__ import annotations

from dataclasses import dataclass, field


LABELS = {
    "name": "name",
    "email": "email",
    "company": "company",
    "domain": "domain_name",
    "phone": "phone",
    "stage": "stage",
    "title": "job_title",
    "job title": "job_title",
    "solution": "solution_interest",
    "message": "message",
    "source": "source",
    "amount": "amount",
}


@dataclass
class ParsedIntake:
    alias: str | None
    message_id: str | None
    fields: dict[str, str] = field(default_factory=dict)
    unknown_labels: list[str] = field(default_factory=list)


def parse_labelled_email(raw: str) -> ParsedIntake:
    """Split a labelled form email. Free prose is not turned into CRM fields."""
    header_text, _, body = raw.replace("\r\n", "\n").partition("\n\n")
    if not body and "\n" in header_text and ":" in header_text.split("\n", 1)[0]:
        # Allow a body-only fixture with no blank line after headers when To/Message-Id are present.
        lines = header_text.split("\n")
        split_at = 0
        for index, line in enumerate(lines):
            if line.strip() == "":
                split_at = index
                break
            name = line.split(":", 1)[0].strip().lower()
            if name not in {"to", "from", "subject", "message-id", "date"} and index > 0:
                split_at = index
                break
        else:
            split_at = len(lines)
        header_text = "\n".join(lines[:split_at])
        body = "\n".join(lines[split_at:])

    headers: dict[str, str] = {}
    for line in header_text.split("\n"):
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        headers[key.strip().lower()] = value.strip()

    alias = _alias_from_to(headers.get("to", ""))
    message_id = headers.get("message-id")
    if message_id:
        message_id = message_id.strip().strip("<>")

    fields: dict[str, str] = {}
    unknown: list[str] = []
    for line in body.split("\n"):
        if not line.strip() or ":" not in line:
            continue
        label, value = line.split(":", 1)
        key = LABELS.get(label.strip().lower())
        if key is None:
            unknown.append(label.strip())
            continue
        fields[key] = value.strip()
    return ParsedIntake(alias=alias, message_id=message_id, fields=fields, unknown_labels=unknown)


def _alias_from_to(to_header: str) -> str | None:
    if not to_header:
        return None
    address = to_header.split(",")[0].strip()
    if "<" in address and ">" in address:
        address = address[address.find("<") + 1 : address.find(">")]
    local = address.split("@", 1)[0]
    if "+" in local:
        return local.split("+", 1)[1] or None
    return local or None


def card_from_fields(fields: dict[str, str]) -> dict:
    person: dict = {}
    if "name" in fields:
        person["name"] = fields["name"]
    if "email" in fields:
        person["email"] = fields["email"]
    if "phone" in fields:
        person["phone"] = fields["phone"]
    if "job_title" in fields:
        person["job_title"] = fields["job_title"]
    opportunity: dict = {}
    if "name" in fields and "company" in fields:
        opportunity["name"] = f"{fields['company']} — inbound"
    elif "name" in fields:
        opportunity["name"] = f"{fields['name']} — inbound"
    if "stage" in fields:
        opportunity["stage"] = fields["stage"]
    if "source" in fields:
        opportunity["source"] = fields["source"]
    if "solution_interest" in fields:
        opportunity["solution_interest"] = fields["solution_interest"]
    if "amount" in fields:
        opportunity["amount"] = float(fields["amount"])
    card: dict = {"person": person, "opportunity": opportunity}
    if "company" in fields and "domain_name" in fields:
        card["company"] = {"name": fields["company"], "domain_name": fields["domain_name"]}
    if "message" in fields:
        card["note"] = {"title": "Intake", "body": fields["message"]}
    # tenant_id in the body is not a label we map. It lands in unknown_labels.
    return card
