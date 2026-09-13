"""Regressions for the business application used by the v1.0 soak."""

import importlib.util
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

BACKEND = Path(__file__).parent / "board" / "backend.py"
spec = importlib.util.spec_from_file_location("soak_board_backend", BACKEND)
backend = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backend)

HEADERS = {"X-FluxFast": "1", "X-FluxFast-Protocol": "1"}
CAPABLE = {**HEADERS, "X-FluxFast-Capabilities": "deferred-resources,live-resources"}


@pytest.fixture
def app(tmp_path):
    return backend.create_app(tmp_path / "board.sqlite3")


def login(client, user):
    response = client.post("/session", json={"user_id": user, "password": backend.TEST_PASSWORD})
    assert response.status_code == 200
    assert "HttpOnly" in response.headers["set-cookie"]
    assert "SameSite=lax" in response.headers["set-cookie"]


def body(title="Soak work item", owner="alice", note="Release rehearsal"):
    return {"title": title, "description": "Verify the production release", "priority": "normal",
            "assignment": {"owner_id": owner, "note": note}}


def test_import_and_application_creation_are_read_only(tmp_path):
    path = tmp_path / "not-created.sqlite3"
    backend.create_app(path)
    assert not path.exists()


def test_anonymous_pages_declare_no_private_resources_or_live_topics(app):
    with TestClient(app) as client:
        for path in ("/", "/tasks", "/tasks/1", "/reports", "/team", "/search", "/settings"):
            response = client.get(path, headers=CAPABLE)
            assert response.status_code == 200
            data = response.json()
            assert data["page"]["component"] == "login/index"
            assert data["resources"] == {}
            assert not data.get("live")
        assert not app.state.board.path.exists()


def test_bad_credentials_do_not_create_a_session(app):
    with TestClient(app) as client:
        response = client.post("/session", json={"user_id": "alice", "password": "wrong"})
        assert response.status_code == 401
        assert backend.SESSION_COOKIE not in client.cookies


def test_real_session_controls_tenant_not_query_or_body_fields(app):
    with TestClient(app) as client:
        login(client, "alice")
        data = client.get("/tasks?tenant=beta&user=carol", headers=HEADERS).json()
        assert data["resources"]["viewer"]["value"]["user_id"] == "alice"
        assert data["resources"]["workspace"]["value"]["id"] == "alpha"
        assert len(data["resources"]["tasks"]["value"]) == 30
        assert all(task["tenant_id"] == "alpha" for task in data["resources"]["tasks"]["value"])


def test_same_tenant_cache_reuse_and_different_tenant_isolation(app):
    with TestClient(app) as client:
        login(client, "alice")
        first = client.get("/", headers=HEADERS).json()
        login(client, "bob")
        second = client.get("/team", headers=HEADERS).json()
        assert first["resources"]["tasks"]["version"] == second["resources"]["tasks"]["version"]
        assert first["resources"]["viewer"]["value"] != second["resources"]["viewer"]["value"]
        assert app.state.board.loads["alpha", "tasks"] == 1
        login(client, "carol")
        third = client.get("/", headers=HEADERS).json()
        assert third["resources"]["workspace"]["value"]["id"] == "beta"
        assert all(task["tenant_id"] == "beta" for task in third["resources"]["tasks"]["value"])
        assert app.state.board.loads["beta", "tasks"] == 1


def test_deferred_live_reports_and_canonical_mutation_invalidation(app):
    with TestClient(app) as client:
        login(client, "alice")
        initial = client.get("/", headers=CAPABLE).json()
        assert sorted(initial["deferred"]) == ["activity", "summary"]
        assert sorted(initial["live"]) == ["activity", "members", "summary", "tasks"]
        settled = client.get("/", headers={**CAPABLE, "X-FluxFast-Only": "summary,activity"}).json()
        assert settled["resources"]["summary"]["value"]["total"] == 30
        response = client.post("/tasks", headers=HEADERS, json=body())
        assert response.status_code == 200
        assert sorted(response.json()["mutation"]["invalidate"]) == ["activity", "summary", "tasks"]
        fresh = client.get("/", headers=HEADERS).json()
        assert fresh["resources"]["summary"]["value"]["total"] == 31
        assert fresh["resources"]["summary"]["version"] != settled["resources"]["summary"]["version"]
        assert fresh["resources"]["activity"]["value"][0]["message"] == "Created Soak work item"


@pytest.mark.parametrize("path", ["/tasks/31", "/tasks/31/update", "/tasks/31/status", "/tasks/31/comments", "/tasks/31/delete"])
def test_foreign_tenant_task_access_is_rejected_before_cache_or_mutation(app, path):
    with TestClient(app) as client:
        login(client, "alice")
        if path.endswith("update"):
            response = client.post(path, headers=HEADERS, json=body())
        elif path.endswith("status"):
            response = client.post(path, headers=HEADERS, json={"status": "done"})
        elif path.endswith("comments"):
            response = client.post(path, headers=HEADERS, json={"text": "Not authorized"})
        elif path.endswith("delete"):
            response = client.post(path, headers=HEADERS)
        else:
            response = client.get(path, headers=HEADERS)
        assert response.status_code == 404
        assert app.state.board.loads["alpha", "task-detail"] == 0


