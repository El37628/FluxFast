"""Prove the shared adapter application scenarios are real FastAPI behavior."""

from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from tests.browser.backend import app

HEADERS = {
    "X-FluxFast": "1", "X-FluxFast-Protocol": "1",
    "X-FluxFast-Capabilities": "deferred-resources,live-resources",
}


def test_contract_ssr_input_preserves_duplicate_query_and_request_identity() -> None:
    with TestClient(app) as client:
        response = client.get(
            f"/contract/42?run={uuid4()}&tag=one&tag=two",
            headers={
                **HEADERS,
                "Cookie": "fixture_session=fixture",
                "Authorization": "Bearer fixture",
            },
        )
    assert response.status_code == 200
    payload = response.json()["resources"]["contract-context"]["value"]
    assert payload["number"] == 42
    assert payload["query"]["tag"] == ["one", "two"]
    assert payload["cookie"] == "fixture"
    assert payload["authorization"] == "Bearer fixture"


@pytest.mark.parametrize(
    ("action", "key", "operation", "expected"),
    [
        (
            "replace",
            "contract-counter",
            "replace-resource",
            {"value": 10, "label": "changed"},
        ),
        ("merge", "contract-counter", "merge-object", {"value": 0, "label": "changed"}),
        (
            "replace-item",
            "contract-items",
            "replace-item",
            [{"id": 1, "name": "changed"}, {"id": 2, "name": "two"}],
        ),
        ("remove-item", "contract-items", "remove-item", [{"id": 1, "name": "one"}]),
        (
            "append",
            "contract-items",
            "append-item",
            [
                {"id": 1, "name": "one"},
                {"id": 2, "name": "two"},
                {"id": 3, "name": "changed"},
            ],
        ),
    ],
)
def test_patch_fixture_changes_authoritative_resource_and_matches_wire_operation(
    action: str, key: str, operation: str, expected: object
) -> None:
    run = str(uuid4())
    with TestClient(app) as client:
        response = client.post(
            "/contract-action",
            headers=HEADERS,
            json={"run": run, "action": action, "label": "changed"},
        )
        assert response.status_code == 200
        assert response.json()["mutation"]["patches"][key][0]["op"] == operation
        canonical = client.get(
            f"/contract/0?run={run}", headers={**HEADERS, "X-FluxFast-Only": key}
        )
        assert canonical.status_code == 200
        assert canonical.json()["resources"][key]["value"] == expected


def test_fixture_validation_and_scopes_are_isolated_between_runs() -> None:
    first, second = str(uuid4()), str(uuid4())
    with TestClient(app) as client:
        invalid = client.post(
            "/contract-action",
            headers=HEADERS,
            json={"run": first, "action": "replace", "label": "x"},
        )
        assert invalid.status_code == 422
        client.post(
            "/contract-action",
            headers=HEADERS,
            json={"run": first, "action": "replace", "label": "changed"},
        ).raise_for_status()
        canonical = client.get(f"/contract/0?run={second}", headers=HEADERS)
        assert canonical.json()["resources"]["contract-counter"]["value"] == {
            "value": 0,
            "label": "initial",
        }


def test_fixture_can_trigger_a_resource_error_and_recover_without_navigating() -> None:
    run = str(uuid4())
    with TestClient(app) as client:
        for fail in (True, False):
            client.post(
                f"/contract-control/{run}", json={"fail": fail, "value": 5}
            ).raise_for_status()
            response = client.get(
                f"/contract/0?run={run}",
                headers={**HEADERS, "X-FluxFast-Only": "contract-counter"},
            )
            envelope = response.json()
            if fail:
                assert response.status_code == 500
                assert envelope["error"]["type"] == "ResourceError"
            else:
                assert response.status_code == 200
                assert envelope["page"]["url"] == f"/contract/0?run={run}"
                assert envelope["resources"]["contract-counter"]["value"] == {
                    "value": 5,
                    "label": "initial",
                }


def test_redirect_fixture_provides_real_backend_redirect_responses() -> None:
    with TestClient(app) as client:
        internal = client.get("/contract-canonical", follow_redirects=False)
        external = client.get(
            "/contract-external-redirect?target=https://outside.fluxfast.invalid/forbidden",
            follow_redirects=False,
        )
    assert internal.status_code == 307
    assert internal.headers["location"] == "/rooms"
    assert external.status_code == 307
    assert external.headers["location"] == "https://outside.fluxfast.invalid/forbidden"
