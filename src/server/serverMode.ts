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
 * Tools that require local Windows VM filesystem access (K:\ drive) or read
 * local server state not available from Azure (e.g. in-memory config, .mcp.json).
 *
 * These tools have three properties in common:
 *  1. They access local paths (K:\PackagesLocalDirectory, K:\VSProjects, .mcp.json)
 *     that are NOT reachable from an Azure-hosted instance.
 *  2. They do NOT need the symbol database — they skip the dbReady await.
 *  3. They are the tools available in 'write-only' (local companion) mode.
 *
 * The set also includes the bridge-backed READ surface (get_object_info, get_method_source,
 * get_method_signature) which works in write-only mode via IMetadataProvider — no SQLite needed.
 * This allows Copilot to verify objects it just created without an Azure re-deploy.
 *
 * - Excluded in 'read-only' mode (Azure deployment can't access local K:\ paths)
 * - The only tools exposed in 'write-only' mode (lightweight local companion)
 *
 * Members:
 *  create_d365fo_file   — writes XML to K:\PackagesLocalDirectory
 *  modify_d365fo_file   — edits XML on K:\PackagesLocalDirectory
 *  labels (write actions — create/rename) — writes to / rewrites K:\PackagesLocalDirectory label files + source references
 *  verify_d365fo_project — reads .rnrproj from K:\VSProjects
 *  get_workspace_info   — scans .rnrproj via D365FO_SOLUTIONS_PATH (K:\); reads
 *                         .mcp.json + in-memory config/stdio session state;
 *                         on Azure would return irrelevant server info, not dev
 *                         workspace info — so it's excluded from read-only mode
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
  // Bridge-backed member reader: works in write-only mode via IMetadataProvider
  // (no SQLite needed — bridge reads directly from disk). get_method unifies the
  // former get_method_signature + get_method_source via the `include` discriminator.
  // The bridge-backed OBJECT readers (class/table/form/…) are now reached through
  // get_object_info, which is in ALWAYS_TOOLS so it stays available in every mode.
  'get_method',
]);

/**
 * Tools exposed in EVERY server mode (full / read-only / write-only), bypassing
 * the LOCAL_TOOLS partition.
 *
 * get_object_info dispatches to both bridge-backed types (class/table/… — usable
 * on the local VM / write-only companion) and SQLite-backed types
 * (service/map/config-key/security-policy/macro — usable on Azure read-only).
 * Because it spans both localities it cannot live in a single partition, so it is
 * always published; per-type it returns a clear message when its backing source
 * is unavailable in the current mode.
 */
export const ALWAYS_TOOLS = new Set([
  'get_object_info',
  // `labels` mixes read (search/info) and write (create/rename) actions.
  // The read actions must work on Azure read-only; the write actions need K:\
  // access and are gated at runtime by the underlying handler returning a clear
  // error when the local filesystem isn't reachable.
  'labels',
  // `d365fo_file` mixes a read-capable action (generate → XML text, works on
  // Azure read-only) with write actions (create/modify → need K:\). Same gating
  // approach as `labels`: the create/modify handlers return a clear error when
  // the local filesystem isn't reachable.
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
