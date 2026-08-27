# Fleet Radar Architecture

This is a take home task for a technical interview with Vay. Vay is a remote teledriving startup focused on a consumer market. This exercise is aimed at understanding how an engineer would approach their complex operational system. See plans/ASSIGNMENT.md to understand the user stories and requirements for the task.

My initial thought for the approach and architecture looks like this:

- Map Area and Destination List: this will define the valid operating area of the map and a list of valid destinations. This will be a static asset pre-generated during development. The simulation engine and the dispatch engine will select destinations from this list.

- Simulation Engine: a parameterized state model. On every "tick" it will loop over every vehicle, update its internal state, and then emit an event for each car. It accepts requests from the Dispatch Engine to move a car into the EN_ROUTE state with a given destination. Other than the events it emits its internal state should be treated as a black box to the rest of the system.

The two components above comprise of the "external" environment and should not be considered part of the Vay operational system. The components below correspond to the Vay operational system.

- Data Backend: use Postgres with PostGIS, receive events from the Simulation Engine over a REST API endpoint and insert them into a single append only table. For each data element we want to display on the UI, create corresponding views which encapsulates the relevant calculation.

- Dispatch Engine: Vay provides a remote teledriving service. The dispatch engine will match teledrivers to a queue of cars. The dispatch engine core should simple, but provide hooks for optional extension of the rules so that it may be configured to optimized for more complex, data driven rules or optimization.

- Web Dashboard: the web dashboard should provide a MapBox view for a hypothetical fleet operator to understand the state of the fleet, the dispatch queue, and other important fleet information. The map component of the dashboard is important, but it should also provide sortable, filterable tables, and other data visualizations that aid the understanding of various fleet metrics. Each area of the web dashboard should be centered around a fleet operator user story for what they are trying to understand or accomplish in that view.

## Simulation Engine

This is a parameterized state model. On every “tick” it will loop over every vehicle and update its state and then emit an event. The emitted event may have a schema like:

`{ latLong, direction, batteryPercentage, status: ["FREE", "WITH_CUSTOMER", "EN_ROUTE", "IN_SERVICE"], timestamp, carId, revenueGenerated }`

This event will be fired to the Data Backend.

The valid state transitions are:

FREE => WITH_CUSTOMER: in this transition there will be some "hidden" route that the car follows and the car will generate revenue
FREE => EN_ROUTE: in this transition the car will be moving but the route will be known and set via the dispatch, the car does not generate revenue. A car cannot go into EN_ROUTE without a message from dispatch.
[Future Work] FREE <=> IN_SERVICE: this can be done via the dispatch queue by the fleet operator. this car will not move and will not be available for customers. it does not generate revenue while in service.
WITH_CUSTOMER => FREE: the car will stop moving and stop generating revenue, it will be available for a new transition
EN_ROUTE => FREE: the car will stop moving and become available for a new transition
WITH_CUSTOMER <=> EN_ROUTE: this is an invalid transition, the car should always go into a "FREE" state if only briefly

Configurable parameters are as follows. These should be configurable in a user friendly TOML or YAML file and read on initialization.

1. Number of Cars
2. Revenue generated per tick
3. "Free" time range (we will randomly select some time that the car will wait in a "free" state before the next state transition)
4. WITH_CUSTOMER probability, which is the % chance that a car will go from FREE => WITH_CUSTOMER, otherwise it goes to EN_ROUTE.
6. EV miles per kwh along with total kwh in the car. This needs to be decremented as the car travels. If this is below some threshold the car must remain in the FREE state. Before a route is assigned the simulation will check if there is sufficient range to go there, if not it will loop through routes until it finds one. It will reject a dispatch request if there is insufficient range.
7. Time scale per tick, so that we can speed up or slow down the simulation
8. Randomize data loss due to latency or signal loss, do this as a percent of events
9. [OPTIONAL] add a charging model to the simulation engine, this should not be considered MVP

## Data Backend

Use Postgres with PostGIS for the backend. There should be a simple API for data ingestion and expose REST APIs for view data.  Maintain a data dictionary and a clear documentation of what each view does, how its calculated and what it informs on the UI or the dispatch queue as the views will be the primary "API". Do not worry about materializing or any performance optimizations beyond effective indexing.

## Dispatch Queue

For the first version of this demo the dispatch queue should simply communicate with the Simulation Engine and put cars in the FREE => EN_ROUTE state change. It should maintain a mapping of which teledriver is assigned to which car. A single teledriver can only drive one car at a time. The queue may enqueue future transitions as teledrivers become available. 

The goal of the dispatch queue is to maximize the total revenue of the system. Because of that, make sure that the rule engine is modular and can be easily extended for different potential rule engines.

The number of teledrivers should be configurable via the main configuration file described in simulation engine.

## Web Dashboard

The front end will be a dashboard that allows operations to see everything that is going on. In your execution plan, define relevant metrics and display widgets to ensure that the user stories for the two personas can be met.

As a fleet operator, my goal is to maximize the utilization of the current fleet.

As a fleet operator, I need to know:
- where all the cars are at all times.
- the current state of each car
- where EN_ROUTE cars are going
- which cars need to be charged and where they are.
- the state of the dispatch queue.
- what each teledriver is doing
- identify areas of the map that have low FREE car density

As a fleet operator, I need to be able to:
- call a car to support the customer (just stub this action out)
- remove items from the dispatch queue
- re-route cars that are EN_QUEUE
- manually add entries to the dispatch queue
- put a car into IN_SERVICE where it cannot be transition into WITH_CUSTOMER

As a business owner, my goal is to maximize the long term revenue of the fleet through strategic growth planning.

As the business owner, I need to know:
- the total fleet revenue
- the total trips
- the average revenue per car
- the average time per customer trip, per teledriver route
- the current fleet utilization by customers, service, and teledrivers
- the average fleet utilization by customers, service, and teledrivers over the last hour
- areas of the map which generate revenue
- areas of the map where trips tend to start and end


## Infrastructure

- Use typescript as the coding language
- Use postgres as the backend
- Use MapBox for the mapping engine and routing generation
- Dockerize the system so that it can be run end to end locally
- Add the ability to deploy to Railway using a docker compose file