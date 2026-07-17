/**
 * Server mode configuration.
 *
 * Controls which tools are exposed by this MCP server instance,
 * enabling a hybrid deployment where:
 *  - An Azure-hosted instance runs in 'read-only' mode (search / analysis)
 *  - A local Windows VM instance runs in 'write-only' mode (file operations)
 *
 * Set via environment variable:  MCP_SERVER_MODE=full|read-only|write-only
 */

/**
 * Tools that need local Windows VM filesystem access (K:\ drive) or local server
 * state not reachable from Azure. Excluded in 'read-only' mode; the only tools
 * exposed in 'write-only' (local companion) mode. These skip the dbReady await
 * since they don't need the symbol database.
 *
 * Also includes the bridge-backed read surface (get_method) which works via
 * IMetadataProvider without SQLite, so Copilot can verify objects it just
 * created without an Azure re-deploy.
 */
export const LOCAL_TOOLS = new Set([
  'verify_d365fo_project',
  'update_symbol_index',
  'build_d365fo_project',
  'trigger_db_sync',
  'run_bp_check',
  'run_systest_class',
  'review_workspace_changes',
  'undo_last_modification',
  'get_workspace_info',
  'get_method',
]);

/**
 * Tools exposed in EVERY server mode, bypassing the LOCAL_TOOLS partition,
 * because each spans both localities and gates unavailable actions at runtime:
 *  - get_object_info: dispatches to bridge-backed types (local VM) and
 *    SQLite-backed types (Azure read-only).
 *  - labels: read actions (search/info) work on Azure; write actions
 *    (create/rename) need K:\ and error clearly when unreachable.
 *  - d365fo_file: generate works on Azure; create/modify need K:\ and error
 *    clearly when unreachable.
 */
export const ALWAYS_TOOLS = new Set([
  'get_object_info',
  'labels',
  'd365fo_file',
]);

/**
 * @deprecated Use LOCAL_TOOLS — kept temporarily so any external import doesn't break.
 * Will be removed in the next major release.
 */
export const WRITE_TOOLS = LOCAL_TOOLS;

/**
 * Server mode, resolved once at startup from MCP_SERVER_MODE env var.
 * - 'full'       (default) – all tools registered (local development)
 * - 'read-only'  – LOCAL_TOOLS excluded   (Azure App Service deployment)
 * - 'write-only' – only LOCAL_TOOLS exposed (lightweight local companion)
 */
export type ServerMode = 'full' | 'read-only' | 'write-only';

export const SERVER_MODE: ServerMode = (() => {
  const raw = (process.env.MCP_SERVER_MODE ?? 'full').toLowerCase().trim();
  if (raw === 'read-only' || raw === 'readonly') return 'read-only';
  if (raw === 'write-only' || raw === 'writeonly') return 'write-only';
  return 'full';
})();

/**
 * Single source of truth for whether a tool is callable in a given server mode.
 * Used by BOTH the ListTools filter (mcpServer) and the runtime call gate
 * (toolHandler) so the advertised tool list and call-time enforcement can
 * never drift apart. ALWAYS_TOOLS bypass the LOCAL_TOOLS partition in every mode.
 */
export function isToolAllowedInMode(mode: ServerMode, toolName: string): boolean {
  if (mode === 'full' || ALWAYS_TOOLS.has(toolName)) return true;
  return mode === 'read-only' ? !LOCAL_TOOLS.has(toolName) : LOCAL_TOOLS.has(toolName);
}
