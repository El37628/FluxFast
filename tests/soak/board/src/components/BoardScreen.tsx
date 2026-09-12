"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Link, useDeferredResource, useForm, useLiveStatus, useResource, useRouter } from "@fluxfast/next";
import { mutations } from "@/.fluxfast/mutations.generated";
import { routes } from "@/.fluxfast/routes.generated";
import { resourceKeys, type CommentInput, type LoginInput, type ProfileInput, type Task, type TaskInput, type Viewer } from "@/.fluxfast/types.generated";
import { CommentInputValidator, LoginInputValidator, ProfileInputValidator, TaskInputValidator } from "@/.fluxfast/validators.generated";

type View = "dashboard" | "tasks" | "task" | "team" | "reports" | "search" | "settings";
const titles: Record<View, string> = {
  dashboard: "Operations dashboard", tasks: "Task board", task: "Task details",
  team: "Workspace team", reports: "Release reports", search: "Search tasks", settings: "Account settings",
};

export function LoginScreen() {
  const router = useRouter();
  const form = useForm<LoginInput>({ user_id: "alice", password: "" }, { validator: LoginInputValidator });
  const [failure, setFailure] = useState("");
  const [processing, setProcessing] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.validate()) return;
    setProcessing(true);
    setFailure("");
    try {
      const response = await fetch("/session", {
        method: "POST", headers: { "Content-Type": "application/json", "X-FluxFast": "1" },
        body: JSON.stringify(form.data),
      });
      if (!response.ok) throw new Error("Invalid test credentials");
      router.clear();
      window.location.assign("/");
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Login failed");
      setProcessing(false);
    }
  };
  return <main>
    <h1>Operations Board sign in</h1>
    <p>Isolated release-soak application. Public test accounts: alice, bob, carol.</p>
    <form aria-label="Sign in" data-hydrated={hydrated} onSubmit={event => void submit(event)}>
      <label>Account<input name="account" value={form.data.user_id} onChange={event => form.setData("user_id", event.target.value)} /></label>
      <label>Password<input name="password" type="password" value={form.data.password} onChange={event => form.setData("password", event.target.value)} /></label>
      {Object.values(form.errors).map((message, index) => <p role="alert" key={index}>{message}</p>)}
      {failure && <p role="alert">{failure}</p>}
      <button type="submit" disabled={processing}>Sign in</button>
    </form>
  </main>;
}

function TaskEditor({ viewer, task }: { viewer: Viewer; task?: Task }) {
  const form = useForm<TaskInput>({
    title: task?.title ?? "", description: task?.description ?? "", priority: task?.priority ?? "normal",
    assignment: { owner_id: task?.owner_id ?? viewer.user_id, note: "Release rehearsal" },
  }, { validator: TaskInputValidator });
  const members = useResource(resourceKeys.members);
  const url = task ? `/tasks/${task.id}/update` : "/tasks";
  return <form aria-label={task ? "Edit task" : "Create task"} onSubmit={form.submit(url, {
    onSuccess: () => { if (!task) form.reset(); },
  })}>
    <h2>{task ? "Edit task" : "Create task"}</h2>
    <label>Task title<input name="title" value={form.data.title} onChange={event => form.setData("title", event.target.value)} /></label>
    <label>Description<textarea name="description" value={form.data.description} onChange={event => form.setData("description", event.target.value)} /></label>
    <label>Priority<select name="priority" value={form.data.priority} onChange={event => form.setData("priority", event.target.value as TaskInput["priority"])}>
      <option value="low">Low</option><option value="normal">Normal</option><option value="urgent">Urgent</option>
    </select></label>
    <label>Assignee<select name="owner" value={form.data.assignment.owner_id} onChange={event => form.setData({
      assignment: { ...form.data.assignment, owner_id: event.target.value },
    })}>
      {members.filter(member => viewer.role === "admin" || member.user_id === viewer.user_id)
        .map(member => <option key={member.user_id} value={member.user_id}>{member.name}</option>)}
    </select></label>
    <label>Assignment note<input name="note" value={form.data.assignment.note} onChange={event => form.setData({
      assignment: { ...form.data.assignment, note: event.target.value },
    })} /></label>
    {Object.entries(form.errorMap).map(([path, message]) => <p role="alert" data-error-path={path} key={path}>{message}</p>)}
    <button type="submit" disabled={form.processing}>{task ? "Save task" : "Create task"}</button>
    {form.wasSuccessful && <p role="status">{task ? "Task saved" : "Task created"}</p>}
  </form>;
}

