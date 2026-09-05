# Pong — two players, many spectators

Server-authoritative Pong over WebSockets. The server owns the ball, the paddles
and the score, simulates at a fixed 60 Hz in an 800×450 virtual space, and
broadcasts snapshots at 25 Hz. Clients send a target paddle y and render an
interpolated view of what they receive.

## Run it

```
npm install          # one dependency: ws
npm start            # http://localhost:8080   (PORT=... to change)
npm test             # physics self-check: tunneling, angle reflection, walls, scoring
npm run smoke        # end-to-end against a running server (pass a base URL to target another host)
```

`PONG_RESERVE_MS` shortens the 30 s disconnect reservation; set it on both the
server and the smoke run (CI uses `1000`) so the claim-after-lapse path can be
tested without waiting half a minute. The smoke test skips that one assertion
when the window is longer than 3 s.

Open <http://localhost:8080>, click **Create room**, and share the `/r/<id>` URL.
Everyone uses the same link: the first two openers can choose **Play**, everyone
after that watches (up to 20) and can take over a paddle that goes empty.

Controls (players only): mouse, touch, arrow keys, or W/S.

## Rules and lifecycle

- First to 11. Either player can hit **Rematch**; the score resets and spectators stay.
- Serve is 1.5 s after each point, aimed away from whoever conceded.
- Paddle bounce is offset-based: where you hit the paddle sets the exit angle
  (up to 60°) and the ball speeds up 5% per hit, capped.
- A player disconnecting pauses the game and reserves their slot for 30 s. They
  can reconnect with the token in `sessionStorage`. After 30 s the slot opens and
  any spectator can claim it — first claim wins, play resumes.
- Rooms are in-memory, swept every 5 s: dropped when empty, or after 10 minutes
  with no player in either slot.

## HTTP

| Method | Path | Response |
| --- | --- | --- |
| `POST` | `/room` | `{"id":"<8 url-safe chars>"}`, room created |
| `GET` | `/health` | `{ok, version, rooms, uptime}` — `version` is `RENDER_GIT_COMMIT` or `dev`. CI polls it to confirm the new process is serving traffic before smoke-testing it |
| `GET` | `/` | landing page (create / join by id) |
| `GET` | `/r/:id` | the same `client.html` |
| `GET` | `/ws?room=<id>&role=play\|watch&token=<t>` | WebSocket upgrade; `token` is optional and only used to reclaim a reserved slot |

## Message protocol

All frames are JSON with a `type` field.

### Client → server

| type | payload | who may send | server behaviour |
| --- | --- | --- | --- |
| `input` | `{y: number}` — target paddle y in virtual units | player A or B only | clamped to `[40, 410]`; **ignored** unless the room's own record says this socket holds that slot. A claimed role in a message is never trusted. Send at ≤ 60/s. |
| `claim` | `{}` | any socket without a slot | seats it in a free, unreserved slot and replies with `role`; ignored if no slot is claimable |
| `rematch` | `{}` | player A or B only | only while `status === "over"`: resets the score, keeps the room and its spectators |

Malformed JSON, unknown types, and non-finite `y` are dropped silently.

### Server → client

| type | payload | sent to |
| --- | --- | --- |
| `welcome` | `{room, role: "a"\|"b"\|null, token: string\|null, dims:{W,H,R,PW,PH,AX,BX,SPEED,WIN}}` | once on connect. `role: null` means spectator; `token` reclaims the slot within the 30 s reservation |
| `state` | `{ball:{x,y,vx,vy}, paddles:{a,b}, score:{a,b}, spectators:int, open:bool, status, cd, winner, t}` | everyone in the room, 25 Hz, serialized once per room per tick |
| `role` | `{role:"a"\|"b", token}` | the socket whose `claim` succeeded; it switches to player mode |

`status` is one of `wait` (no second player yet), `count` (serving, `cd` seconds
left), `play`, `paused` (a player dropped), `over` (`winner` is `"a"`/`"b"`).
`open` is true when a paddle is free *and* out of its reservation window — the
client uses it for both the Play/Watch choice and the "take the empty paddle"
button. `t` is the server's send time.

### Close codes

