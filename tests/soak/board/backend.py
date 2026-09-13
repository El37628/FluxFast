"""Functional, test-only operations board for the v1.0 real-application soak.

Run this application only in the isolated loopback consumer. Seed credentials
are public test data, not a production authentication implementation. Importing
the module for schema generation does not create a database or run loaders.
"""

import asyncio
import hashlib
import os
import secrets
import sqlite3
import sys
import threading
import time
from collections import Counter
from contextlib import contextmanager
from importlib.metadata import version
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fluxfast import FluxFast, Page, invalidate_resource, mutation, resource, scope
from pydantic import BaseModel, Field, field_validator

TEST_PASSWORD = "soak-password"
SESSION_COOKIE = "fluxfast_soak_session"


class Viewer(BaseModel):
    user_id: str
    tenant_id: str
    name: str
    email: str
    role: Literal["admin", "member"]


class Workspace(BaseModel):
    id: str
    name: str
    release: str


class Task(BaseModel):
    id: int
    tenant_id: str
    title: str
    description: str
    owner_id: str
    priority: Literal["low", "normal", "urgent"]
    status: Literal["todo", "in-progress", "done"]
    revision: int


class Assignment(BaseModel):
    owner_id: str = Field(min_length=1, max_length=40)
    note: str = Field(min_length=2, max_length=120)

    @field_validator("note")
    @classmethod
    def reject_reserved_note(cls, value: str) -> str:
        # Deliberately server-only business validation, absent from JSON Schema.
        if value.casefold() == "restricted":
            raise ValueError("Assignment note is reserved")
        return value


class TaskInput(BaseModel):
    title: str = Field(min_length=3, max_length=80)
    description: str = Field(max_length=1000)
    priority: Literal["low", "normal", "urgent"]
    assignment: Assignment


class StatusInput(BaseModel):
    status: Literal["todo", "in-progress", "done"]


class CommentInput(BaseModel):
    text: str = Field(min_length=2, max_length=500)


class ProfileInput(BaseModel):
    name: str = Field(min_length=2, max_length=80)


class LoginInput(BaseModel):
    user_id: str = Field(min_length=1, max_length=40)
    password: str = Field(min_length=1, max_length=80)


class Comment(BaseModel):
    id: int
    author_id: str
    text: str


class TaskDetail(BaseModel):
    task: Task
    comments: list[Comment]


class Summary(BaseModel):
    total: int
    todo: int
    in_progress: int
    done: int
    urgent: int


class Activity(BaseModel):
    id: int
    actor_id: str
    message: str


def business_error(location: tuple[str, ...], message: str) -> None:
    raise RequestValidationError([
        {"type": "value_error", "loc": ("body", *location), "msg": message}
    ])


