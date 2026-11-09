# Publish & listing checklist

Two **independent** paths exist for making the plugin discoverable in Magpie.
They are not mutually exclusive, and neither has been executed for this
repository yet — everything below is preparation only. Nothing in this repo
should be described as "reviewed" or "curated" until it actually is.

---

## Path 1 — Unofficial discovery via the GitHub `magpie-plugin` topic

Repos with the `magpie-plugin` topic appear under **插件 → 发现 → 非官方
插件 · GitHub** (sorted by stars, marked as unreviewed). Requirements per the
[plugin docs](https://usemagpie.ai/docs/zh/plugins) and how this repo meets
them:

- [ ] **`package.json` at the repository root** — present.
- [ ] **Loadable straight from the repo** — `dist/index.js` is **committed**
      (do not gitignore it; "dist 只在发布时才构建的仓库不会显示").
- [ ] **`repository` points at this repo** — once pushed, npm-installed
      users get releases; otherwise Magpie installs the repo code as-is.
- [ ] **`magpie` metadata** — `name` ("CloudBase Bridge"), `summary.en` /
      `summary.zh`, `icon` (inline SVG data URI), `maxConcurrency: 4` — all
      present. Note: card name/summary coming from the package itself are
      labeled “包自己的话” (nobody reviewed them).
- [ ] **LICENSE file** — MIT at the root (GitHub derives the license from it).
- [ ] **Add the GitHub topic** `magpie-plugin` (repo → About ⚙ → Topics).
      GitHub discovery polls at most every 10 minutes; new topics appear
      within minutes.

Steps for the maintainer:

1. Create the GitHub repository `cloudbase-bridge` and push everything
   (including `dist/`).
2. The `repository`/`homepage`/`bugs` fields in `package.json` already point
   at `DaBinBinah/cloudbase-bridge`.
3. Add the topic `magpie-plugin`.
4. Optionally tag a release (`v0.1.0`); the docs note that a branch/tag
   mismatch vs. what Bun installed drives the "update" indicator.

## Path 2 — npm package

```bash
npm login
npm publish          # files allowlist ships dist/, cloudfunctions/, README, LICENSE
# users can then: magpie plugin add opencode-cloudbase-bridge
```

- [ ] Keywords already include `opencode`, `opencode-plugin`, `magpie`,
      `magpie-plugin`, `cloudbase`, `provider` — Magpie's plugin search
      queries npm for `<keyword> opencode` and matches names/keywords with
      `opencode` + (`auth`|`plugin`|`provider`).
- [ ] The npm **README is what Magpie's plugin detail page displays** — keep
      install/login/credential-storage/models sections accurate (they are).
- [ ] For updates: bump `version`, `npm publish`; Magpie shows an update dot.

## Path 3 — Curated magpie-community registry (separate PR)

The recommended list under the plugin page comes from the
`registry.json` in the [magpie-community/plugins](https://github.com/magpie-community/plugins)
repository; Magpie pulls it every ~6 h (also settable via
`MAGPIE_PLUGIN_MARKET=<url>` to preview your entry, or `off` for the built-in
copy). A prepared entry lives at
[`examples/registry-entry.json`](../examples/registry-entry.json):

```json
{
  "package": "opencode-cloudbase-bridge",
  "name": "CloudBase Bridge",
  "providers": ["cloudbase"],
  "summary": {
    "en": "Tencent CloudBase (mini-program growth plan) via your own aiProxy cloud function.",
    "zh": "通过你自部署的 aiProxy 云函数接入腾讯云开发（小程序成长计划）模型。"
  }
}
```

Steps for the maintainer (only when you want the curated listing):

1. Fork `magpie-community/plugins`, add the entry above to `registry.json`,
   and open a **PR**. Do not describe the plugin as accepted until merged.
2. Alternative: contribute the package itself to the community monorepo
   under `packages/<name>` with the community naming convention for
   provider packages, `@magpie-community/opencode-<name>-auth` (e.g.
   `@magpie-community/opencode-cloudbase-bridge-auth`). Community packages
   auto-update in every Magpie install. Keep runtime dependencies at zero
   (this plugin already is dependency-free).
3. Preview before/while filing: `MAGPIE_PLUGIN_MARKET=<raw-registry-url> magpie …`.

## Pre-flight before any of the above

- [ ] `npm run check` passes locally (typecheck + build + 32 tests + load check).
- [ ] Magpie sandbox round-trip on a real environment:
      `m plugin add …` → `m plugin login cloudbase` →
      `m provider test cloudbase` → `m provider test cloudbase hy3`.
- [ ] No credentials anywhere in the repo: `git grep -iE "apikey|secret" -- '*.ts' '*.js' '*.md'`
      should only hit docs/code that *talks about* keys, never real values.
- [ ] README states (truthfully) that the plugin is not reviewed/curated.

## Release hygiene

- Update `CHANGELOG.md`, bump the version in `package.json` (SemVer),
  rebuild so `dist/` matches the source, commit, then publish/tag.
