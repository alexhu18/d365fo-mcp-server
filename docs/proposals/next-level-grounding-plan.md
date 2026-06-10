# Next-Level Plan — 100% Grounded, Compilable, BP-Clean Output

> Ground truth: tento plán vychází výhradně ze stávající codebase (`src/`, `bridge/`,
> `docs/`, schéma v `src/metadata/symbolIndex.ts`) a z dat, která server indexuje
> (symbols DB 584k+ symbolů, labels DB, DYNAMICSXREFDB přes bridge). Žádné předpoklady
> z trénovacích dat.

## Co už platí (ověřeno v kódu)

| Schopnost | Kde |
|-----------|-----|
| Symbol index: `signature`, `source`, `used_types`, `method_calls`, `extends_class`, FTS5 | `src/metadata/symbolIndex.ts:259-367` |
| Doménové tabulky: `table_relations`, `form_datasources`, `edt_metadata`, `security_*`, `menu_item_targets`, `extension_metadata` | `src/metadata/symbolIndex.ts:450-575` |
| Bridge read/write + xref: `readtable…readreport`, `findreferences`, `findextensionclasses`, `createobject`, `addmethod`, `setproperty`, `validateobject` (read-back přes IMetadataProvider) | `bridge/D365MetadataBridge/Protocol/RequestDispatcher.cs` |
| Offline BP validátor — 13 regex pravidel (SEL/COC/BP/XML) | `src/tools/validateXpp.ts` |
| Single-round agregátor pro extension práci + grounding token (SHA-256, 30 min TTL) | `src/tools/prepareChange.ts`, `src/utils/provenanceStore.ts` |
| Skutečný kompilátor a BP: MSBuild + `xppbp.exe` na vyžádání | `src/tools/buildProject.ts`, `src/tools/runBpCheck.ts` |
| Metriky nástrojů: calls, latency, emptyResults (in-memory) | `src/utils/toolMetrics.ts` |
| Systémové instrukce: 349 řádků po zeštíhlení | `src/prompts/systemInstructions.ts` |

## Zjištěné mezery (root causes)

1. **Nic neověřuje, že identifikátory ve vygenerovaném kódu existují.** `validate_xpp`
   kontroluje styl (regex), ne sémantiku. Model může vygenerovat `CustTable.MyFakeField`
   a žádná brána to nechytí dřív než MSBuild. Grep potvrzuje: žádný resolver referencí
   proti symbols DB neexistuje.
2. **Grounding enforcement je děravý.** `enforceGrounding()` volá jen `generate_code`
   (`src/tools/codeGen.ts:1860`). `create_d365fo_file` ani `modify_d365fo_file` token
   nevyžadují — commit message fbc2f76 tvrdí opak. Zápis bez důkazu o groundingu je
   stále možný.
3. **Vlastnosti (properties) objektů nemají datově řízenou validaci.** XML001 je jediné
   property pravidlo a je hardcodované. Šablony v `smartXmlBuilder`/`generateD365Xml`
   nastavují properties podle kódu šablon, ne podle toho, co reálně dělá Microsoft
   v indexovaných standardních modelech, a nic je nekonfrontuje s xppbp pravidly
   před zápisem.
4. **Kompilace není součástí smyčky jako levná brána.** `build_d365fo_project` vrací
   surový log; chybí model-scoped rychlá cesta se strukturovanými diagnostikami
   `{file, line, error, fix}` které model zpracuje v jednom kroku.
5. **`prepare_change` pokrývá jen rozšiřování existujících objektů.** Pro tvorbu nových
   objektů (tabulka, forma, třída) musí model skládat kontext z 4–6 samostatných volání
   (search → naming → labels → EDT → patterns) — přesně ty redundantní loopy, které chceme
   eliminovat.
6. **Čerstvost indexu se nehlídá.** Když uživatel změní X++ ve VS, index je stale a server
   to nikde nesignalizuje — odpovědi pak nejsou „aktuální platforma".
7. **Loopy nejsou měřitelné.** `toolMetrics` počítá volání a empty results, ale nevidí
   sekvence (opakovaná identická volání, ping-pong mezi search→info→search).

---

## Pilíře

### Pilíř 1 — Sémantický resolver referencí (`resolve_references`) — anti-halucinační brána č. 1

**Nový soubor:** `src/tools/resolveReferences.ts`

Z vygenerovaného X++/XML vytáhne všechny externí reference a každou ověří proti
jedinému místu pravdy:

| Co se extrahuje | Proti čemu se ověřuje |
|----------------|----------------------|
| Typy (deklarace, `new`, statická volání `Foo::bar()`) | `symbols WHERE name=? AND type IN ('class','table','interface',…)` |
| `table.field` přístupy | `symbols WHERE parent_name=? AND type='field'` (existující index `idx_parent_type_name`) |
| Volání metod + arita | `signature` ze `symbols` (stejná query jako `prepareChange.fetchMethodSignature`) |
| Enum hodnoty `Enum::Value` | `symbols WHERE parent_name=? AND type='enum_value'` |
| Label reference `@SYS…`, `@Model:Key` | labels DB |
| EDT v deklaracích polí | `edt_metadata` |

