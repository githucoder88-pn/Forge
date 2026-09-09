# Local plugins

Drop plugin directories here (each with a `forge.plugin.json`), then:

```bash
forge serve --plugins ./plugins
```

Plugins are **fully-trusted local code** — see
[docs/plugins.md](../docs/plugins.md) and the trust boundary in
[SECURITY.md](../SECURITY.md). A working example lives in
[examples/custom-tool-plugin](../examples/custom-tool-plugin/).
