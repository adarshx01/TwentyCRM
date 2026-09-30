from __future__ import annotations

import uuid
from typing import Protocol

import httpx

from conversation.crm.proposal import ActionProposal, CompanyProposal, PersonProposal
from conversation.models import Tenant


class CrmClient(Protocol):
    def find_company_by_domain(self, domain: str) -> str | None: ...

    def create_company(self, company: CompanyProposal) -> str: ...

    def find_person_by_email(self, email: str) -> str | None: ...

    def create_person(self, person: PersonProposal, company_id: str | None) -> str: ...

    def create_opportunity(
        self,
        proposal: ActionProposal,
        *,
        person_id: str,
        company_id: str | None,
    ) -> str: ...

    def create_note(
        self,
        proposal: ActionProposal,
        *,
        person_id: str,
        company_id: str | None,
        opportunity_id: str,
    ) -> str: ...

    def create_task(
        self,
        proposal: ActionProposal,
        *,
        person_id: str,
        company_id: str | None,
        opportunity_id: str,
    ) -> str: ...


class FakeCrmClient:
    """In-memory Twenty stand-in. Records calls and never deletes."""

    def __init__(self) -> None:
        self.companies: dict[str, str] = {}
        self.people: dict[str, str] = {}
        self.calls: list[tuple[str, str]] = []
        self.fail_steps: set[str] = set()

    def find_company_by_domain(self, domain: str) -> str | None:
        self.calls.append(("find_company", domain))
        return self.companies.get(domain.lower())

    def create_company(self, company: CompanyProposal) -> str:
        self._maybe_fail("company")
        self.calls.append(("create_company", company.domain_name))
        record_id = f"company_{uuid.uuid4().hex[:8]}"
        self.companies[company.domain_name.lower()] = record_id
        return record_id

    def find_person_by_email(self, email: str) -> str | None:
        self.calls.append(("find_person", email))
        return self.people.get(email.lower())

    def create_person(self, person: PersonProposal, company_id: str | None) -> str:
        self._maybe_fail("person")
        self.calls.append(("create_person", person.email))
        record_id = f"person_{uuid.uuid4().hex[:8]}"
        self.people[person.email.lower()] = record_id
        return record_id

    def create_opportunity(
        self,
        proposal: ActionProposal,
        *,
        person_id: str,
        company_id: str | None,
    ) -> str:
        self._maybe_fail("opportunity")
        self.calls.append(("create_opportunity", proposal.opportunity.name))
        return f"opp_{uuid.uuid4().hex[:8]}"

    def create_note(
        self,
        proposal: ActionProposal,
        *,
        person_id: str,
        company_id: str | None,
        opportunity_id: str,
    ) -> str:
        self._maybe_fail("note")
        self.calls.append(("create_note", proposal.note.title if proposal.note else ""))
        return f"note_{uuid.uuid4().hex[:8]}"

    def create_task(
        self,
        proposal: ActionProposal,
        *,
        person_id: str,
        company_id: str | None,
        opportunity_id: str,
    ) -> str:
        self._maybe_fail("task")
        self.calls.append(("create_task", proposal.task.title if proposal.task else ""))
        return f"task_{uuid.uuid4().hex[:8]}"

    def _maybe_fail(self, step: str) -> None:
        if step in self.fail_steps:
            raise RuntimeError(f"injected failure on {step}")


def _unwrap_record(body: object, singular: str) -> dict:
    data = body
    if isinstance(body, dict) and "data" in body:
        data = body["data"]
    if not isinstance(data, dict):
        raise RuntimeError(f"unexpected Twenty payload for {singular}")
    named = data.get(singular)
    if isinstance(named, dict):
        return named
    return data


def _unwrap_list(body: object, plural: str) -> list[dict]:
    data = body
    if isinstance(body, dict) and "data" in body:
        data = body["data"]
    if isinstance(data, list):
        return [row for row in data if isinstance(row, dict)]
    if isinstance(data, dict):
        rows = data.get(plural, [])
        if isinstance(rows, list):
            return [row for row in rows if isinstance(row, dict)]
    return []


