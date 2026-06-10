# New Tool Registration Checklist

Every new MCP tool requires changes in these files. Check each item before opening a PR.

## Implementation

- [ ] Create `src/tools/<toolName>.ts` — tool logic + exported `*Tool(request, context?)` function
- [ ] Export `*ToolDefinition` (input schema) or define it inline in `mcpServer.ts`
- [ ] Add `import` + `case '<tool_name>':` in `src/tools/toolHandler.ts`
- [ ] Add tool `ListToolsResultSchema` entry in `src/server/mcpServer.ts`
- [ ] Add `TOOL_ANNOTATIONS` entry in `src/server/toolAnnotations.ts` (display title + readOnly/destructive hints — enforced by toolInventory test)
- [ ] Add a progress message case in `src/utils/toolProgressMessage.ts`
- [ ] Decide locality: add to `LOCAL_TOOLS` in `src/server/serverMode.ts` only if the tool requires local filesystem/Windows access

## Startup catalog (index.ts)

- [ ] Add `{ name: '<tool_name>', desc: '...' }` to the correct category in `src/index.ts` tool catalog (HTTP mode log)
- [ ] Update the `const totalTools = N` constant in `src/index.ts` (stdio mode log)
- [ ] Update the category description string in `src/index.ts` (e.g. `'8 discovery + ... + 2 code-quality'`)

## Tests

- [ ] Create `tests/tools/<tool-name>.test.ts` with at minimum: input validation, happy path, error path
- [ ] Update `tests/utils/toolInventory.test.ts`: increment `toHaveLength(N)` counts (mcpServer + startupCatalog) and the non-local count
- [ ] If the tool touches knowledge base entries: add cases to `tests/tools/xpp-knowledge.test.ts`

## Documentation

- [ ] Add tool entry to `docs/MCP_TOOLS.md` (name, description, parameters, example prompt)
- [ ] Update tool count in `README.md` (headline + paragraph + MCP_TOOLS.md reference)
- [ ] Update tool count in `docs/ARCHITECTURE.md` (tool totals in architecture description)
- [ ] Update tool count in `docs/MCP_TOOLS.md` header
- [ ] Update tool count in `docs/QUICK_START.md`, `docs/MCP_CONFIG.md`, `docs/CLAUDE_CODE_SETUP.md`
- [ ] Add tool to Core Tool Mapping table in `.github/copilot-instructions.md` if user-facing

## Quick count check

```
grep -c "name: '" src/server/mcpServer.ts  # total unique tool definitions
grep -c "name: '" src/index.ts             # must match
```