| code | reason |
| --- | --- |
| `4001` | `both paddles are taken` — the client reconnects as a spectator |
| `4002` | `spectator limit reached` (cap 20) |
| `4003` | `room closed` (TTL sweep) |
| `4004` | `server restarting` (SIGTERM) — the client says so instead of showing a generic disconnect |

## Client rendering

Snapshots go into a 12-deep buffer and are rendered 100 ms in the past,
interpolated between the two bracketing snapshots — raw snapshot positions are
never drawn. A player predicts its own paddle locally from its own input and
eases toward the authoritative y in each snapshot (snapping if the error exceeds
40 units); the opponent's paddle and the ball are interpolation only. Spectators
predict nothing. The 800×450 space is letterboxed onto the canvas at draw time.

## Deployment

Host is Render's free tier, described by [render.yaml](render.yaml) and driven by
[.github/workflows/deploy.yml](.github/workflows/deploy.yml).

### One-time Render setup

1. Push this repo to GitHub.
2. In the Render dashboard: **New → Blueprint**, pick the repo, and apply. Render
   reads `render.yaml` and creates a single free-tier web service named `pong`
   in the Singapore region, building with `npm ci` and starting `node server.js`.
3. Leave auto-deploy off. `render.yaml` sets `autoDeploy: false` because a
   rollback through Render's API does *not* disable autodeploys — with it on, an
   autodeploy could restore the exact change CI just rolled back.

The service is deliberately pinned to one instance. Rooms live in an in-memory
`Map`, so a second instance would hold a different room registry with no way to
route a joiner to the right one. Never add autoscaling or raise `numInstances`.

### GitHub secrets

| Secret | Where to find it |
| --- | --- |
| `RENDER_API_KEY` | Render dashboard → your account menu → **Account Settings → API Keys → Create API Key**. Copy it once; it is not shown again. |
| `RENDER_SERVICE_ID` | The `srv-…` id in the service's dashboard URL (`dashboard.render.com/web/srv-…`), also shown under the service's **Settings**. |
| `APP_URL` | The service's public URL, e.g. `https://pong-xxxx.onrender.com`. **No trailing slash** — the workflow appends `/health`. |

### What the pipeline does

`test` runs on every push to `main` and every pull request: `npm ci`,
`node --check server.js`, `npm test`, then it starts the server on 8080, waits
for `/health`, and runs `scripts/smoke.mjs` against it with a 1 s reservation
window so every assertion runs.

`deploy` runs only on a push to `main` that passed `test`:

1. Record the currently live deploy id — the rollback target. An empty result
   just means this is the first deploy.
2. Trigger a deploy of **this exact commit SHA**, not "latest on branch", so a
   push landing mid-run cannot ship untested code.
3. Poll the deploy until it reports `live`, failing fast on `build_failed`,
   `update_failed`, `pre_deploy_failed` or `canceled` (10 minute cap).
4. Poll `{APP_URL}/health` until `version` equals the pushed SHA. This is what
   proves the *new* process is serving traffic; without it the next step would
   smoke-test the old process and pass while proving nothing.
5. Run `scripts/smoke.mjs` against `APP_URL`.
6. If any of the above fails, roll back to the recorded deploy id. Rollback
   reuses the old build artifact rather than rebuilding, so recovery does not
   reintroduce build-time risk mid-incident. With no recorded id, the job says
   the broken version is live and exits 1.

The deploy job holds a `deploy-main` concurrency group with
`cancel-in-progress: false`: cancelling mid-rollout would leave the service in a
state the workflow cannot reason about.

### Two operational facts

- **Every deploy drops every game in progress.** The room registry is in memory
  and starts empty in the new process, so the 30 s reconnect reservation cannot
  help. On `SIGTERM` the server stops the simulation and closes every socket with
  code `4004`, so players see "server restarting — reconnect in a moment" rather
  than a generic disconnect.
- **A cold instance takes ~60 s to wake.** The free tier spins down after 15
  minutes with no inbound traffic. WebSocket messages from existing connections
  count as traffic, so an active game keeps the instance awake; only an idle
  server sleeps. The first request after that — including CI's health poll, which
  allows 90 s — pays the wake-up.
