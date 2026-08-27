# Architecture

English | [中文](architecture.zh.md)

Karaka is a composition foundation, not an application runtime. Its active package graph contains Cordis and the libraries and plugins required to load a configurable plugin tree.

## Layers

`@karaka/cosmokit` supplies small utilities. `@karaka/schemastery` supplies configuration schemas. `@karaka/cordis` owns contexts, services, events, fibers, effects, and dependency tracking.

The composition plugins build on that kernel: Loader imports configured plugins; Include reads YAML or JSON entry lists; Group nests entries; Timer owns disposable scheduling; HMR reloads modules and exact configuration paths; Logger Console renders Cordis logs.

## Application capabilities

Storage, identity, models, telemetry, secrets, sessions, tools, and agents are intentionally absent. Add each capability as three independently replaceable roles:

1. A service definition states the API consumers use.
2. One or more provider plugins implement that API.
3. Consumer plugins depend on the service name rather than importing a provider.

An application selects providers in configuration. Cordis dependency tracking starts consumers only when their required services exist and restarts them when a provider changes.

## Ownership

Every registration is an effect owned by the contributing plugin. Disposing a plugin must remove its services, listeners, child plugins, and other resources. The Loader and Include modifications recorded in [vendor/README.md](../vendor/README.md) preserve transactional updates so a rejected configuration does not destroy the active tree.