function TaskDetails({ viewer }: { viewer: Viewer }) {
  const detail = useResource(resourceKeys.taskDetail);
  const router = useRouter();
  const [failure, setFailure] = useState("");
  const comment = useForm<CommentInput>({ text: "" }, { validator: CommentInputValidator });
  const task = detail.task;
  const canEdit = viewer.role === "admin" || task.owner_id === viewer.user_id;
  const operation = (promise: Promise<unknown>) => void promise.catch(error => setFailure(String(error)));
  return <>
    <article data-testid="task-detail" data-task-id={task.id}>
      <h2 data-testid="task-title">{task.title}</h2>
      <p data-testid="task-description">{task.description}</p>
      <p>Status: <span data-testid="task-status">{task.status}</span>; revision: <span data-testid="task-revision">{task.revision}</span></p>
      <p>Owner: {task.owner_id}; priority: {task.priority}</p>
      {canEdit && <>
        <button onClick={() => operation(mutations.setTaskStatus(router, { params: { task_id: task.id }, body: { status: "in-progress" } }))}>Start task</button>
        <button onClick={() => operation(mutations.setTaskStatus(router, { params: { task_id: task.id }, body: { status: "done" } }))}>Complete task</button>
        <button onClick={() => operation(router.mutate(`/tasks/${task.id}/delete`, undefined))}>Delete task</button>
      </>}
      {failure && <p role="alert">{failure}</p>}
    </article>
    {canEdit && <TaskEditor viewer={viewer} task={task} key={task.id} />}
    <section aria-label="Task discussion">
      <h2>Discussion</h2>
      {detail.comments.map(item => <p data-testid="task-comment" key={item.id}>{item.author_id}: {item.text}</p>)}
      <form aria-label="Comment" onSubmit={comment.submit(`/tasks/${task.id}/comments`, { onSuccess: () => comment.reset() })}>
        <label>Comment<input name="comment" value={comment.data.text} onChange={event => comment.setData("text", event.target.value)} /></label>
        {comment.errors.text && <p role="alert">{comment.errors.text}</p>}
        <button type="submit" disabled={comment.processing}>Add comment</button>
      </form>
    </section>
  </>;
}

function ProfileEditor({ viewer }: { viewer: Viewer }) {
  const form = useForm<ProfileInput>({ name: viewer.name }, { validator: ProfileInputValidator });
  return <form aria-label="Update profile" onSubmit={form.submit("/profile")}>
    <h2>Your profile</h2>
    <label>Display name<input name="display-name" value={form.data.name} onChange={event => form.setData("name", event.target.value)} /></label>
    {form.errors.name && <p role="alert">{form.errors.name}</p>}
    <button type="submit" disabled={form.processing}>Save profile</button>
    {form.wasSuccessful && <p role="status">Profile saved</p>}
  </form>;
}

export function BoardScreen({ view }: { view: View }) {
  const viewer = useResource(resourceKeys.viewer);
  const workspace = useResource(resourceKeys.workspace);
  const tasks = useResource(resourceKeys.tasks);
  const members = useResource(resourceKeys.members);
  const summary = useDeferredResource(resourceKeys.summary);
  const activity = useDeferredResource(resourceKeys.activity);
  const live = useLiveStatus();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [failure, setFailure] = useState("");
  const logout = async () => {
    try {
      const response = await fetch("/session/logout", { method: "POST", headers: { "X-FluxFast": "1" } });
      if (!response.ok) throw new Error("Logout failed");
      router.clear();
      window.location.assign("/login");
    } catch (error) { setFailure(String(error)); }
  };
  const filtered = tasks.filter(task => task.title.toLowerCase().includes(query.toLowerCase()));
  return <main>
    <header>
      <h1>{titles[view]}</h1>
      <p data-testid="workspace">{workspace.name}</p>
      <p><span data-testid="viewer">{viewer.name}</span> — {viewer.role}; <span data-testid="tenant">{viewer.tenant_id}</span></p>
      <p className="muted">{workspace.release}; live: <span data-testid="live-status">{live.status}</span></p>
      <nav aria-label="Main navigation">
        <Link href={routes.dashboard()}>Dashboard</Link><Link href={routes.taskBoard()}>Tasks</Link>
        <Link href={routes.team()}>Team</Link><Link href={routes.reports()}>Reports</Link>
        <Link href={routes.search()}>Search</Link><Link href={routes.settings()}>Settings</Link>
      </nav>
      <button onClick={() => void logout()}>Sign out</button>
      {failure && <p role="alert">{failure}</p>}
    </header>
    <section aria-label="Release summary">
      {summary.data ? <div className="metrics" data-testid="summary">
        <span>Total <strong data-testid="task-total">{summary.data.total}</strong></span>
        <span>Todo {summary.data.todo}</span><span>In progress {summary.data.in_progress}</span>
        <span>Done <strong data-testid="task-done">{summary.data.done}</strong></span><span>Urgent {summary.data.urgent}</span>
      </div> : <p data-testid="summary-loading">Preparing release report…</p>}
      {summary.stale && <span data-testid="summary-stale">Refreshing release report…</span>}
    </section>
    {view === "task" && <TaskDetails viewer={viewer} />}
    {(view === "tasks" || view === "dashboard" || view === "search") && <section>
      <h2>Workspace tasks</h2>
      <label>Search<input name="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <table aria-label="Workspace tasks"><thead><tr><th>Task</th><th>Owner</th><th>Status</th><th>Priority</th></tr></thead><tbody>
        {filtered.map(task => <tr data-task-id={task.id} data-tenant={task.tenant_id} key={task.id}>
          <td><Link href={routes.taskDetail({ task_id: task.id })}>{task.title}</Link></td>
          <td>{task.owner_id}</td><td data-task-status>{task.status}</td><td>{task.priority}</td>
        </tr>)}
      </tbody></table>
    </section>}
    {view === "tasks" && <TaskEditor viewer={viewer} />}
    {view === "team" && <section aria-label="Members"><h2>Workspace members</h2>
      {members.map(member => <article data-testid="member" key={member.user_id}>{member.name} — {member.email} — {member.role}</article>)}
    </section>}
    {view === "settings" && <ProfileEditor viewer={viewer} />}
    <section aria-label="Workspace activity"><h2>Recent activity</h2>
      {activity.data ? activity.data.map(item => <p data-testid="activity" key={item.id}>{item.actor_id}: {item.message}</p>)
        : <p data-testid="activity-loading">Preparing activity…</p>}
      {activity.stale && <span data-testid="activity-stale">Refreshing activity…</span>}
    </section>
  </main>;
}