def test_member_cannot_edit_another_owner_or_assign_foreign_members(app):
    with TestClient(app) as client:
        login(client, "bob")
        assert client.post("/tasks/1/status", headers=HEADERS, json={"status": "done"}).status_code == 403
        assert client.post("/tasks", headers=HEADERS, json=body(owner="alice")).status_code == 403
        response = client.post("/tasks", headers=HEADERS, json=body(owner="carol"))
        assert response.status_code == 422
        assert response.json()["error"]["details"] == {
            "assignment.owner_id": ["Assignee must belong to this workspace"]
        }


def test_native_and_server_only_validation_keep_canonical_nested_paths(app):
    with TestClient(app) as client:
        login(client, "alice")
        short = client.post("/tasks", headers=HEADERS, json=body(title="X"))
        assert short.status_code == 422
        assert "title" in short.json()["error"]["details"]
        reserved = client.post("/tasks", headers=HEADERS, json=body(note="restricted"))
        assert reserved.status_code == 422
        assert "assignment.note" in reserved.json()["error"]["details"]
        assert client.post("/tasks", headers=HEADERS, json=body()).status_code == 200
        duplicate = client.post("/tasks", headers=HEADERS, json=body())
        assert duplicate.status_code == 422
        assert duplicate.json()["error"]["details"]["title"] == ["Task title must be unique in this workspace"]


def test_complete_task_workflow_and_persistent_storage(app):
    with TestClient(app) as client:
        login(client, "alice")
        assert client.post("/tasks", headers=HEADERS, json=body()).status_code == 200
        tasks = client.get("/tasks", headers=HEADERS).json()["resources"]["tasks"]["value"]
        task_id = tasks[-1]["id"]
        assert client.post(f"/tasks/{task_id}/update", headers=HEADERS, json=body(title="Reviewed work item")).status_code == 200
        assert client.post(f"/tasks/{task_id}/status", headers=HEADERS, json={"status": "done"}).status_code == 200
        assert client.post(f"/tasks/{task_id}/comments", headers=HEADERS, json={"text": "Release verified"}).status_code == 200
        detail = client.get(f"/tasks/{task_id}", headers=HEADERS).json()["resources"]["task-detail"]["value"]
        assert detail["task"]["title"] == "Reviewed work item"
        assert detail["task"]["status"] == "done"
        assert detail["task"]["revision"] == 3
        assert detail["comments"][0]["text"] == "Release verified"
    restarted = backend.create_app(app.state.board.path)
    with TestClient(restarted) as client:
        login(client, "alice")
        assert client.get(f"/tasks/{task_id}", headers=HEADERS).status_code == 200
        response = client.post(f"/tasks/{task_id}/delete", headers=HEADERS)
        assert response.json()["mutation"]["redirect"] == "/tasks"
        assert client.get(f"/tasks/{task_id}", headers=HEADERS).status_code == 404
        assert len(client.get("/tasks", headers=HEADERS).json()["resources"]["tasks"]["value"]) == 30


def test_profile_invalidation_is_scoped_to_user_and_workspace_members(app):
    with TestClient(app) as client:
        login(client, "bob")
        before = client.get("/settings", headers=HEADERS).json()
        response = client.post("/profile", headers=HEADERS, json={"name": "Bob Release Reviewer"})
        assert sorted(response.json()["mutation"]["invalidate"]) == ["members", "viewer"]
        after = client.get("/settings", headers=HEADERS).json()
        assert after["resources"]["viewer"]["value"]["name"] == "Bob Release Reviewer"
        assert before["resources"]["viewer"]["version"] != after["resources"]["viewer"]["version"]
        login(client, "alice")
        assert client.get("/", headers=HEADERS).json()["resources"]["viewer"]["value"]["name"] == "Alice"


def test_restart_does_not_restore_a_deleted_seeded_task(app):
    with TestClient(app) as client:
        login(client, "alice")
        assert client.post("/tasks/1/delete", headers=HEADERS).status_code == 200
        assert client.get("/tasks/1", headers=HEADERS).status_code == 404
    restarted = backend.create_app(app.state.board.path)
    with TestClient(restarted) as client:
        login(client, "alice")
        assert client.get("/tasks/1", headers=HEADERS).status_code == 404


def test_logout_revokes_server_session_and_anonymous_mutations_fail(app):
    with TestClient(app) as client:
        login(client, "alice")
        old_token = client.cookies[backend.SESSION_COOKIE]
        assert client.post("/session/logout").status_code == 200
        assert backend.SESSION_COOKIE not in client.cookies
        client.cookies.set(backend.SESSION_COOKIE, old_token)
        assert client.get("/", headers=CAPABLE).json()["page"]["component"] == "login/index"
        assert client.post("/tasks", headers=HEADERS, json=body()).status_code == 401


def test_untrusted_text_is_data_not_sql(app):
    with TestClient(app) as client:
        login(client, "alice")
        title = "Release'; DROP TABLE tasks; --"
        assert client.post("/tasks", headers=HEADERS, json=body(title=title)).status_code == 200
        tasks = client.get("/tasks", headers=HEADERS).json()["resources"]["tasks"]["value"]
        assert len(tasks) == 31
        assert tasks[-1]["title"] == title
