# Changelog

## 1.0.4

- Fix Codex upgrades when an older local marketplace with the same name is already registered. Verify the old source, switch through the public Codex CLI, verify the installed plugin version, and restore the previous marketplace and plugin if the upgrade fails.
- Add success, repeat-install, and rollback regression coverage for the Codex marketplace upgrade path.
- Support the DeepSeek Harness `@deepseek-ai/dsh-tools` 0.1.5-rc.2 and 0.2.1-rc.2 schema subsets. Nullable outputs use `oneOf` so tool registration works on the installed 0.1.5 host.
- Register Codex tools and bridge lifecycle tools independently. A failure in one group no longer prevents the other group from registering, and authenticated `/health` reports registration errors.
- Add regression coverage against the installed DSH host's actual JSON Schema assertions for all seven tools.
- Keep task reply content push-only until verified bilateral closure, with state-only waiting and closed-task archive access.
- Publish separate Codex and DeepSeek install instructions and preserve prior local candidate versions.