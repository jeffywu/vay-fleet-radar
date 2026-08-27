# Future Work and Scaling Plan

This document contains capabilities deliberately excluded from the Fleet Radar MVP and the operational and technical changes required to grow from approximately 100 to 1,000 vehicles. The implemented system is defined only in `plans/ARCHITECTURE.md`.

## Deferred capabilities

- Real Kafka ingestion, schema registry, consumer lag monitoring, dead-letter handling, and replay tooling.
- Multidimensional vehicle state covering occupancy, control mode, service availability, energy, connectivity, and incidents. This avoids forcing customer support, connectivity, or low battery into a single display-status state machine.
- Charging stations, charge queues, range-aware dispatch, and energy-cost optimization.
- Traffic-aware routing, mid-route rerouting, alternative routes, and provider failover beyond the MVP's initial ephemeral route request.
- Teledriver scheduling, advanced command retries and cancellation, strategy experimentation, and operator audit workflows.
- Customer-support and field-agent incident workflows, including operator controls to create, remove, or reroute dispatch jobs and place a vehicle out of service.
- Demand forecasting and demand-weighted coverage using H3 or another spatial index.
- Trip and revenue events, historical aggregates, business dashboards, and explicit metric definitions.
- Authentication, role-based authorization, command approval, and immutable operator audit logs.
- Data retention, privacy controls, observability, alerting, and disaster recovery.
- Railway or another production deployment topology with managed Postgres and independently scalable services.

A process-isolated simulator could publish through an internal HTTP ingestion adapter. That adapter would validate the same event envelope, enforce request-size limits, and remain an event transport rather than a source of truth.

Railway does not execute a Compose application as one production unit. A Railway deployment would map each Compose service to a Railway service and use Railway's managed Postgres offering.

## Event transport evolution

The transport-independent `EventSource` and `EventPublisher` ports allow the in-memory adapter to be replaced by Kafka without coupling the consumer, simulator, or dispatch engine to transport metadata. Vehicle ID should be the Kafka partition key so per-vehicle ordering is preserved.

Consumer-group rebalancing, broker acknowledgements, offset commits, retention, and dead-letter topics must be exercised against a real Kafka-compatible broker. A Kafka adapter should have at least one integration test against a disposable broker using Testcontainers. KafkaJS and `@confluentinc/kafka-javascript` require a broker; `@testcontainers/kafka` starts a real Kafka container. Protocol compatibility should be tested with Testcontainers or `kcat -M`, not by expanding the MVP's in-memory adapter into a home-grown broker.

The in-process dispatch package can be moved behind Kafka and command-service adapters if independent deployment becomes operationally useful. This changes adapters and deployment topology, not dispatch decision logic or vehicle command semantics.

## Dispatch strategy evolution

Additional strategies can use nearest-vehicle distance, battery, zone coverage deficit, predicted demand, charging needs, teledriver capacity, service-level objectives, or an optimizer. They replace only `DispatchStrategy`; job handling and vehicle command semantics remain stable.

Revenue maximization requires defined demand, costs, operational capacity, service-level objectives, and an optimization horizon. Those inputs and metrics must be established before an optimization strategy can be evaluated meaningfully.

## Scale to 1,000 Vehicles

Scaling from 100 to 1,000 vehicles is first an operating-model change. A person may be able to scan 100 map markers and notice anomalies; no operator can continuously understand 1,000 moving vehicles from a map. The product must evolve from fleet surveillance to exception management, explicit work ownership, and supervised automation.

### Operating model

- Partition the service area into operational zones with named owners, local targets, and escalation paths. Zones should be reassignable during demand spikes or staffing changes.
- Separate roles where necessary: fleet monitoring, dispatch supervision, customer incidents, charging and field operations, and shift supervision. Role-specific views should share the same underlying state.
- Represent operational work as owned queue items with priority, state, assignee, age, and service-level target. A colored vehicle marker is not a workflow.
- Support shift handoff with unresolved-work summaries, recent decisions, vehicle notes, and acknowledgement by the incoming operator.
- Model human and physical capacity explicitly: available teledrivers, operator queue load, charging bays, field agents, and expected response times. A dispatch strategy that ignores constrained resources will create unsafe or impossible plans.
- Define degraded modes and runbooks for telemetry loss, command failure, route-service outage, demand surges, and dispatch-service unavailability.

### Exception-oriented dashboard

- Default to zone health, coverage deficit, queue age, capacity, incidents, and SLA risk rather than displaying 1,000 equally prominent vehicles.
- Cluster and aggregate healthy vehicles, with progressive drill-down from fleet to zone to queue to vehicle.
- Turn anomalies into a lifecycle: severity, deduplication, suppression, acknowledgement, ownership, notes, resolution, and escalation. Repeated telemetry samples must not create repeated human alerts.
- Preserve a global map for situational context, but make prioritized queues the primary way operators discover and complete work.
- Measure operator outcomes such as time to acknowledge, time to resolve, queue age, SLA breaches, workload per operator, handoff quality, automation overrides, and false-positive alert rate.

### Dispatch automation and control

At 1,000 vehicles, random assignment should be replaced by policy-driven automation behind the same `DispatchStrategy` contract. Strategies must account for zone coverage, demand, range, charging, teledriver and operator capacity, service objectives, and the cost of moving a vehicle away from its current zone.

Automated decisions should expose their reason and relevant constraints so an operator can understand and override them. Overrides, strategy versions, inputs, and outcomes need an audit trail so the business can compare strategies safely. Risky commands require idempotency, clear acknowledgement, permissions, and confirmation; bulk actions need tighter safeguards than single-vehicle actions.

Automation should progress through recommendation only, operator approval, bounded autonomous dispatch, and broader automation after measured performance. Strategy rollout should use simulation or replay, shadow decisions, zone-level canaries, and explicit rollback criteria.

### Technical enablers

At one telemetry update per second, 1,000 vehicles produce approximately 1,000 events per second. The technical path is straightforward relative to the operational changes:

- Partition telemetry by vehicle ID and run stateless consumers in a consumer group.
- Batch event inserts and projection updates while preserving ordering and idempotency.
- Keep reads on compact, role-oriented projections rather than scanning history.
- Coalesce SSE and browser updates to a useful visual cadence and use Mapbox layers rather than DOM markers.
- Build zone, alert, workload, and dispatch-queue projections that match operator workflows.
- Treat routing as a capacity and cost dependency: enforce request budgets, measure route-start rate, and plan a commercial allowance or provider strategy when free-tier limits no longer match fleet turnover.
- Apply retention or archival policies to the event log independently of current projections.
- Measure consumer lag, projection age, invalid events, command acknowledgement, dispatch decision latency, database latency, and connected clients.

Technical capacity is necessary, but safe operational leverage is the real scaling objective: the number of vehicles requiring attention per operator must remain bounded as the fleet grows.
