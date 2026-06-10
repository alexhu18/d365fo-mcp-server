/**
 * MCP tool annotations — display titles + behavior hints for every tool.
 *
 * Applied to the ListTools response in mcpServer.ts. Clients use these for UX:
 *  - `title`           → VS Code chat shows "Ran Search D365FO index" instead of
 *                        "Ran search"
 *  - `readOnlyHint`    → read-only tools skip the write-confirmation dialog,
 *                        speeding up agentic flows
 *  - `destructiveHint` → tools that overwrite/rewrite existing content get an
 *                        explicit confirmation
 *  - `idempotentHint`  → repeated identical calls are safe (build, sync, index)
 *  - `openWorldHint`   → false everywhere: this server only touches the local
 *                        D365FO metadata store and symbol index, never the
 *                        open internet
 *
 * Per MCP spec these are HINTS for display/UX, not security boundaries.
 * Every tool in mcpServer.ts MUST have an entry here — enforced by
 * tests/utils/toolInventory.test.ts.
 */

export interface ToolAnnotations {
  title: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** Read/analysis tool — no filesystem or DB writes. */
function read(title: string): ToolAnnotations {
  return { title, readOnlyHint: true, openWorldHint: false };
}

/** Write tool — creates or modifies files / DB state. */
function write(
  title: string,
  opts: { destructive?: boolean; idempotent?: boolean } = {},
): ToolAnnotations {
  return {
    title,
    readOnlyHint: false,
    destructiveHint: opts.destructive ?? false,
    idempotentHint: opts.idempotent ?? false,
    openWorldHint: false,
  };
}

export const TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
  // ── Search & discovery ────────────────────────────────────────────────────
  search:                           read('Search D365FO index'),
  batch_search:                     read('Batch search D365FO index'),
  search_extensions:                read('Search custom extensions'),
  find_references:                  read('Find references'),
  find_coc_extensions:              read('Find CoC extensions'),
  find_event_handlers:              read('Find event handlers'),
  search_labels:                    read('Search labels'),

  // ── Object inspection ─────────────────────────────────────────────────────
  get_class_info:                   read('Read class info'),
  get_table_info:                   read('Read table info'),
  get_form_info:                    read('Read form info'),
  get_query_info:                   read('Read query info'),
  get_view_info:                    read('Read view info'),
  get_enum_info:                    read('Read enum info'),
  get_edt_info:                     read('Read EDT info'),
  get_report_info:                  read('Read report info'),
  get_data_entity_info:             read('Read data entity info'),
  get_menu_item_info:               read('Read menu item info'),
  get_method_signature:             read('Read method signature'),
  get_method_source:                read('Read method source'),
  get_label_info:                   read('Read label info'),
  get_table_extension_info:         read('Read table extensions'),
  get_security_artifact_info:       read('Read security artifact'),
  get_security_coverage_for_object: read('Read security coverage'),

  // ── Analysis & guidance ───────────────────────────────────────────────────
  analyze_code_patterns:            read('Analyze code patterns'),
  analyze_class_completeness:       read('Analyze class completeness'),
  analyze_extension_points:         read('Analyze extension points'),
  recommend_extension_strategy:     read('Recommend extension strategy'),
  suggest_method_implementation:    read('Suggest method implementation'),
  suggest_edt:                      read('Suggest EDT for field'),
  get_api_usage_patterns:           read('Get API usage patterns'),
  get_table_patterns:               read('Get table patterns'),
  get_form_patterns:                read('Get form patterns'),
  get_xpp_knowledge:                read('Read X++ knowledge base'),
  get_d365fo_error_help:            read('Look up D365FO error help'),
  code_completion:                  read('Suggest code completions'),
  validate_object_naming:           read('Validate object naming'),
  validate_xpp:                     read('Validate X++ code'),
  resolve_references:               read('Resolve symbol references'),
  prepare_change:                   read('Prepare grounded change context'),
  prepare_create:                   read('Prepare grounded create context'),

  // ── Text generation (no disk writes) ──────────────────────────────────────
  generate_code:                    read('Generate X++ code pattern'),
  generate_d365fo_xml:              read('Generate D365FO XML'),

  // ── Diagnostics ───────────────────────────────────────────────────────────
  get_workspace_info:               read('Read workspace configuration'),
  verify_d365fo_project:            read('Verify D365FO project'),
  review_workspace_changes:         read('Review workspace changes'),
  run_bp_check:                     read('Run Best Practices check'),

  // ── File & label writes ───────────────────────────────────────────────────
  create_d365fo_file:               write('Create D365FO object file'),
  modify_d365fo_file:               write('Modify D365FO object file', { destructive: true }),
  create_label:                     write('Create label'),
  rename_label:                     write('Rename label', { destructive: true }),
  undo_last_modification:           write('Undo last modification', { destructive: true }),
  // generate_smart_* write the generated XML to PackagesLocalDirectory
  // (bridge or SmartXmlBuilder→fs fallback); they refuse to overwrite.
  generate_smart_table:             write('Generate smart table'),
  generate_smart_form:              write('Generate smart form'),
  generate_smart_report:            write('Generate smart report'),

  // ── SDLC operations ───────────────────────────────────────────────────────
  update_symbol_index:              write('Update symbol index', { idempotent: true }),
  build_d365fo_project:             write('Build D365FO project', { idempotent: true }),
  trigger_db_sync:                  write('Trigger database sync', { idempotent: true }),
  run_systest_class:                write('Run SysTest unit tests'),
};
