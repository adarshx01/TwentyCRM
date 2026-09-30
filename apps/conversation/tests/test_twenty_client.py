import httpx

from conversation.crm.client import HttpTwentyClient
from conversation.crm.proposal import ActionProposal
from tests.conftest import sample_card


def test_http_client_posts_and_has_no_delete_path():
    seen: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path))
        if request.method == "GET":
            return httpx.Response(200, json={"data": {"people": []}})
        return httpx.Response(200, json={"data": {"person": {"id": "per_1"}, "id": "per_1"}})

    client = HttpTwentyClient("http://twenty.test", "key", "ws", transport=httpx.MockTransport(handler))
    assert client.find_person_by_email("ada@example.com") is None
    proposal = ActionProposal.model_validate(sample_card())
    assert client.create_person(proposal.person, None) == "per_1"
    assert ("GET", "/rest/people") in seen
    assert ("POST", "/rest/people") in seen
    assert all(method != "DELETE" for method, _path in seen)
    client.close()
