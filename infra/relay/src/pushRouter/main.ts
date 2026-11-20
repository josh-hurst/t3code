// @effect-diagnostics nodeBuiltinImport:off -- This entry point starts the Node HTTP listener and reads systemd credentials.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as PgClient from "@effect/sql-pg/PgClient";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Drizzle from "drizzle-orm/effect-postgres";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpRouter from "effect/http/HttpRouter";

import * as AgentActivityPublisher from "../agentActivity/AgentActivityPublisher.ts";
import * as AgentActivityRows from "../agentActivity/AgentActivityRows.ts";
import * as ApnsClient from "../agentActivity/ApnsClient.ts";
import * as ApnsDeliveries from "../agentActivity/ApnsDeliveries.ts";
import * as ApnsDeliveryQueue from "../agentActivity/ApnsDeliveryQueue.ts";
import * as ApnsProviderTokens from "../agentActivity/ApnsProviderTokens.ts";
import * as DeliveryAttempts from "../agentActivity/DeliveryAttempts.ts";
import * as Devices from "../agentActivity/Devices.ts";
import * as FcmDeliveries from "../agentActivity/FcmDeliveries.ts";
import * as LiveActivities from "../agentActivity/LiveActivities.ts";
import * as MobileRegistrations from "../agentActivity/MobileRegistrations.ts";
import * as CloudMintSigner from "../auth/CloudMintSigner.ts";
import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayTokens from "../auth/RelayTokens.ts";
import * as RelayConfig from "../Config.ts";
import * as RelayDb from "../db.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as EnvironmentPublishSignatures from "../environments/EnvironmentPublishSignatures.ts";
import * as Jobs from "./jobs.ts";
import { routes } from "./routes.ts";

function setting(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
function origin(name: string) {
  const url = normalizeSecureRelayUrl(setting(name));
  if (!url) throw new Error(`Invalid HTTPS origin in ${name}`);
  return url;
}
const settings = {
  origin: origin("PUSH_ROUTER_ORIGIN"),
  accountId: setting("PUSH_ROUTER_ACCOUNT_ID"),
  bundleId: setting("APNS_BUNDLE_ID"),
};
const unusedSecret = Redacted.make("");
const config = RelayConfig.RelayConfiguration.of({
  relayIssuer: settings.origin,
  apns: {
    bundleId: settings.bundleId,
    teamId: setting("APNS_TEAM_ID"),
    keyId: setting("APNS_KEY_ID"),
    privateKey: Redacted.make(NodeFS.readFileSync(setting("APNS_KEY_PATH"), "utf8")),
    environment: "production",
  },
  apnsDeliveryJobSigningSecret: Redacted.make(setting("PUSH_JOB_SECRET")),
  cloudMintPublicKey: NodeFS.readFileSync(setting("CONNECT_PUBLIC_KEY_PATH"), "utf8"),
  cloudMintPrivateKey: unusedSecret,
  clerkPublishableKey: "",
  clerkSecretKey: unusedSecret,
  clerkJwtAudience: "",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
});
const tokenVerification = RelayTokens.layer.pipe(
  Layer.provide(CloudMintSigner.layer),
  Layer.provide(RelayConfig.layer({ ...config, relayIssuer: origin("CONNECT_ORIGIN") })),
);
const sql = PgClient.layer({
  host: process.env.PGHOST ?? "/var/run/postgresql",
  database: setting("PGDATABASE"),
  username: setting("PGUSER"),
  maxConnections: 4,
});
const db = Layer.effect(RelayDb.RelayDb, Drizzle.makeWithDefaults({}));
const services = Layer.mergeAll(
  MobileRegistrations.layer,
  tokenVerification,
  EnvironmentPublishSignatures.layer,
).pipe(
  Layer.provideMerge(AgentActivityPublisher.layer),
  Layer.provideMerge(ApnsDeliveries.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      ApnsClient.layer.pipe(Layer.provide(ApnsProviderTokens.layer)),
      ApnsDeliveryQueue.layer.pipe(Layer.provide(Jobs.senderLayer)),
      Layer.succeed(FcmDeliveries.FcmDeliveries, {
        enqueue: Effect.fn("pushRouter.skipFcm")(() => Effect.succeed(null)),
        process: Effect.fn("pushRouter.skipFcmJob")(() => Effect.void),
      }),
      Devices.layer,
      LiveActivities.layer,
      AgentActivityRows.layer,
      EnvironmentLinks.layer,
      DeliveryAttempts.layer,
      DpopProofs.layer,
    ),
  ),
  Layer.provideMerge(Jobs.signalLayer),
  Layer.provideMerge(RelayDb.RelayTransactions.layer.pipe(Layer.provideMerge(db))),
  Layer.provideMerge(sql),
  Layer.provide(RelayConfig.layer(config)),
  Layer.provide(NodeHttpClient.layerUndiciOptions({ allowH2: true })),
  Layer.provide(NodeCrypto.layer),
);
const maintenance = Effect.gen(function* () {
  const publisher = yield* AgentActivityPublisher.AgentActivityPublisher;
  const proofs = yield* DpopProofs.DpopProofReplay;
  const attempts = yield* DeliveryAttempts.DeliveryAttempts;
  const rows = yield* AgentActivityRows.AgentActivityRows;
  const now = yield* DateTime.now;
  yield* publisher.endIdleLiveActivities;
  yield* proofs.pruneExpired;
  yield* attempts.pruneExpired;
  yield* rows.pruneTerminal({
    updatedBefore: DateTime.formatIso(DateTime.subtract(now, { minutes: 30 })),
  });
}).pipe(Effect.catch(() => Effect.logWarning("Push router maintenance failed")));
const background = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Jobs.worker.pipe(Effect.forkScoped);
    yield* maintenance.pipe(
      Effect.andThen(Effect.sleep("5 minutes")),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);
HttpRouter.serve(routes(settings), {
  disableLogger: true,
  routerConfig: RelayConfig.RELAY_HTTP_ROUTER_CONFIG,
}).pipe(
  Layer.merge(background),
  Layer.provide(services),
  Layer.provide(
    NodeHttpServer.layer(NodeHttp.createServer, {
      host: "127.0.0.1",
      port: Number(process.env.PORT ?? 8794),
    }),
  ),
  Layer.launch,
  NodeRuntime.runMain,
);
