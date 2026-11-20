# iOS push router for a signed fork

This service sends Live Activities and notifications with the Apple key for your fork's bundle ID.
T3 Connect handles sign-in, pairing and widget snapshots. Set `T3CODE_IOS_PUSH_ROUTER_URL` to
the router's HTTPS origin in both the iOS and environment builds. Set
`T3CODE_IOS_PUSH_ROUTER_ACCOUNT_ID` on the environment to the linked T3 Connect account ID.
These settings can also be supplied to the environment at runtime.

Build the Node 24 ESM bundle from the repository root after `vp i`.

```sh
scripts/node_modules/.bin/esbuild infra/relay/src/pushRouter/main.ts \
  --bundle --platform=node --format=esm --target=node24 --external:pg-native \
  '--banner:js=import { createRequire as routerRequire } from "node:module"; const require = routerRequire(import.meta.url);' \
  --outfile=/tmp/router.mjs
```

Install the bundle at `/opt/t3-push-router/router.mjs` and the [systemd unit](t3-push-router.service)
on the push host. The unit runs as `t3_push_router` and reads the Apple signing key from
`/etc/t3-push-router/apns.p8` through systemd credentials. Supply these settings in
`/etc/t3-push-router/router.env` with mode 0600.

| Setting                                         | Value                                                                                         |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `PUSH_ROUTER_ORIGIN`, `PUSH_ROUTER_ACCOUNT_ID`  | HTTPS origin and linked account configured on the environment                                 |
| `CONNECT_ORIGIN`, `CONNECT_PUBLIC_KEY_PATH`     | T3 Connect's token issuer and its Ed25519 public mint key in PEM format                       |
| `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_BUNDLE_ID` | Apple team, APNs key ID and the containing app's bundle ID                                    |
| `PUSH_JOB_SECRET`                               | Persistent random secret for signing queued deliveries, generated with `openssl rand -hex 32` |
| `PGUSER`, `PGDATABASE`                          | Role and dedicated database owned by the router                                               |
| `PGHOST`, `PORT`                                | Default to the local PostgreSQL socket and HTTP port 8794                                     |

Apply each [PostgreSQL migration](../migrations/postgres) to the dedicated database once, in
directory order. Add a `relay_environment_links` row for each publishing environment using its
linked account ID, environment ID, Ed25519 **public** key and endpoint. The linked environment
keeps the private signing key. Remove the row to revoke its access. Updating an environment's
signing key requires updating the row.

Proxy HTTPS to the loopback listener and enable the unit. Open the installed iOS build and
turn on **Settings → Notifications → Device Notifications**. The health endpoint is
`GET /v1/mobile/push-health`. Check the device without exposing its tokens with the queries below.

```sql
SELECT bundle_id, aps_environment, push_token IS NOT NULL AS has_alert_token
FROM relay_mobile_devices;
SELECT kind, apns_status, apns_reason FROM relay_delivery_attempts ORDER BY created_at DESC LIMIT 10;
```
