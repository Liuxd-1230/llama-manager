// Studio surfaces route "settings" to the host's global settings drawer,
// which owns the 提示词工坊 tab — the single place studio settings live.
export function openGlobalSettings() {
  window.dispatchEvent(new CustomEvent("llm-open-settings"));
}
