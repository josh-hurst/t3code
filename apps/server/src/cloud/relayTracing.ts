import { nodeProcessRuntimeAttributes } from "@t3tools/shared/observability";
import * as RelayTracing from "@t3tools/shared/relayTracing";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

/** Relay trace export is disabled in this fork. */
export const relayLayer = (
  _resource: Omit<RelayTracing.RelayClientTracingResource, "serviceInstanceId">,
  _tracingConfig: RelayTracing.RelayClientTracingConfig | null = null,
) => Layer.succeed(RelayTracing.RelayClientTracer, Option.none());

export const layerHeadlessRelayClient = relayLayer({
  serviceName: "t3code-server",
  runtime: "node",
  attributes: nodeProcessRuntimeAttributes(),
  client: "headless-cli",
});

export const layerServerRelayBroker = relayLayer({
  serviceName: "t3code-server",
  runtime: "node",
  attributes: nodeProcessRuntimeAttributes(),
  client: "environment-server",
  component: "relay-broker",
});
