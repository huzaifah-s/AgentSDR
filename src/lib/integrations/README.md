# Integration structure

Each external provider (`apollo`, `cleanlist`, `companyenrich`, `snov`, `millionverifier`, `contactout`, `findymail`, `fullenrich`,
`hunter`, `leadmagic`, `lusha`, `zerobounce`, `similarweb`, `semrush`, `rocketreach`, `icypeas`) owns
a folder under this directory:

```text
apollo/
  definition.ts  # client-safe metadata, credentials, inputs and outputs
  actions.ts     # server-side API calls and response mapping
  verify.ts      # server-side credential verification
```

`catalog.ts` is the client-safe registry used by the configuration UI. Do not
export server action or verification modules from it, because the catalog is
also imported by client components.

`server/registry.ts` maps stable `handlerKey` values to provider action
functions. It fails during server startup if an action is marked implemented
without a registered handler. Persisted `integrationKey`, `actionKey`, and
`handlerKey` values are public contracts and must not be renamed.

Provider artwork belongs under `public/Integrations - Icon/`. Set its public
path on the provider definition as `iconUrl`. The UI prefers that SVG, then
falls back to a domain favicon, and finally to `iconText`.

To add a provider:

1. Create its folder and `definition.ts`, `actions.ts`, and `verify.ts` files.
2. Add the definition to `catalog.ts`.
3. Add its action map to `server/registry.ts`.
4. Add its verifier to `verification.ts`.
5. Run TypeScript, ESLint, and the production build.
