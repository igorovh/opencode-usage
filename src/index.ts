import { Plugin } from "@opencode/plugin";

/**
 * Server-side half of the usage plugin. All rendering happens in the TUI
 * plugin (src/tui.tsx); the server side only needs to exist so the host
 * registers the plugin.
 */
export default Plugin.define({
  id: "usage",
  setup() {},
});
