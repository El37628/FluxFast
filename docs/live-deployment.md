# Deploying Live Resources

Live Resources use long-lived Server-Sent Event responses over ordinary HTTP.
The browser should still see one frontend origin:

```text
browser
  ↓ HTTPS
reverse proxy / load balancer
  ↓
Next.js server (public application origin)
  ↓ header-gated FluxFast rewrite
FastAPI workers
  ↕
Redis Pub/Sub when worker count > 1
```

Initial documents, live streams, resource-only requests, and mutations all use
the same browser origin. `FLUXFAST_BACKEND_URL` is a server-only address used by
Next.js and the generated rewrite; it is not a browser environment variable and
does not require CORS.

## Proxy requirements

Every proxy between the browser and FastAPI must:

- stream response bytes instead of buffering the SSE response;
- avoid caching or transforming `text/event-stream` responses;
- preserve `X-FluxFast-*`, cookies, and authorization headers;
- use HTTP/1.1 or HTTP/2 without requiring a WebSocket upgrade;
- keep the connection open longer than the configured heartbeat interval; and
- propagate disconnects so cancelled streams release broker subscriptions.

FluxFast returns `Cache-Control: no-cache, no-transform` and
`X-Accel-Buffering: no`. Do not configure an upstream proxy or CDN to override
those headers. Compression middleware can buffer small chunks; exclude
`text/event-stream` when it does.

## Nginx

The simplest safe configuration disables proxy buffering for the public Next.js
application location. This trades some buffering efficiency for correct stream
delivery on routes that share URLs with normal documents:

```nginx
upstream fluxfast_next {
    server 127.0.0.1:3000;
    keepalive 64;
}

server {
    listen 443 ssl http2;
    server_name app.example.com;

    location / {
        proxy_pass http://fluxfast_next;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        proxy_buffering off;
        proxy_cache off;
        gzip off;

        proxy_read_timeout 1200s;
        proxy_send_timeout 1200s;
        send_timeout 1200s;
    }
}
```

The default FluxFast heartbeat is 15 seconds and the default maximum stream age
is 900 seconds. A 1,200-second proxy timeout leaves room for normal rotation;
the heartbeat continually resets an inactivity-based read timeout. If you
change `live_heartbeat_interval`, keep every intermediary's idle timeout safely
above it.

Do not enable the Nginx WebSocket settings just for FluxFast. SSE is a normal
streaming GET and needs no `Upgrade` or `Connection: upgrade` headers.

## Nginx Proxy Manager

Create a Proxy Host that targets the Next.js server, enable TLS as usual, and
place the streaming directives in the host's **Advanced** configuration:

```nginx
proxy_buffering off;
proxy_cache off;
gzip off;
proxy_read_timeout 1200s;
proxy_send_timeout 1200s;
send_timeout 1200s;
```

The Websockets Support toggle is not required. If another template or CDN sits
in front of Nginx Proxy Manager, configure its response buffering, cache, and
idle timeout too. Verify in browser developer tools that the live request stays
pending and receives `Content-Type: text/event-stream`; a request that completes
immediately or delivers events only in large bursts is usually buffered.

## Multiple FastAPI workers

The default `MemoryLiveBroker` exists only inside one Python process. With two
workers, a mutation handled by worker A cannot notify a stream attached to
worker B. Use Redis even when all workers run on one machine:

```bash
pip install "fluxfast[redis]"
```

```python
import os

from fastapi import FastAPI
from fluxfast import FluxFast, RedisLiveBroker

app = FastAPI()
flux = FluxFast(
    app,
    broker=RedisLiveBroker.from_url(
        os.environ["REDIS_URL"],
        channel_prefix="myapp:fluxfast:v1:",
    ),
)
```

Every worker must use the same Redis URL and `channel_prefix`. The prefix is an
operational namespace, not an authorization boundary; use separate credentials
and network isolation for Redis. FluxFast broker topics are opaque hashes, but
Redis access should still be restricted to the application.

Redis carries ephemeral signals only. It does not replace the resource cache or
database. On connection loss, the server ends the affected subscription and the
browser reconnects and reloads canonical live resources. Monitor Redis
availability, reconnects, and publish errors, but do not make a successful
database transaction depend on Pub/Sub delivery.

The default `MemoryResourceCache` is also per process. `RedisLiveBroker` does
not invalidate a positive-TTL entry held by every other worker. For guaranteed
canonical convergence across workers, either set `ttl=0` on live resources or
provide a `ResourceCacheBackend` whose values or invalidations are shared by all
workers. Do not combine positive-TTL live entries, process-local resource
caches, and non-sticky load balancing while expecting immediate convergence.

## Server and load-balancer sizing

Plan for one open HTTP stream per browser tab whose active page declares at
least one live resource. A page with ten live keys still uses one stream. Size:

- proxy and worker file-descriptor limits;
- load-balancer concurrent-connection limits;
- FastAPI worker concurrency;
- one Redis Pub/Sub subscription object per live stream in each worker; and
- network traffic from heartbeats and resource-only convergence requests.

The in-memory broker queue defaults to 64 events per subscriber and coalesces
overflow into resynchronization. Do not increase this merely to hide a slow
client; canonical refresh is the intended recovery path. Run `pnpm benchmark`
on representative hardware for connection, queue, and cleanup diagnostics.

Sticky sessions do not make `MemoryLiveBroker` safe for multi-worker
production. Mutations and reconnects can still land on a different worker, and
worker replacement loses all process-local subscriptions. Redis is the correct
coordination mechanism.

## Heartbeats, rotation, and authorization

Configure stream timing on the backend:

```python
flux = FluxFast(
    app,
    live_heartbeat_interval=15,
    live_max_connection_age=15 * 60,
)
```

Heartbeats are SSE comments and do not trigger resource refresh. Maximum age is
finite so the browser periodically reconnects and FastAPI reruns the page's
authentication and authorization dependencies. Choose a shorter maximum age
when permission revocation must be observed sooner, or actively terminate the
session and clear the client router during logout.

## Production verification

Before rollout, verify all of the following through the real proxy chain:

1. Two authenticated browser contexts open the same scoped live page.
2. One context performs a normal mutation with a scoped invalidation.
3. The other context updates without document navigation or polling.
4. Tenant/user-isolated contexts do not receive or request the resource.
5. Taking Redis offline ends streams; restoring it lets reconnect converge.
6. Navigating away and logging out reduce active subscriptions to baseline.
7. A production Next.js build and `next start` work through the single public
   origin.
8. Positive-TTL live resources use a shared/invalidation-aware cache, or the
   multi-worker configuration uses `ttl=0`.

FluxFast's Playwright, Redis integration, and controlled benchmark suites cover
these behaviors in the repository, but the final proxy and infrastructure
configuration remains deployment-specific.