class BoardStore:
    """Parameterized SQLite storage; every business query enforces tenant ID."""

    def __init__(self, path: Path):
        self.path = path
        self.loads: Counter[tuple[str, str]] = Counter()
        self._initialized = False
        self._initialize_lock = threading.Lock()

    def _initialize(self, connection: sqlite3.Connection) -> None:
        connection.executescript("""
            CREATE TABLE IF NOT EXISTS workspaces (
                id TEXT PRIMARY KEY, name TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
                email TEXT NOT NULL, role TEXT NOT NULL, salt TEXT NOT NULL,
                password_hash TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL,
                expires INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL,
                title TEXT NOT NULL, description TEXT NOT NULL, owner_id TEXT NOT NULL,
                priority TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL,
                UNIQUE(tenant_id, title)
            );
            CREATE TABLE IF NOT EXISTS comments (
                id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL,
                tenant_id TEXT NOT NULL, author_id TEXT NOT NULL, text TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS activity (
                id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL,
                actor_id TEXT NOT NULL, message TEXT NOT NULL
            );
        """)
        with connection:
            new_install = connection.execute("SELECT COUNT(*) FROM workspaces").fetchone()[0] == 0
            for tenant, name in [("alpha", "Alpha Operations"), ("beta", "Beta Operations")]:
                connection.execute("INSERT OR IGNORE INTO workspaces VALUES (?, ?)", (tenant, name))
            for user, tenant, name, role in [
                ("alice", "alpha", "Alice", "admin"),
                ("bob", "alpha", "Bob", "member"),
                ("carol", "beta", "Carol", "admin"),
            ]:
                salt = f"public-soak-salt-{user}"
                digest = self._password_hash(TEST_PASSWORD, salt)
                connection.execute(
                    "INSERT OR IGNORE INTO users VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (user, tenant, name, f"{user}@soak.invalid", role, salt, digest),
                )
            # Seed once. A restart must preserve edits and deletions, including
            # deletions of original tasks rather than just newly created ones.
            for index in range(1, 61) if new_install else ():
                tenant = "alpha" if index <= 30 else "beta"
                owner = "alice" if index % 2 else "bob"
                if tenant == "beta":
                    owner = "carol"
                connection.execute(
                    "INSERT OR IGNORE INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (index, tenant, f"{tenant.title()} task {index}",
                     "Review the operational release checklist", owner,
                     "urgent" if index % 5 == 0 else "normal", "todo", 1),
                )

    @staticmethod
    def _password_hash(password: str, salt: str) -> str:
        return hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 15_000).hex()

    @contextmanager
    def connection(self):
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        try:
            if not self._initialized:
                with self._initialize_lock:
                    if not self._initialized:
                        self._initialize(connection)
                        self._initialized = True
            with connection:
                yield connection
        finally:
            connection.close()

    def login(self, body: LoginInput) -> str:
        with self.connection() as connection:
            user = connection.execute("SELECT * FROM users WHERE id = ?", (body.user_id,)).fetchone()
            if user is None or not secrets.compare_digest(
                self._password_hash(body.password, user["salt"]), user["password_hash"]
            ):
                raise HTTPException(401, "Invalid test credentials")
            token = secrets.token_urlsafe(32)
            connection.execute("DELETE FROM sessions WHERE expires <= ?", (int(time.time()),))
            connection.execute(
                "INSERT INTO sessions VALUES (?, ?, ?)",
                (hashlib.sha256(token.encode()).hexdigest(), body.user_id, int(time.time()) + 3600),
            )
            return token

    def viewer(self, request: Request) -> Viewer | None:
        token = request.cookies.get(SESSION_COOKIE)
        if not token:
            return None
        with self.connection() as connection:
            row = connection.execute(
                "SELECT users.* FROM users JOIN sessions ON users.id = sessions.user_id "
                "WHERE sessions.token_hash = ? AND sessions.expires > ?",
                (hashlib.sha256(token.encode()).hexdigest(), int(time.time())),
            ).fetchone()
            if row is None:
                return None
            return Viewer(user_id=row["id"], tenant_id=row["tenant_id"],
                          name=row["name"], email=row["email"], role=row["role"])

    def require_viewer(self, request: Request) -> Viewer:
        viewer = self.viewer(request)
        if viewer is None:
            raise HTTPException(401, "A test session is required")
        return viewer

    def logout(self, request: Request) -> None:
        token = request.cookies.get(SESSION_COOKIE, "")
        with self.connection() as connection:
            connection.execute("DELETE FROM sessions WHERE token_hash = ?",
                               (hashlib.sha256(token.encode()).hexdigest(),))

    def workspace(self, tenant: str) -> dict:
        self.loads[tenant, "workspace"] += 1
        with self.connection() as connection:
            row = connection.execute("SELECT * FROM workspaces WHERE id = ?", (tenant,)).fetchone()
            return {**dict(row), "release": "Stable promotion rehearsal"}

    def tasks(self, tenant: str) -> list[dict]:
        self.loads[tenant, "tasks"] += 1
        with self.connection() as connection:
            return [dict(row) for row in connection.execute(
                "SELECT * FROM tasks WHERE tenant_id = ? ORDER BY id", (tenant,)
            )]

    def task(self, connection: sqlite3.Connection, viewer: Viewer, task_id: int, *, edit=False):
        row = connection.execute("SELECT * FROM tasks WHERE tenant_id = ? AND id = ?",
                                 (viewer.tenant_id, task_id)).fetchone()
        if row is None:
            raise HTTPException(404, "Task not found")
        if edit and viewer.role != "admin" and row["owner_id"] != viewer.user_id:
            raise HTTPException(403, "Only an owner or administrator can edit this task")
        return row

    def detail(self, viewer: Viewer, task_id: int) -> dict:
        self.loads[viewer.tenant_id, "task-detail"] += 1
        with self.connection() as connection:
            task = self.task(connection, viewer, task_id)
            comments = connection.execute(
                "SELECT id, author_id, text FROM comments WHERE tenant_id = ? AND task_id = ? ORDER BY id",
                (viewer.tenant_id, task_id),
            )
            return {"task": dict(task), "comments": [dict(row) for row in comments]}

    def members(self, tenant: str) -> list[dict]:
        self.loads[tenant, "members"] += 1
        with self.connection() as connection:
            return [dict(row) for row in connection.execute(
                "SELECT id AS user_id, tenant_id, name, email, role FROM users WHERE tenant_id = ? ORDER BY id",
                (tenant,),
            )]

    async def summary(self, tenant: str) -> dict:
        self.loads[tenant, "summary"] += 1
        await asyncio.sleep(0.04)
        with self.connection() as connection:
            rows = list(connection.execute("SELECT status, priority FROM tasks WHERE tenant_id = ?", (tenant,)))
        counts = Counter(row["status"] for row in rows)
        return {"total": len(rows), "todo": counts["todo"], "in_progress": counts["in-progress"],
                "done": counts["done"], "urgent": sum(row["priority"] == "urgent" for row in rows)}

    async def activity(self, tenant: str) -> list[dict]:
        self.loads[tenant, "activity"] += 1
        await asyncio.sleep(0.04)
        with self.connection() as connection:
            return [dict(row) for row in connection.execute(
                "SELECT id, actor_id, message FROM activity WHERE tenant_id = ? ORDER BY id DESC LIMIT 25",
                (tenant,),
            )]

    @staticmethod
    def record(connection: sqlite3.Connection, viewer: Viewer, message: str) -> None:
        connection.execute("INSERT INTO activity (tenant_id, actor_id, message) VALUES (?, ?, ?)",
                           (viewer.tenant_id, viewer.user_id, message))
        connection.execute(
            "DELETE FROM activity WHERE tenant_id = ? AND id NOT IN "
            "(SELECT id FROM activity WHERE tenant_id = ? ORDER BY id DESC LIMIT 25)",
            (viewer.tenant_id, viewer.tenant_id),
        )

    @staticmethod
    def check_assignment(connection: sqlite3.Connection, viewer: Viewer, owner: str) -> None:
        member = connection.execute("SELECT id FROM users WHERE tenant_id = ? AND id = ?",
                                    (viewer.tenant_id, owner)).fetchone()
        if member is None:
            business_error(("assignment", "owner_id"), "Assignee must belong to this workspace")
        if viewer.role != "admin" and owner != viewer.user_id:
            raise HTTPException(403, "Members can assign only their own tasks")

    def create_task(self, viewer: Viewer, body: TaskInput) -> int:
        with self.connection() as connection:
            self.check_assignment(connection, viewer, body.assignment.owner_id)
            try:
                cursor = connection.execute(
                    "INSERT INTO tasks (tenant_id, title, description, owner_id, priority, status, revision) "
                    "VALUES (?, ?, ?, ?, ?, 'todo', 1)",
                    (viewer.tenant_id, body.title, body.description, body.assignment.owner_id, body.priority),
                )
            except sqlite3.IntegrityError:
                business_error(("title",), "Task title must be unique in this workspace")
            self.record(connection, viewer, f"Created {body.title}")
            return cursor.lastrowid

    def update_task(self, viewer: Viewer, task_id: int, body: TaskInput) -> None:
        with self.connection() as connection:
            self.task(connection, viewer, task_id, edit=True)
            self.check_assignment(connection, viewer, body.assignment.owner_id)
            try:
                connection.execute(
                    "UPDATE tasks SET title = ?, description = ?, owner_id = ?, priority = ?, revision = revision + 1 "
                    "WHERE tenant_id = ? AND id = ?",
                    (body.title, body.description, body.assignment.owner_id, body.priority, viewer.tenant_id, task_id),
                )
            except sqlite3.IntegrityError:
                business_error(("title",), "Task title must be unique in this workspace")
            self.record(connection, viewer, f"Updated {body.title}")

    def set_status(self, viewer: Viewer, task_id: int, body: StatusInput) -> None:
        with self.connection() as connection:
            task = self.task(connection, viewer, task_id, edit=True)
            connection.execute("UPDATE tasks SET status = ?, revision = revision + 1 WHERE tenant_id = ? AND id = ?",
                               (body.status, viewer.tenant_id, task_id))
            self.record(connection, viewer, f"Moved {task['title']} to {body.status}")

    def comment(self, viewer: Viewer, task_id: int, body: CommentInput) -> None:
        with self.connection() as connection:
            task = self.task(connection, viewer, task_id)
            connection.execute("INSERT INTO comments (task_id, tenant_id, author_id, text) VALUES (?, ?, ?, ?)",
                               (task_id, viewer.tenant_id, viewer.user_id, body.text))
            self.record(connection, viewer, f"Commented on {task['title']}")

    def delete_task(self, viewer: Viewer, task_id: int) -> None:
        with self.connection() as connection:
            task = self.task(connection, viewer, task_id, edit=True)
            connection.execute("DELETE FROM comments WHERE tenant_id = ? AND task_id = ?", (viewer.tenant_id, task_id))
            connection.execute("DELETE FROM tasks WHERE tenant_id = ? AND id = ?", (viewer.tenant_id, task_id))
            self.record(connection, viewer, f"Deleted {task['title']}")

    def profile(self, viewer: Viewer, body: ProfileInput) -> None:
        with self.connection() as connection:
            connection.execute("UPDATE users SET name = ? WHERE tenant_id = ? AND id = ?",
                               (body.name, viewer.tenant_id, viewer.user_id))


