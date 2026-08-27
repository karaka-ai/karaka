# Foundation example

English | [中文](README.zh.md)

This example loads a service provider and consumer from `cordis.yml` through the real Loader and Include plugins. `provider-friendly.mjs` and `provider-brief.mjs` implement the same `greeter` service; configuration enables one provider without changing `consumer.mjs`.

Build the foundation before running the example:

```sh
pnpm run build
pnpm run example
```

The command prints `Hello, Karaka!` and disposes the complete plugin tree. To select the other implementation, switch the two providers' `disabled` values in `cordis.yml`.