Výstup: `{unknownSymbols[], wrongArity[], missingFields[], missingLabels[]}` — strojově
čitelný, oprava v témže tahu. Bridge-first kde běží (`resolveobjectinfo` už existuje),
SQLite fallback všude. Vše < 200 ms, žádná kompilace.

**Zapojení fail-closed:** `create_d365fo_file` a `modify_d365fo_file` interně zavolají
resolver před zápisem; při `GROUNDING_ENFORCE=true` neznámý symbol = zápis odmítnut
s přesným seznamem co ověřit. Tím se „100% z codebase" stává vynutitelnou vlastností,
ne prosbou v promptu.

### Pilíř 2 — Uzavření grounding enforcementu

1. `enforceGrounding()` přidat do `create_d365fo_file` (extension varianty) a
   `modify_d365fo_file` — dorovnat kód s tím, co tvrdí commit fbc2f76 a docs.
2. Token vázat na `objectName` (dnes je jen globální hash s TTL — `provenanceStore.ts`):
   token vystavený pro `CustTable` nesmí projít při zápisu do `SalesTable`.
3. **Nový agregátor `prepare_create`** (`src/tools/prepareCreate.ts`) — zrcadlo
   `prepare_change` pro nové objekty. Jedno volání paralelně vrátí: kolizi jmen
   (search), validaci namingu (`validateObjectNaming`), vhodné EDT (`suggestEdt`),
   existující labely (`searchLabels`), doporučený pattern (`getTablePatterns`/
   `getFormPatterns`) a grounding token. Eliminuje 4–6 kol na 1.

### Pilíř 3 — Datově řízený property/BP engine (properties 100% dle BP)

**Princip: pravidla se těží z indexovaných dat, ne píší z hlavy.**

1. **`property_stats` tabulka** v symbols DB, plněná při `build-database` ze stejných
   extrahovaných XML, která už parsuje `enhancedParser`/`xmlParser`: pro každý typ uzlu
   (AxTable, AxTableField*, AxTableIndex, AxFormControl…) a property uložit distribuci
   hodnot napříč standardními Microsoft modely. Příklad: 98 % AxTable má `Label`,
   100 % primárních indexů `AllowDuplicates=No` → z toho plynou pravidla.
2. **`validate_xpp` rozšířit o property vrstvu řízenou daty:** místo dalších hardcoded
   XML pravidel číst `property_stats` + povinné properties odvozené z toho, co
   `xppbp.exe` reálně reportuje (mapování BP error kódů, které už parsuje
   `runBpCheck.ts`). Chybějící/odchylná property → violation s návrhem hodnoty
   převzaté ze statistiky standardu.
3. **Generátory čerpají defaulty ze stejné tabulky:** `smartXmlBuilder`,
   `generate_smart_table/form/report` nastaví properties podle většinové hodnoty
   standardu pro daný pattern, ne podle literálů v šabloně. Šablona se tak nemůže
   rozjet s aktuální verzí platformy — při reindexu nové PU se defaulty samy aktualizují.
4. **Post-write verifikace uvnitř nástroje:** po každém `createobject`/`addfield`/…
   bridge automaticky zavolá `validateobject` (read-back přes IMetadataProvider) a
   výsledek vrátí v té samé odpovědi. Žádné extra agentí kolo — nástroj sám potvrdí,
   že metadata API soubor přečte.

### Pilíř 4 — Kompilace jako strukturovaná brána (`compile_check`)

**Soubor:** rozšíření `src/tools/buildProject.ts` (sdílená infrastruktura), nový tool
`compile_check`.

1. Model-scoped build (jen model z `.mcp.json`, ne celá solution) — nejlevnější běh
   skutečného xppc, jediného arbitra kompilovatelnosti.
2. Výstup parsovat na `{file, line, column, code, message}[]` místo surového logu;
   každou chybu obohatit o fix z `d365foErrorHelp` (už existuje) — model opraví vše
   v jednom tahu.
3. Cache posledního úspěšného buildu per model (hash souborů) → „již ověřeno, beze změn"
   odpověď za ms.
4. Zůstává on-demand (pravidlo č. 3 v CLAUDE.template.md se nemění) — ale když uživatel
   řekne „ověř", je to jedno kolo, ne čtení 5 MB logu.

Invariantní řetěz kvality (každý krok levnější filtr před dražším):
```
resolve_references (<200 ms, index)  →  validate_xpp (<50 ms, pravidla+property_stats)
→  bridge validateobject (read-back)  →  compile_check (xppc, on-demand)
→  run_bp_check (xppbp, on-demand potvrzení)
```

### Pilíř 5 — Minimalizace agentic loops

