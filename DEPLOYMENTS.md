# Deployments

Live **studionet** deployments. studionet charges no gas; deploys are signed by
an ephemeral key, so **each `npm run deploy` mints a NEW contract address**.
Update this file whenever you redeploy.

## Source Credibility Registry

| Field | Value |
| --- | --- |
| Network | `studionet` (`https://studio.genlayer.com/api`) |
| Contract | `0x7FdAD2722e4aB0Dac13983Caa177f123E8325787` |
| Deployer | `0xeD5ba8f2C1Ce875bf71E98bD6f6c25b243eb3AEa` |
| Runner | `py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6` (GenVM v0.2.16) |
| Status | deploy SUCCESS; `register_source` + reads verified; `assess_credibility` LLM judge verified (Wikipedia/Bitcoin -> score 95) |

### Verified flows

- `register_source(url, category, fallbacks)` -> persists record (score 50, PENDING)
- `get_record` / `get_trusted_source` / `list_sources` -> read back OK
- `assess_credibility(url)` -> `web.render` + LLM + non-comparative consensus;
  graceful OFFLINE handling when a page fails to load

> Note: `assess_credibility` is non-deterministic; the tx may pass through
> several consensus rounds (`NO_MAJORITY` -> `COMMITTING`) before finalizing.
> Contract state is readable at `ACCEPTED`.