class HttpTwentyClient:
    """Workspace-scoped Twenty REST client. No delete calls.

    The API key is resolved at construction from a secret reference. It is not logged.
    """

    def __init__(self, base_url: str, api_key: str, workspace_id: str, transport: httpx.BaseTransport | None = None) -> None:
        self.workspace_id = workspace_id
        self._http = httpx.Client(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            transport=transport,
            timeout=30.0,
        )

    def close(self) -> None:
        self._http.close()

    def find_company_by_domain(self, domain: str) -> str | None:
        filt = f'domainName.primaryLinkUrl[eq]:"{domain}"'
        body = self._request("GET", "/rest/companies", params={"filter": filt, "limit": 1})
        rows = _unwrap_list(body, "companies")
        if not rows:
            return None
        return str(rows[0].get("id"))

    def create_company(self, company: CompanyProposal) -> str:
        body = self._request(
            "POST",
            "/rest/companies",
            json={
                "name": company.name,
                "domainName": {"primaryLinkLabel": company.domain_name, "primaryLinkUrl": company.domain_name},
            },
        )
        return str(_unwrap_record(body, "company")["id"])

    def find_person_by_email(self, email: str) -> str | None:
        filt = f'emails.primaryEmail[eq]:"{email}"'
        body = self._request("GET", "/rest/people", params={"filter": filt, "limit": 1})
        rows = _unwrap_list(body, "people")
        if not rows:
            return None
        return str(rows[0].get("id"))

    def create_person(self, person: PersonProposal, company_id: str | None) -> str:
        payload: dict = {
            "name": {"firstName": person.name, "lastName": ""},
            "emails": {"primaryEmail": person.email},
        }
        if person.phone:
            payload["phones"] = {"primaryPhoneNumber": person.phone, "primaryPhoneCallingCode": ""}
        if person.job_title:
            payload["jobTitle"] = person.job_title
        if company_id:
            payload["companyId"] = company_id
        body = self._request("POST", "/rest/people", json=payload)
        return str(_unwrap_record(body, "person")["id"])

    def create_opportunity(
        self,
        proposal: ActionProposal,
        *,
        person_id: str,
        company_id: str | None,
    ) -> str:
        opp = proposal.opportunity
        payload: dict = {
            "name": opp.name,
            "stage": opp.stage,
            "pointOfContactId": person_id,
        }
        if company_id:
            payload["companyId"] = company_id
        if opp.amount is not None:
            payload["amount"] = {"amountMicros": int(opp.amount * 1_000_000), "currencyCode": "USD"}
        if opp.source:
            payload["source"] = opp.source
        if opp.solution_interest:
            payload["solutionInterest"] = opp.solution_interest
        body = self._request("POST", "/rest/opportunities", json=payload)
        return str(_unwrap_record(body, "opportunity")["id"])

    def create_note(
        self,
        proposal: ActionProposal,
        *,
        person_id: str,
        company_id: str | None,
        opportunity_id: str,
    ) -> str:
        if proposal.note is None:
            raise RuntimeError("note step requires a note")
        body = self._request(
            "POST",
            "/rest/notes",
            json={"title": proposal.note.title, "bodyV2": {"markdown": proposal.note.body}},
        )
        note_id = str(_unwrap_record(body, "note")["id"])
        self._request(
            "POST",
            "/rest/noteTargets",
            json={"noteId": note_id, "targetOpportunityId": opportunity_id, "targetPersonId": person_id},
        )
        return note_id

    def create_task(
        self,
        proposal: ActionProposal,
        *,
        person_id: str,
        company_id: str | None,
        opportunity_id: str,
    ) -> str:
        if proposal.task is None:
            raise RuntimeError("task step requires a task")
        payload: dict = {"title": proposal.task.title, "status": "TODO"}
        if proposal.task.due_at is not None:
            payload["dueAt"] = proposal.task.due_at.isoformat()
        if proposal.task.body:
            payload["bodyV2"] = {"markdown": proposal.task.body}
        body = self._request("POST", "/rest/tasks", json=payload)
        task_id = str(_unwrap_record(body, "task")["id"])
        self._request(
            "POST",
            "/rest/taskTargets",
            json={"taskId": task_id, "targetOpportunityId": opportunity_id, "targetPersonId": person_id},
        )
        return task_id

    def _request(self, method: str, path: str, **kwargs: object) -> object:
        if method.upper() == "DELETE":
            raise RuntimeError("journal client refuses DELETE")
        response = self._http.request(method, path, **kwargs)
        response.raise_for_status()
        if not response.content:
            return {}
        return response.json()


class SecretResolver(Protocol):
    def resolve(self, ref: str) -> str: ...


class EnvSecretResolver:
    """Resolves env://NAME. secret:// refs fail closed until a vault exists."""

    def resolve(self, ref: str) -> str:
        import os

        if ref.startswith("env://"):
            name = ref.removeprefix("env://")
            value = os.environ.get(name)
            if not value:
                raise RuntimeError("referenced environment variable is empty")
            return value
        raise RuntimeError("secret:// references are not resolved in this build")


class HttpCrmFactory:
    def __init__(self, resolver: SecretResolver) -> None:
        self.resolver = resolver

    def for_tenant(self, tenant: Tenant) -> HttpTwentyClient:
        key = self.resolver.resolve(tenant.twenty_api_key_ref)
        return HttpTwentyClient(tenant.twenty_base_url, key, tenant.twenty_workspace_id)