def create_app(database_path: Path | None = None) -> FastAPI:
    app = FastAPI()
    store = BoardStore(database_path or Path(os.environ.get("FLUXFAST_SOAK_DB", "board.sqlite3")))
    # Short rotations exercise ordinary, authorization-rechecking SSE reconnects
    # during an accelerated workload without changing library defaults.
    flux = FluxFast(app, live_max_connection_age=2, live_heartbeat_interval=0.2)
    app.state.board = store
    app.state.board_flux = flux

    viewer_contract = flux.define_resource("viewer", Viewer)
    workspace_contract = flux.define_resource("workspace", Workspace)
    tasks_contract = flux.define_resource("tasks", list[Task])
    members_contract = flux.define_resource("members", list[Viewer])
    summary_contract = flux.define_resource("summary", Summary)
    activity_contract = flux.define_resource("activity", list[Activity])
    detail_contract = flux.define_resource("task-detail", TaskDetail)
    for name, model in [("TaskInput", TaskInput), ("CommentInput", CommentInput),
                        ("ProfileInput", ProfileInput), ("LoginInput", LoginInput)]:
        flux.define_type(name, model, mode="validation")

    def user_scope(viewer: Viewer):
        return scope.user(f"{viewer.tenant_id}:{viewer.user_id}")

    def detail_scope(viewer: Viewer, task_id: int):
        return scope.custom("board-task", f"{viewer.tenant_id}:{task_id}")

    def page(request: Request, component: str, *, task_id: int | None = None) -> Page:
        viewer = store.viewer(request)
        if viewer is None:
            # An authenticated page can render its login challenge at the
            # requested URL. No private resources or live topics are declared.
            return Page(component="login/index", resources=[])
        tenant_scope = scope.tenant(viewer.tenant_id)
        if task_id is not None:
            # Authorize before declaring a cached/deferred/live resource graph.
            with store.connection() as connection:
                store.task(connection, viewer, task_id)
        resources = [
            resource(viewer_contract, lambda: viewer.model_dump(), scope=user_scope(viewer), ttl=600),
            resource(workspace_contract, lambda: store.workspace(viewer.tenant_id), scope=tenant_scope, ttl=600),
            resource(tasks_contract, lambda: store.tasks(viewer.tenant_id), scope=tenant_scope, ttl=600, live=True),
            resource(members_contract, lambda: store.members(viewer.tenant_id), scope=tenant_scope, ttl=600, live=True),
            resource(summary_contract, lambda: store.summary(viewer.tenant_id), scope=tenant_scope,
                     ttl=600, defer=True, live=True),
            resource(activity_contract, lambda: store.activity(viewer.tenant_id), scope=tenant_scope,
                     ttl=600, defer=True, live=True),
        ]
        if task_id is not None:
            resources.append(resource(detail_contract, lambda: store.detail(viewer, task_id),
                                      scope=detail_scope(viewer, task_id), ttl=600, live=True))
        return Page(component=component, resources=resources, meta={"taskId": task_id})

    @flux.page("/", name="dashboard")
    async def dashboard(request: Request) -> Page:
        return page(request, "home/index")

    @flux.page("/tasks", name="task_board")
    async def task_board(request: Request) -> Page:
        return page(request, "tasks/index")

    @flux.page("/tasks/{task_id}", name="task_detail")
    async def task_detail(request: Request, task_id: int) -> Page:
        return page(request, "task/index", task_id=task_id)

    @flux.page("/team", name="team")
    async def team(request: Request) -> Page:
        return page(request, "team/index")

    @flux.page("/reports", name="reports")
    async def reports(request: Request) -> Page:
        return page(request, "reports/index")

    @flux.page("/search", name="search")
    async def search(request: Request) -> Page:
        return page(request, "search/index")

    @flux.page("/settings", name="settings")
    async def settings(request: Request) -> Page:
        return page(request, "settings/index")

    @flux.page("/login", name="login")
    async def login_page() -> Page:
        return Page(component="login/index", resources=[])

    @app.post("/session")
    async def login(body: LoginInput):
        token = store.login(body)
        response = JSONResponse({"authenticated": True})
        response.set_cookie(SESSION_COOKIE, token, httponly=True, samesite="lax", max_age=3600)
        return response

    @app.post("/session/logout")
    async def logout(request: Request):
        store.logout(request)
        response = JSONResponse({"authenticated": False})
        response.delete_cookie(SESSION_COOKIE, httponly=True, samesite="lax")
        return response

    def changed(viewer: Viewer, task_id: int | None = None, *, redirect: str | None = None):
        invalidations = [invalidate_resource(key, scope=scope.tenant(viewer.tenant_id))
                         for key in ("tasks", "summary", "activity")]
        if task_id is not None:
            invalidations.append(invalidate_resource("task-detail", scope=detail_scope(viewer, task_id)))
        return mutation(invalidates=invalidations, redirect=redirect)

    @flux.mutation("/tasks", name="create_task")
    async def create_task(request: Request, body: TaskInput):
        viewer = store.require_viewer(request)
        store.create_task(viewer, body)
        return changed(viewer)

    @flux.mutation("/tasks/{task_id}/update", name="update_task")
    async def update_task(request: Request, task_id: int, body: TaskInput):
        viewer = store.require_viewer(request)
        store.update_task(viewer, task_id, body)
        return changed(viewer, task_id)

    @flux.mutation("/tasks/{task_id}/status", name="set_task_status")
    async def set_task_status(request: Request, task_id: int, body: StatusInput):
        viewer = store.require_viewer(request)
        store.set_status(viewer, task_id, body)
        return changed(viewer, task_id)

    @flux.mutation("/tasks/{task_id}/comments", name="comment_task")
    async def comment_task(request: Request, task_id: int, body: CommentInput):
        viewer = store.require_viewer(request)
        store.comment(viewer, task_id, body)
        return changed(viewer, task_id)

    @flux.mutation("/tasks/{task_id}/delete", name="delete_task")
    async def delete_task(request: Request, task_id: int):
        viewer = store.require_viewer(request)
        store.delete_task(viewer, task_id)
        return changed(viewer, task_id, redirect="/tasks")

    @flux.mutation("/profile", name="update_profile")
    async def update_profile(request: Request, body: ProfileInput):
        viewer = store.require_viewer(request)
        store.profile(viewer, body)
        return mutation(invalidates=[
            invalidate_resource("viewer", scope=user_scope(viewer)),
            invalidate_resource("members", scope=scope.tenant(viewer.tenant_id)),
        ])

    @app.get("/_soak/environment")
    async def environment():
        return {"fluxfast": version("fluxfast"), "python": sys.version.split()[0],
                "sqlite": sqlite3.sqlite_version, "deployment": "single-worker-memory"}

    @app.get("/_soak/stats")
    async def stats(request: Request):
        viewer = store.require_viewer(request)
        return {"loads": {key: count for (tenant, key), count in store.loads.items()
                          if tenant == viewer.tenant_id}, "tenant": viewer.tenant_id}

    return app


app = create_app()
