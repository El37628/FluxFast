# @fluxfast/devtools

Optional, development-only runtime diagnostics for FluxFast applications.
The bottom Debugbar and expanded inspector explain resource loading, browser
and server cache behavior, deferred work, mutations, live synchronization,
protocol metadata, and correlated runtime events without exposing application
values.

```bash
npm install --save-dev @fluxfast/devtools
```

Mount it inside the FluxFast provider used by your application:

```tsx
import { FluxDevtools } from "@fluxfast/devtools";

export function DevelopmentDevtools() {
  if (process.env.NODE_ENV !== "development") return null;
  return <FluxDevtools />;
}
```

The package exposes only `FluxDevtools` and `FluxDevtoolsProps`. It obtains the
active router from `@fluxfast/next`; applications do not pass a router. The
default history is a bounded 500-event ring buffer, the default shortcut is
`Alt+Shift+D`, and the panel can dock at the bottom or right.

The production package condition resolves to an inert component. The FastAPI
backend additionally requires application debug mode and an active DevTools
request before returning a bounded `fluxfast-devtools/1` trace. Resource
values, request bodies, authorization data, cookies, scope identities, and
arbitrary exception text are never included.

See the complete [FluxFast DevTools guide](https://github.com/El37628/FluxFast/blob/main/docs/devtools.md)
for installation, panel semantics, security, performance guarantees, and
troubleshooting.

FluxFast is licensed under the [MIT License](https://github.com/El37628/FluxFast/blob/main/LICENSE).
