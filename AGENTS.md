# AGENTS.md

## Code Organization

- Keep each file focused on one area of concern.
- Inline interfaces and types when they are not reused outside the local scope.
- Prefer terse code over additional levels of indirection.
- Do not over engineer for performance.
- Prefer simple and readable code over highly optimized code for high throughput applications.

## Project Scope

- Make sure that the project satisfies the requirements outlined in `plans/ASSIGNMENT.md`
- `plans/ARCHITECTURE.md`: serves as a living document for the project scope, dependencies and package responsibilities.
- Do ensure that the project does not stray away from a minimum viable project.
- Ensure that proper security procedures are followed, API keys and secrets should not be exposed at any point.
- Make sure that the project can run within locally within the Docker compose environment.
- Do define and maintain the semantic meaning of data objects in architecture documents and execution plans.

## Before Finishing

- Review the relevant execution plan to ensure that all requirements are met.
- Ensure that test cases exist, are passing, and cover both happy path and edge conditions.
- Review plans/ARCHITECTURE.md and update it if required.