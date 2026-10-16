# Cloudflare deployment

Production serves Studio and the relay at [buzzzz.theclau.de](https://buzzzz.theclau.de) from one Worker. Static files use Workers assets; `/v1/*`, `/relay`, and `/health` reach the relay. Private uploads use R2 and rooms use SQLite Durable Objects. The `production` environment in `apps/relay/wrangler.jsonc` keeps these resources separate from local development.

## GitHub setup

Configure these in the repository that owns the deployment, currently `notsuhas/Buzzzz`. Other forks and the upstream repository leave deployment disabled unless they explicitly enable it.

| Setting                     | Location                    | Value                                                                                              |
| --------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`      | Repository Actions secret   | Token with Workers Scripts Edit, Workers R2 Storage Edit, and Workers Routes Edit for `theclau.de` |
| `CLOUDFLARE_ACCOUNT_ID`     | Repository Actions variable | The Cloudflare account ID                                                                          |
| `CLOUDFLARE_STUDIO_ORIGIN`  | Repository Actions variable | `https://buzzzz.theclau.de`, without a trailing slash                                              |
| `CLOUDFLARE_DEPLOY_ENABLED` | Repository Actions variable | `true` after the other settings are ready                                                          |

Use a dedicated API token scoped to the deployment account. Store it directly in GitHub's Actions secrets, never in source or chat. Cloudflare's [GitHub Actions guide](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/) explains token creation. Keep the variables at repository scope because the deployment gate runs before the job enters its environment.

Create a GitHub environment named `production` and restrict its deployment branches to `main`. Add required reviewers if you want approval before deployment. The workflow also enforces `push` events on `main`; PRs and feature branches cannot deploy. It waits for quality, browser, and both Expo export jobs to pass.

Each deployment builds Studio with the configured origin and supplies the same origin to the relay allowlist. Wrangler deploys the Worker, assets, Durable Object migration, and private R2 binding together. The pinned Wrangler version creates the named R2 bucket on first deployment if needed. Keep R2 public access disabled.

After deployment, a smoke check loads the website, JavaScript and favicon, checks SPA/API routing and origin isolation, pairs a virtual phone, opens host and phone WebSockets, and verifies signed R2 reads. It deletes its room and uploaded object afterward. A failed smoke check marks the deployment job failed; it does not automatically roll back Durable Object migrations.

Main-branch workflows run in order so a newer push cannot interrupt an active deployment. Pull-request checks can still cancel superseded runs.

## Local deployment

After `bun install`, sign in with `bunx --no-install wrangler login` from `apps/relay`. Use the same account and origin as CI:

```sh
export CLOUDFLARE_ACCOUNT_ID='<account-id>'
export VITE_RELAY_URL='https://buzzzz.theclau.de'
bun run check
bun run test:browser
bun run build
cd apps/relay
bunx --no-install wrangler deploy --env production --dry-run --var "STUDIO_ORIGINS:$VITE_RELAY_URL"
bunx --no-install wrangler deploy --env production --var "STUDIO_ORIGINS:$VITE_RELAY_URL"
bun run test:deployment
```

`VITE_RELAY_URL` must be present during the Studio build, not just deployment. The deploy commands alone do not rebuild Studio. For local production routing checks, build first, then run `wrangler dev --env production --local` with a local origin override and run the smoke check against that origin.

The default Worker name is `buzzzz` and the private bucket is `buzzzz-production-assets`. Change both in the production configuration if the account already uses those names for another project. Do not reuse another application's bucket.

## Domains and recovery

The production configuration declares `buzzzz.theclau.de` as a [Worker custom domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) and disables the workers.dev address. Cloudflare manages its DNS record and HTTPS certificate. The explicit zone ID ties the hostname to the intended zone.

For another domain, update the route's hostname and zone ID, change `CLOUDFLARE_STUDIO_ORIGIN` to that HTTPS origin, and redeploy. Use an active zone in the deployment account and check for existing DNS records before attaching it. When moving an existing deployment, verify the new domain's HTTPS before disabling the old address. The production allowlist accepts only the configured origin, including for host WebSockets. Keep it exact.

Check `/health` and the deployment smoke test after changes. List releases with `bunx --no-install wrangler deployments list --env production`; use `wrangler rollback --env production` for a compatible prior version. Review Durable Object migration compatibility before rolling back.

The smoke test verifies deployed APIs and WebSockets with a virtual phone. Physical phone playback, haptic feel, and iOS native behavior still need their own runtime checks.