1. **Dedup identických volání:** v `toolHandler` krátká (60 s) response cache klíčovaná
   `tool+args` — opakované identické volání vrátí cached výsledek s poznámkou
   „duplicate call", místo aby model čekal na DB/bridge znovu.
2. **Sekvenční telemetrie:** rozšířit `toolMetrics.ts` o záznam posledních N volání
   per session (nástroj + hash argumentů). Detekce smyček (3× stejné volání, ping-pong
   A→B→A) → do odpovědi vložit nápovědu „už ses ptal, odpověď byla X / použij
   prepare_change". Snapshoty persistovat do `data/` pro vyhodnocení.
3. **Response contract:** každý read tool vrací sekci `nextAction` (jediný doporučený
   další krok) — vzor už používá `prepare_change` (`:335`); sjednotit napříč nástroji.
4. **Batch read:** `batch_search` existuje; doplnit `batch_get_info` (N objektů jedním
   voláním, interně paralelně jako `prepareChange`).
5. **Instrukce pod 200 řádků:** `systemInstructions.ts` (349) dál zeštíhlit — vše, co je
   pravidlo o kódu, patří do `get_xpp_knowledge`; v promptu zůstane jen rozhodovací
   strom „jaký nástroj kdy" + tvrdé zákazy. Krátké a přesné = účel instrukcí.

### Pilíř 6 — Čerstvost indexu (index = aktuální platforma)

1. **Staleness detektor:** při `get_workspace_info` (povinný první krok dle
   CLAUDE.template.md) porovnat max(mtime) sledovaných modelů s timestampem posledního
   indexu (metadata tabulka v DB). Stale → varování + doporučení `update_symbol_index`.
2. **Auto-reindex změněných souborů:** `debouncedRefresh` v `src/bridge/` už debounced
   mechanismus má — napojit na file-watcher workspace modelu (jen `D365FO_WORKSPACE_PATH`,
   ne celé PackagesLocalDirectory), aby lokální editace ve VS byly v indexu do sekund.
3. **Stáří indexu v odpovědích:** read tooly připojí `indexAge` když index > 24 h starý,
   aby model i uživatel viděli, z jak čerstvé pravdy se odpovídá.

### Pilíř 7 — Měřitelná spolehlivost (eval harness)

1. **Golden scénáře** v `tests/golden/`: reálné zadání → očekávaný výstup, který musí
   projít celou bránou (resolve_references čistý, validate_xpp čistý, na Windows CI
   i compile_check + xppbp). Pokrýt všechny generátory: CoC, event handler, tabulka,
   forma, report, security artefakt, label.
2. **CI gate:** každá změna šablon/generátorů musí projít golden testy — regrese typu
   „`/// ${name} class`" (chyba nalezená v Pillar 2 minulého plánu) se už nemůže vrátit.
3. **KPI z telemetrie:** průměrný počet tool-volání na dokončený úkol, podíl zápisů
   odmítnutých groundingem, podíl výstupů prošlých kompilací napoprvé. Cíl: ≥ 95 %
   kompilace napoprvé, ≤ 3 tool volání na extension úkol.

---

## Pořadí implementace

| Fáze | Změna | Proč v tomto pořadí |
|------|-------|--------------------|
| 1 | Pilíř 2.1+2.2 — utěsnit enforcement (create/modify + token vázaný na objekt) | Nejmenší diff, zavírá známou díru vs. dokumentace |
| 2 | Pilíř 1 — `resolve_references` + zapojení do write nástrojů | Největší dopad na halucinace; staví jen na existujícím indexu |
| 3 | Pilíř 3.1+3.2 — `property_stats` při build-database + datová pravidla ve `validate_xpp` | Vyžaduje rebuild DB, proto dřív než generátory |
| 4 | Pilíř 3.3+3.4 — generátory čtou property defaulty; auto `validateobject` po zápisu | Závisí na fázi 3 |
| 5 | Pilíř 2.3 — `prepare_create` | Zrcadlí hotový `prepare_change` |
| 6 | Pilíř 4 — `compile_check` se strukturovanými diagnostikami | Nezávislé, Windows-only část |
| 7 | Pilíř 5 — dedup, sekvenční telemetrie, response contract, batch_get_info | Průřezové, bezpečné po stabilizaci bran |
| 8 | Pilíř 6 — staleness + auto-reindex | Nezávislé |
| 9 | Pilíř 7 — golden testy + CI gate + KPI | Zamyká vše předchozí proti regresím |

Každá fáze je samostatně mergovatelná s testy (vzor: čtyři fáze commitu fbc2f76).

## Cílový invariant (po implementaci)

Žádný zápis X++ ani XML neprojde, dokud každý referencovaný symbol, pole, enum,
label a EDT není doložen v indexu/bridge (fail-closed), property neodpovídají
statistice standardní platformy a kód neprošel offline pravidly. Kompilátor a xppbp
pak jen potvrzují, co levné brány už zaručily — a model k tomu potřebuje 1 přípravné
volání, 1 generaci a 1 zápis.
