using System;
using System.Collections.Generic;
using System.Data;
using System.Data.SqlClient;
using System.Linq;
using D365MetadataBridge.Models;

namespace D365MetadataBridge.Services
{
    /// <summary>
    /// Provides cross-reference queries using the DYNAMICSXREFDB SQL database.
    /// This replaces the FTS5 text-search approach with real compiler-resolved references.
    ///
    /// ## Query failures are errors, never empty results
    ///
    /// Every method here answers one question — "what else touches this?" — and the answer
    /// drives whether it is safe to change something. A failed query used to be returned as
    /// a SUCCESSFUL response carrying count=0 plus an `error` field, which reads to any
    /// caller that does not inspect the extra field as the strongest possible clearance:
    /// "nothing references this, go ahead". A down or unreachable xref database therefore
    /// produced false negatives on exactly the question the service exists to answer, and
    /// the more broken the database, the safer everything looked.
    ///
    /// So failures throw. RequestDispatcher.HandleXref turns them into a JSON-RPC error, and
    /// the TS adapters already treat a rejected call as "no answer from the bridge" and fall
    /// back to their own scan instead of trusting a zero.
    /// </summary>
    public class CrossReferenceService
    {
        /// <summary>
        /// Rethrows a failed xref query as an error the dispatcher will surface, with the
        /// query's subject in the message so the caller can see what was NOT answered.
        /// </summary>
        private static Exception QueryFailed(string operation, string subject, Exception cause)
        {
            Console.Error.WriteLine($"[CrossRefService] {operation}({subject}) failed: {cause.Message}");
            return new InvalidOperationException(
                $"Cross-reference query {operation}('{subject}') failed: {cause.Message}. " +
                "This is NOT an empty result — the cross-reference database did not answer, so nothing " +
                "can be concluded about references to this object.", cause);
        }

        private readonly string _connectionString;

        public CrossReferenceService(string server, string database)
        {
            _connectionString = $"Server={server};Database={database};Integrated Security=True;TrustServerCertificate=True;";

            // Test the connection
            using (var conn = new SqlConnection(_connectionString))
            {
                conn.Open();
                Console.Error.WriteLine($"[CrossRefService] Connected to {server}\\{database}");
            }
        }

        // ============================================================
        // Path parsing helpers
        // ============================================================

        /// <summary>
        /// Parse a DYNAMICSXREFDB path like "/Classes/SalesFormLetter/Methods/run"
        /// into (objectType, objectName, segment, segmentName).
        /// </summary>
        private static (string objectType, string objectName, string? segment, string? segmentName) ParsePath(string path)
        {
            // Paths: /Classes/X, /Classes/X/Methods/Y, /Tables/X, /Tables/X/Fields/Y
            var parts = path.Split(new[] { '/' }, StringSplitOptions.RemoveEmptyEntries);
            string objectType = parts.Length >= 1 ? parts[0] : "";
            string objectName = parts.Length >= 2 ? parts[1] : "";
            string? segment = parts.Length >= 3 ? parts[2] : null;
            string? segmentName = parts.Length >= 4 ? parts[3] : null;
            return (objectType, objectName, segment, segmentName);
        }

        // DYNAMICSXREFDB [References].Kind values.
        //
        // These were DECODED EMPIRICALLY (2026-09-09) by sampling source/target path pairs per
        // value across three live xref databases spanning two platform versions (10.0.2645.99,
        // 10.0.2645.111, 10.0.2428.205). The mapping was identical in all three.
        //
        // The previous comment here claimed "1=Read/Reference, 2=DerivedFrom/Extends". Both
        // halves were wrong, and the second one was costly: Kind 2 is the GENERIC type
        // reference — 18.3M of the 28M rows — so every `EcoResDescription desc;` declaration and
        // every `NoYes::Yes` read was being reported as "extends". A where-used on /Enums/NoYes
        // came back 500-for-500 "extends", which nothing can extend. Extends is Kind 4.
        private const byte KindCall = 1;        // method call:        Foo/Methods/a -> Bar/Methods/b
        private const byte KindTypeRef = 2;     // names a type:       ... -> /Edts/Counter
        private const byte KindImplements = 3;  // class -> interface: AbsNettingMarkTransMgr -> INettingMarkTrans
        private const byte KindExtends = 4;     // class -> base:      _Performance -> RunBaseBatch
        private const byte KindDelegate = 6;    // ... -> /Property/IsDelegate
        private const byte KindAttribute = 7;   // ... -> /Classes/HookableAttribute
        private const byte KindTag = 9;         // ... -> /Tags/<tag>
        private const byte KindOverride = 10;   // super():            Foo/Methods/pack -> Base/Methods/pack

        /// <summary>
        /// Escape the LIKE metacharacters in a literal that is being CONCATENATED into a LIKE
        /// pattern. Parameterising the pattern stops SQL injection but not this: inside a LIKE,
        /// "_" still means "any single character".
        ///
        /// That matters here because the D365 CoC naming convention is "&lt;Base&gt;_Extension",
        /// so essentially every class name this service handles contains an underscore, and an
        /// unescaped "/Classes/Foo_Extension/Methods/%" also matches "/Classes/FooXExtension/…".
        /// A census of this xref DB found no name pair that actually collides that way, so this
        /// is closing a latent hole rather than a live miscount — but the patterns are built from
        /// class names and element paths, and nothing stops the next model from shipping the pair.
        ///
        /// "[" must be replaced FIRST, or it would go on to escape the brackets introduced by the
        /// other two replacements.
        /// </summary>
        private static string EscapeLike(string literal) =>
            literal.Replace("[", "[[]").Replace("%", "[%]").Replace("_", "[_]");

        /// <summary>
        /// Last slash-separated segment of an xref path — the member name for a
        /// "/Container/Owner/Methods/name" path. Null when the path has no segments.
        /// </summary>
        private static string? LeafSegment(string path)
        {
            var parts = path.Split(new[] { '/' }, StringSplitOptions.RemoveEmptyEntries);
            return parts.Length > 0 ? parts[parts.Length - 1] : null;
        }

        /// <summary>
        /// Categorize a reference from its xref Kind, refining the generic type-reference
        /// kind by what the target actually is. See the Kind constants above for how the
        /// values were established.
        /// </summary>
        private static string CategorizeReference(byte? kind, string sourcePath, string targetPath)
        {
            switch (kind)
            {
                case KindCall: return "call";
                case KindImplements: return "implements";
                case KindExtends: return "extends";
                case KindDelegate: return "delegate-declaration";
                case KindAttribute: return "attribute";
                case KindTag: return "tag";
                case KindOverride: return "override";
            }

            // Kind 2 (and anything unrecognised): the source line names the target. Say what
            // kind of naming it is from the target's shape.
            if (targetPath.Contains("/Fields/")) return "field-access";

            var (_, _, targetSeg, _) = ParsePath(targetPath);
            if (targetSeg == "Methods") return "method-reference";
            if (string.IsNullOrEmpty(targetSeg)) return "type-reference";

            return "reference";
        }

        // ============================================================
        // P1: FindReferences — enriched with referenceType + caller parsing
        // ============================================================

        /// <summary>
        /// Find all references to a given object path.
        /// Enriched: returns referenceType (call/extends/field-access/type-reference)
        /// and callerClass/callerMethod parsed from the source path.
        /// </summary>
        public object FindReferences(string objectPath)
        {
            var references = new List<ReferenceInfoModel>();

            // Container segments that can own methods/fields, used to expand a
            // member-qualified ("Owner.member") input across object types.
            string[] memberContainers = { "Tables", "Classes", "Forms", "Views", "DataEntityViews", "Queries", "Maps" };

            var pathVariants = new List<string>();
            bool memberQualified = false;
            if (objectPath.Contains("/"))
            {
                // Explicit path — as given: an AOT path ("/Tables/SalesTable/Methods/initFromX")
                // or a metadata one ("Table/SalesTable"). An X++ one gets its metadata twin below.
                pathVariants.Add(objectPath);
                memberQualified = objectPath.Contains("/Methods/") || objectPath.Contains("/Fields/") ||
                    objectPath.Contains("/Method/") || objectPath.Contains("/TableField") ||
                    objectPath.Contains("/EnumValues/") || objectPath.Contains("/EnumValue/") ||
                    objectPath.Contains("/TableIndexs/") || objectPath.Contains("/TableIndex/") ||
                    objectPath.Contains("/TableFieldGroups/") || objectPath.Contains("/TableFieldGroup/");
            }
            else if (objectPath.Contains("."))
            {
                // Member-qualified bare input ("Owner.member"): scope to a single
                // method/field on its declaring type. We don't know whether Owner is
                // a Table/Class/… so expand method+field variants across containers;
                // only the path that actually exists will match.
                memberQualified = true;
                var dot = objectPath.LastIndexOf('.');
                var owner = objectPath.Substring(0, dot);
                var member = objectPath.Substring(dot + 1);
                foreach (var c in memberContainers)
                {
                    pathVariants.Add($"/{c}/{owner}/Methods/{member}");
                    pathVariants.Add($"/{c}/{owner}/Fields/{member}");
                }
                pathVariants.Add($"/Enums/{owner}/EnumValues/{member}");
                // "Form.DataSource.method": a form data source's method.
                var ownerDot = owner.IndexOf('.');
                if (ownerDot > 0 && owner.IndexOf('.', ownerDot + 1) < 0)
                    pathVariants.Add($"/Forms/{owner.Substring(0, ownerDot)}/DataSources/{owner.Substring(ownerDot + 1)}/Methods/{member}");
            }
            else
            {
                // Bare name — we do not know which AOT type it is, so try every container
                // that can be the TARGET of a reference. A target is stored in one of TWO
                // shapes, depending on which provider wrote the reference:
                //
                //   X++ code (provider Xppc.exe): plural + leading slash — "/Tables/<name>",
                //     "/Edts/<name>", children "/Tables/<name>/Fields/<f>", ".../Methods/<m>".
                //   Declarative metadata (provider Metadata): singular, NO leading slash, and
                //     for an EDT its concrete subtype — "Table/<name>", "Form/<name>",
                //     "EdtString/<name>", children "Table/<name>/TableFieldString/<f>",
                //     "Table/<name>/Method/<m>". Source paths of these rows carry the referencing
                //     property ("Form/F/FormDataSourceRoot/<name>?Table").
                //
                // Only the first shape used to be queried, on the belief — stated here — that
                // targets were always plural + slash. On a live DYNAMICSXREFDB (platform
                // 7.0.7858, 19.5M references) the second shape holds 2.3M of them, every one
                // Kind 2: a table's form data sources, relations, entity mappings and field
                // bindings, and the table fields typed with an EDT. A where-used on a custom
                // table returned 334 of its 785 references; on a custom EDT, 12 of 108, and
                // none of the fields using it.
                //
                // Edts/Maps/Reports/MenuItem* were missing here, so a where-used on any of
                // them returned zero rows and the TS caller silently degraded to its
                // name-based index scan. For an EDT that is close to useless, because an
                // EDT's real usages are table fields and form control properties — metadata,
                // not X++ text.
                foreach (var c in new[]
                {
                    "Tables", "Classes", "Enums", "Views", "DataEntityViews", "Queries", "Forms",
                    "Edts", "Maps", "Reports",
                    "MenuItemDisplays", "MenuItemActions", "MenuItemOutputs",
                })
                {
                    pathVariants.Add($"/{c}/{objectPath}");
                }
            }

            // Every X++-shaped target also exists in the metadata shape; query both,
            // whichever way the target was given. A table field or enum value may also come
            // from an extension, which is matched by pattern (see AddExtensionMembers).
            var extensionPatterns = new List<string>();
            foreach (var p in pathVariants.ToList())
            {
                AddMetadataTwins(p, pathVariants);
                AddExtensionMembers(p, extensionPatterns);
            }
            pathVariants = pathVariants.Distinct(StringComparer.Ordinal).ToList();

            // Also add sub-paths (methods, fields) so we catch method-level references.
            // A member-qualified target already points at an exact leaf path, so adding
            // "/%" children would wrongly pull in unrelated nested references — skip it.
            var extraPaths = new List<string>();
            if (!memberQualified)
            {
                foreach (var p in pathVariants)
                {
                    // LIKE pattern for children. Only this derived copy is escaped — the
                    // variants themselves go into an IN (...) equality list, where "_" is
                    // an ordinary character and escaping it would stop them matching.
                    extraPaths.Add(EscapeLike(p) + "/%");
                }
            }

            // Build parameterized query with IN + LIKE
            var paramNames = new List<string>();
            var allParams = new List<(string name, string value)>();
            for (int i = 0; i < pathVariants.Count; i++)
            {
                paramNames.Add($"@P{i}");
                allParams.Add(($"@P{i}", pathVariants[i]));
            }
            var likeConditions = new List<string>();
            var likePatterns = extraPaths.Concat(extensionPatterns).ToList();
            for (int i = 0; i < likePatterns.Count; i++)
            {
                var pname = $"@L{i}";
                likeConditions.Add($"tgt.Path LIKE {pname}");
                allParams.Add((pname, likePatterns[i]));
            }

            var whereClause = $"tgt.Path IN ({string.Join(",", paramNames)})";
            if (likeConditions.Count > 0)
                whereClause += $" OR {string.Join(" OR ", likeConditions)}";

            // Rows are capped PER SHAPE and the totals counted separately. With one cap for
            // both, rows sorted by source path put every "/Classes/…" code row before any
            // "Form/…" metadata row, so a table with 500 code references (CustTable)
            // returned no metadata at all — the very rows this lookup exists to add. The
            // candidate names are resolved once: the LIKEs against Names are the costly
            // part, the joins on [References].TargetId are indexed. The totals join the
            // source name exactly as the rows do: [References] keeps rows whose SourceId is
            // no longer in Names (77 of the 93 references to one table field on a live
            // database), and counting those made the rows look like a sample of a total
            // nobody could list.
            string ShapeRows(string shape) => $@"
                SELECT * FROM (
                    SELECT TOP ({RowsPerShape})
                        src.Path AS SourcePath, t.Path AS TargetPath, sm.Module AS SourceModule,
                        r.Kind, r.Line, r.[Column]
                    FROM #xrefTargets t
                    INNER JOIN [References] r ON r.TargetId = t.Id
                    INNER JOIN dbo.Names src ON src.Id = r.SourceId
                    LEFT  JOIN dbo.Modules sm ON sm.Id = src.ModuleId
                    WHERE {shape}
                    ORDER BY src.Path, r.Line) AS shapeRows";
            var query = $@"
                SELECT tgt.Id, tgt.Path INTO #xrefTargets FROM dbo.Names tgt WHERE ({whereClause});
                SELECT SourcePath, TargetPath, SourceModule, Kind, Line, [Column] FROM (
                    {ShapeRows("t.Path LIKE N'/%'")}
                    UNION ALL
                    {ShapeRows("t.Path NOT LIKE N'/%'")}
                ) AS rows
                ORDER BY CASE WHEN TargetPath LIKE N'/%' THEN 0 ELSE 1 END, SourcePath, Line;
                SELECT COUNT(*), SUM(CASE WHEN t.Path LIKE N'/%' THEN 0 ELSE 1 END)
                FROM #xrefTargets t INNER JOIN [References] r ON r.TargetId = t.Id
                INNER JOIN dbo.Names src ON src.Id = r.SourceId;
                DROP TABLE #xrefTargets;";
            int total = 0, metadataTotal = 0;

            try
            {
                using (var conn = new SqlConnection(_connectionString))
                {
                    conn.Open();
                    using (var cmd = new SqlCommand(query, conn))
                    {
                        foreach (var (name, value) in allParams)
                            cmd.Parameters.AddWithValue(name, value);
                        cmd.CommandTimeout = 30;

                        using (var reader = cmd.ExecuteReader())
                        {
                            while (reader.Read())
                            {
                                var sourcePath = reader.GetString(0);
                                var targetPath = reader.GetString(1);
                                byte? kindByte = reader.IsDBNull(3) ? (byte?)null : reader.GetByte(3);

                                var (srcType, srcObj, srcSeg, srcSegName) = ParsePath(sourcePath);

                                references.Add(new ReferenceInfoModel
                                {
                                    SourcePath = sourcePath,
                                    SourceModule = reader.IsDBNull(2) ? null : reader.GetString(2),
                                    Kind = kindByte?.ToString(),
                                    Line = reader.IsDBNull(4) ? 0 : (int)reader.GetInt16(4),
                                    Column = reader.IsDBNull(5) ? 0 : (int)reader.GetInt16(5),
                                    ReferenceType = CategorizeReference(kindByte, sourcePath, targetPath),
                                    CallerClass = srcObj,
                                    CallerMethod = srcSeg == "Methods" ? srcSegName : null,
                                });
                            }
                            if (reader.NextResult() && reader.Read())
                            {
                                total = reader.IsDBNull(0) ? 0 : reader.GetInt32(0);
                                metadataTotal = reader.IsDBNull(1) ? 0 : reader.GetInt32(1);
                            }
                        }
                    }
                }
            }
            catch (SqlException ex)
            {
                throw QueryFailed("findReferences", objectPath, ex);
            }

            // count: rows returned; total / metadataTotal: every matching reference.
            return new { objectPath, count = references.Count, total, metadataTotal, references };
        }

        /// <summary>Rows returned per target shape (X++ code, declarative metadata).</summary>
        private const int RowsPerShape = 500;

        /// <summary>
        /// The singular metadata type names a plural X++ container is stored under, with
        /// every EDT subtype found as a target in a live DYNAMICSXREFDB.
        /// </summary>
        private static readonly Dictionary<string, string[]> MetadataTypes = new Dictionary<string, string[]>(StringComparer.Ordinal)
        {
            ["Tables"] = new[] { "Table" },
            ["Classes"] = new[] { "Class" },
            ["Enums"] = new[] { "Enum" },
            ["Views"] = new[] { "View" },
            ["DataEntityViews"] = new[] { "DataEntityView" },
            ["Queries"] = new[] { "QuerySimple", "QueryComposite" },
            ["Forms"] = new[] { "Form" },
            ["Maps"] = new[] { "Map" },
            ["Reports"] = new[] { "Report" },
            ["MenuItemDisplays"] = new[] { "MenuItemDisplay" },
            ["MenuItemActions"] = new[] { "MenuItemAction" },
            ["MenuItemOutputs"] = new[] { "MenuItemOutput" },
            ["Edts"] = new[]
            {
                "EdtString", "EdtReal", "EdtEnum", "EdtInt64", "EdtDate", "EdtInt", "EdtUtcDateTime",
                "EdtContainer", "EdtGuid", "EdtTime",
            },
        };

        /// <summary>
        /// The segment a field is stored under in the metadata shape, per container — it
        /// names the field's type, so there is one per type. Every segment found as a
        /// target in a live DYNAMICSXREFDB. Listed rather than matched with
        /// "TableField%": in LIKE "%" also crosses "/", so "Table/T/TableField%/Name"
        /// matched the field group "Table/T/TableFieldGroup/Name" as well — and a table
        /// with a field and a field group of the same name is common
        /// (AccountingDistributionTemplate.Name).
        /// </summary>
        private static readonly Dictionary<string, string[]> MetadataFieldSegments = new Dictionary<string, string[]>(StringComparer.Ordinal)
        {
            ["Tables"] = new[]
            {
                "TableFieldString", "TableFieldEnum", "TableFieldReal", "TableFieldInt64", "TableFieldInt",
                "TableFieldDate", "TableFieldUtcDateTime", "TableFieldGuid", "TableFieldContainer", "TableFieldTime",
            },
            ["Maps"] = new[]
            {
                "MapFieldString", "MapFieldEnum", "MapFieldReal", "MapFieldInt64", "MapFieldInt",
                "MapFieldDate", "MapFieldUtcDateTime", "MapFieldGuid", "MapFieldContainer", "MapFieldTime",
            },
            ["Views"] = new[]
            {
                "ViewFieldBound", "ViewFieldComputedString", "ViewFieldComputedEnum", "ViewFieldComputedReal",
                "ViewFieldComputedInt64", "ViewFieldComputedInt", "ViewFieldComputedDate", "ViewFieldComputedUtcDateTime",
            },
            ["DataEntityViews"] = new[]
            {
                "DataEntityViewMappedField", "DataEntityViewUnmappedFieldString", "DataEntityViewUnmappedFieldEnum",
                "DataEntityViewUnmappedFieldReal", "DataEntityViewUnmappedFieldInt64", "DataEntityViewUnmappedFieldInt",
                "DataEntityViewUnmappedFieldDate", "DataEntityViewUnmappedFieldUtcDateTime",
                "DataEntityViewUnmappedFieldGuid", "DataEntityViewUnmappedFieldContainer",
            },
        };

        /// <summary>
        /// Add the metadata twin of an X++-shaped target path: "/Tables/T" → "Table/T",
        /// "/Edts/E" → "EdtString/E", … ; for a member, "/Views/V/Methods/m" →
        /// "View/V/Method/m" (tables, classes, forms, views, data entities, maps) and
        /// "/Tables/T/Fields/f" → "Table/T/TableFieldString/f", "Table/T/TableFieldEnum/f", …
        /// (tables, maps, views, data entities); "/Tables/T/TableIndexs/i" → "Table/T/TableIndex/i",
        /// "/Tables/T/TableFieldGroups/g" → "Table/T/TableFieldGroup/g"; a form data source's
        /// method "/Forms/F/DataSources/DS/Methods/m" → "Form/F/FormDataSourceRoot/DS/Method/m".
        /// Metadata-shaped and unknown paths add nothing.
        /// </summary>
        private static void AddMetadataTwins(string xppPath, List<string> exact)
        {
            if (!xppPath.StartsWith("/")) return;
            var parts = xppPath.Split(new[] { '/' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 2 || !MetadataTypes.TryGetValue(parts[0], out var types)) return;
            if (parts.Length == 2)
            {
                foreach (var t in types) exact.Add($"{t}/{parts[1]}");
            }
            else if (parts.Length == 4)
            {
                if (parts[2] == "Methods")
                {
                    foreach (var t in types) exact.Add($"{t}/{parts[1]}/Method/{parts[3]}");
                }
                else if (parts[2] == "Fields" && MetadataFieldSegments.TryGetValue(parts[0], out var segments))
                {
                    foreach (var t in types)
                        foreach (var s in segments) exact.Add($"{t}/{parts[1]}/{s}/{parts[3]}");
                }
                else if (parts[2] == "EnumValues" && parts[0] == "Enums")
                {
                    exact.Add($"Enum/{parts[1]}/EnumValue/{parts[3]}");
                }
                // X++ spells these "TableIndexs" / "TableFieldGroups"; metadata singular.
                else if (parts[2] == "TableIndexs")
                {
                    foreach (var t in types) exact.Add($"{t}/{parts[1]}/TableIndex/{parts[3]}");
                }
                else if (parts[2] == "TableFieldGroups")
                {
                    foreach (var t in types) exact.Add($"{t}/{parts[1]}/TableFieldGroup/{parts[3]}");
                }
            }
            else if (parts.Length == 6 && parts[0] == "Forms" && parts[2] == "DataSources" && parts[4] == "Methods")
            {
                // A form data source's method: "/Forms/F/DataSources/DS/Methods/m" and
                // "Form/F/FormDataSourceRoot/DS/Method/m". Every data source is stored at the
                // root, joined ones included, under its own name (not its table's).
                exact.Add($"Form/{parts[1]}/FormDataSourceRoot/{parts[3]}/Method/{parts[5]}");
            }
        }

        /// <summary>
        /// A field a table extension adds, and a value an enum extension adds, are stored
        /// under the extension only, in both shapes: "/TableExtensions/T.Ext/Fields/f" and
        /// "TableExtension/T.Ext/TableFieldString/f", "/EnumExtensions/E.Ext/EnumValues/v"
        /// and "EnumExtension/E.Ext/EnumValue/v". On a live DYNAMICSXREFDB that is 17,788 and
        /// 8,769 references, and a where-used on "PurchLine.&lt;added field&gt;" found none of them:
        /// "/Tables/PurchLine/Fields/&lt;f&gt;" has no references at all. An extension is always
        /// named "&lt;base&gt;.&lt;suffix&gt;" (every one of the 1,104 on that database), so the
        /// suffix is the only wildcard; the member segment after it is exact.
        /// </summary>
        private static void AddExtensionMembers(string xppPath, List<string> patterns)
        {
            var parts = xppPath.Split(new[] { '/' }, StringSplitOptions.RemoveEmptyEntries);
            if (!xppPath.StartsWith("/") || parts.Length != 4) return;
            var baseName = EscapeLike(parts[1]);
            var member = EscapeLike(parts[3]);
            if (parts[0] == "Tables" && parts[2] == "Fields")
            {
                patterns.Add($"/TableExtensions/{baseName}.%/Fields/{member}");
                foreach (var s in MetadataFieldSegments["Tables"])
                    patterns.Add($"TableExtension/{baseName}.%/{s}/{member}");
            }
            else if (parts[0] == "Enums" && parts[2] == "EnumValues")
            {
                patterns.Add($"/EnumExtensions/{baseName}.%/EnumValues/{member}");
                patterns.Add($"EnumExtension/{baseName}.%/EnumValue/{member}");
            }
        }

        // ============================================================
        // P3: FindExtensionClasses — enriched with method-level CoC detail
        // ============================================================

        /// <summary>
        /// The attribute a Chain of Command class carries. Stored under this exact path — it is
        /// "ExtensionOf", NOT "ExtensionOfAttribute" like most other attribute names in Names.
        /// </summary>
        private const string ExtensionOfAttributePath = "/Classes/ExtensionOf";

        /// <summary>
        /// Containers a CoC class extension can be based on. [ExtensionOf] accepts
        /// classStr/tableStr/formStr/viewStr/mapStr/dataEntityViewStr/queryStr, so the base is
        /// by no means always a class — the caller passes a bare name and we resolve which.
        /// </summary>
        private static readonly string[] CocBaseContainers =
            { "Classes", "Tables", "Forms", "Views", "Maps", "DataEntityViews", "Queries" };

        /// <summary>
        /// The extended artifact from one [ExtensionOf] declaration: the terminal element of the
        /// prefix chain the intrinsic's arguments produce.
        ///
        /// Two details that are load-bearing:
        ///  * Comparison is case-INSENSITIVE. The xref stores the same element under inconsistent
        ///    casing — "/Forms/PurchTable/DataSources/purchLine" alongside
        ///    "/Forms/PurchTable/DataSources/PurchLine/DataFields/PriceUnit" — so an ordinal
        ///    StartsWith fails to see the chain and returns the ANCESTOR. That was 3 wrong answers
        ///    in 4,696 before this was fixed. The database collation is CI_AS, so SQL already
        ///    matches this way and the two layers must agree.
        ///  * Targets are bounded to the ExtensionOf attribute's own argument window. 52 declarations
        ///    share their line with a second attribute, and that attribute's arguments are references
        ///    on the same line. On the corpus measured, none of them changed an answer (the
        ///    co-attribute either takes no metadata argument or names the same element), so this is
        ///    insurance rather than a live fix — but it is what makes those 52 safe by design.
        ///
        /// Returns null when the declaration produced no usable target.
        /// </summary>
        private static string? ResolveExtendedElement(List<(string target, int kind, int col)> refs, int extCol)
        {
            // The next attribute to the right closes ExtensionOf's argument window.
            var limit = int.MaxValue;
            foreach (var (target, kind, col) in refs)
                if (kind == KindAttribute && target != ExtensionOfAttributePath && col > extCol && col < limit)
                    limit = col;

            var scoped = new List<string>();
            foreach (var (target, kind, col) in refs)
                if (kind == KindTypeRef && col > extCol && col < limit && !scoped.Contains(target))
                    scoped.Add(target);

            if (scoped.Count == 0) return null;

            // Maximum of the prefix order: the one nothing else extends.
            foreach (var candidate in scoped)
            {
                var isPrefixOfAnother = false;
                foreach (var other in scoped)
                {
                    if (ReferenceEquals(other, candidate)) continue;
                    if (other.StartsWith(candidate + "/", StringComparison.OrdinalIgnoreCase)) { isPrefixOfAnother = true; break; }
                }
                if (!isPrefixOfAnother) return candidate;
            }

            // Not a chain — shouldn't happen (zero cases in 4,696), so prefer the deepest rather
            // than silently returning an ancestor.
            scoped.Sort((a, b) => b.Length.CompareTo(a.Length));
            return scoped[0];
        }

        /// <summary>
        /// True when <paramref name="element"/> IS the requested object, or is nested inside it
        /// (a form's data source, control or data field). Nested hits are kept deliberately: an
        /// agent about to wrap SalesLine.active on a form needs to see it is already wrapped. The
        /// caller groups them by element so they are never pooled with the parent's own count.
        /// </summary>
        private static bool IsRequestedOrNested(string element, string baseName)
        {
            foreach (var container in CocBaseContainers)
            {
                var basePath = $"/{container}/{baseName}";
                if (string.Equals(element, basePath, StringComparison.OrdinalIgnoreCase)) return true;
                if (element.StartsWith(basePath + "/", StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        /// <summary>
        /// Find the Chain of Command extension classes of a given base object, together with
        /// the base methods each one wraps. The base may be a class, table, form, view, map,
        /// data entity or query — [ExtensionOf] accepts all of them.
        /// </summary>
        public object FindExtensionClasses(string baseClassName)
        {
            // className → (module, the element the class actually extends)
            var extensionClassNames = new Dictionary<string, (string? module, string element)>();

            try
            {
                using (var conn = new SqlConnection(_connectionString))
                {
                    conn.Open();

                    // Step 1 — identify genuine [ExtensionOf] classes and READ what each extends.
                    //
                    // History: this accepted `r.Kind = 2 OR src.Path LIKE '%_Extension%'`, believing
                    // Kind 2 meant DerivedFrom. It does not (see the Kind constants above) — it is
                    // the generic type reference, so every class that merely MENTIONED the base was
                    // reported as extending it. On SalesFormLetter: 259 reported against 9 real.
                    //
                    // How the extended element is recovered. `ExtensionOf` takes ONE string
                    // (`public void new(str name)`); the multiplicity comes from the INTRINSIC that
                    // produces it. While resolving e.g. formDataFieldStr(Form, DataSource, Field)
                    // the compiler emits one Kind 2 reference per metadata level it names, and those
                    // levels are nested by construction:
                    //     /Forms/VendOpenTrans
                    //     /Forms/VendOpenTrans/DataSources/TaxWithholdTrans
                    //     /Forms/VendOpenTrans/DataSources/TaxWithholdTrans/DataFields/TaxReimbursement_IT
                    // So the targets form a PREFIX CHAIN and the extended artifact is its terminal
                    // element — the one that is not a proper prefix of any other. That is a maximum
                    // of a partial order, not a "longest string" guess, and it was checked rather
                    // than assumed: across all 4,696 ExtensionOf classes in a live xref DB the set
                    // is a single chain every time (zero ambiguous). Measured element shapes:
                    // /Classes/* 2633, /Tables/* 828, /Forms/* 696, /Forms/*/DataSources/* 241,
                    // /DataEntityViews/* 170, /Forms/*/Controls/* 77,
                    // /Forms/*/DataSources/*/DataFields/* 41, /Maps/* 6, /Views/* 4.
                    //
                    // Reading the element (rather than matching any declaration-level reference)
                    // is what keeps a table CoC apart from a form CoC of the same name, and it drops
                    // classes that name the base for some OTHER reason — e.g.
                    // SalesCopyingTAMDeduction_Extension extends /Classes/SalesCopying but also
                    // references /Tables/SalesTable from a different attribute on another line.
                    //
                    // Candidate classes are those naming the requested object anywhere in their
                    // ExtensionOf declaration; the element test below then decides. `LIKE base + '/%'`
                    // admits nested elements (a form's data sources, controls and data fields), which
                    // the caller groups and labels separately.
                    var whereTargets = new List<string>();
                    var sqlParams = new List<(string name, string value)>();
                    for (int i = 0; i < CocBaseContainers.Length; i++)
                    {
                        whereTargets.Add($"cand.Path = @T{i} OR cand.Path LIKE @P{i}");
                        // @T is an equality test and takes the name as-is; only @P is a LIKE pattern.
                        sqlParams.Add(($"@T{i}", $"/{CocBaseContainers[i]}/{baseClassName}"));
                        sqlParams.Add(($"@P{i}", $"/{CocBaseContainers[i]}/{EscapeLike(baseClassName)}/%"));
                    }

                    // Returns every Kind 2 target on each candidate's ExtensionOf line, plus the
                    // columns needed to bound them to that attribute's own arguments. The chain is
                    // resolved in C# because SQL cannot express "maximum of the prefix order"
                    // cheaply, and the set per class is tiny (1-3 rows).
                    var sql = $@"
                        WITH extLine AS (
                            SELECT DISTINCT ra.SourceId, ra.Line, ra.[Column] AS ExtCol
                            FROM [References] ra
                            JOIN [Names] att ON att.Id = ra.TargetId
                            WHERE ra.Kind = {KindAttribute} AND att.Path = @ExtensionOfAttr
                        ),
                        candidates AS (
                            SELECT DISTINCT e.SourceId, e.Line, e.ExtCol
                            FROM extLine e
                            JOIN [References] rc ON rc.SourceId = e.SourceId AND rc.Line = e.Line AND rc.Kind = {KindTypeRef}
                            JOIN [Names] cand ON cand.Id = rc.TargetId
                            WHERE {string.Join(" OR ", whereTargets.Select(w => $"({w})"))}
                        )
                        SELECT src.Path, m.Module, tgt.Path, r.Kind, r.[Column]
                        FROM candidates c
                        JOIN [Names] src ON src.Id = c.SourceId
                        LEFT JOIN [Modules] m ON m.Id = src.ModuleId
                        JOIN [References] r ON r.SourceId = c.SourceId AND r.Line = c.Line
                                           AND r.Kind IN ({KindTypeRef}, {KindAttribute})
                        JOIN [Names] tgt ON tgt.Id = r.TargetId
                        WHERE c.ExtCol = (SELECT MIN(c2.ExtCol) FROM candidates c2 WHERE c2.SourceId = c.SourceId)
                        ORDER BY src.Path";

                    // class → (module, extCol, [(target, kind, column)])
                    var raw = new Dictionary<string, (string? module, int extCol, List<(string target, int kind, int col)> refs)>();

                    using (var cmd = new SqlCommand(sql, conn))
                    {
                        foreach (var (name, value) in sqlParams)
                            cmd.Parameters.AddWithValue(name, value);
                        cmd.Parameters.AddWithValue("@ExtensionOfAttr", ExtensionOfAttributePath);
                        cmd.CommandTimeout = 60;

                        using (var reader = cmd.ExecuteReader())
                        {
                            while (reader.Read())
                            {
                                var path = reader.GetString(0);
                                var parts = path.Split('/');
                                var className = parts.Length >= 3 ? parts[2] : path;
                                var module = reader.IsDBNull(1) ? null : reader.GetString(1);
                                var target = reader.GetString(2);
                                var kind = reader.IsDBNull(3) ? 0 : reader.GetByte(3);
                                var col = reader.IsDBNull(4) ? 0 : (int)reader.GetInt16(4);

                                if (!raw.TryGetValue(className, out var entry))
                                {
                                    entry = (module, int.MaxValue, new List<(string, int, int)>());
                                    raw[className] = entry;
                                }
                                entry.refs.Add((target, kind, col));
                                // The ExtensionOf attribute's own column anchors the argument window.
                                if (kind == KindAttribute && target == ExtensionOfAttributePath && col < entry.extCol)
                                    entry = (entry.module, col, entry.refs);
                                raw[className] = entry;
                            }
                        }
                    }

                    foreach (var kv in raw)
                    {
                        var element = ResolveExtendedElement(kv.Value.refs, kv.Value.extCol);
                        if (element == null) continue;
                        // Keep only classes whose ELEMENT is the requested object or nested inside
                        // it. This is what discards a class that named the base incidentally.
                        if (!IsRequestedOrNested(element, baseClassName)) continue;
                        extensionClassNames[kv.Key] = (kv.Value.module, element);
                    }

                    // Step 2 — which base methods each extension actually WRAPS.
                    //
                    // A CoC wrap shows up as a Kind 1 (call) from the extension's method to the
                    // base method OF THE SAME NAME — that call is the `next`. The previous query
                    // filtered on neither the kind nor the name, so it collected every base
                    // method the class happened to call: that is why non-extensions came back
                    // claiming to wrap "construct, update", which were merely the calls they made.
                    var results = new List<ExtensionClassDetailModel>();

                    foreach (var kvp in extensionClassNames)
                    {
                        var extClassName = kvp.Key;
                        var (module, element) = kvp.Value;

                        var methodSql = $@"
                            SELECT DISTINCT src.Path, tgt.Path
                            FROM [References] r
                            JOIN [Names] src ON r.SourceId = src.Id
                            JOIN [Names] tgt ON r.TargetId = tgt.Id
                            WHERE src.Path LIKE @ExtClassMethods
                              AND tgt.Path LIKE @BaseClassMethods
                              AND r.Kind = {KindCall}";

                        var wrappedMethods = new List<string>();

                        using (var cmd2 = new SqlCommand(methodSql, conn))
                        {
                            // Both patterns are escaped: "_Extension" is the CoC naming convention, so
                            // extClassName almost always carries an underscore, and an element path
                            // can too ("/Forms/…/DataFields/TaxReimbursement_IT").
                            cmd2.Parameters.AddWithValue("@ExtClassMethods", $"/Classes/{EscapeLike(extClassName)}/Methods/%");
                            // Anchored to the EXTENDED ELEMENT, not to the requested object. That is
                            // the whole payoff of reading the element: a form CoC wraps a method on
                            // one specific data source ("/Forms/SalesTable/DataSources/SalesLine/
                            // Methods/active"), and the SalesTable form has NINE data sources with an
                            // `active` method. Scoping to the base and matching leaf names alone could
                            // not tell them apart; scoping to the element makes the question exact.
                            cmd2.Parameters.AddWithValue("@BaseClassMethods", $"{EscapeLike(element)}/Methods/%");
                            cmd2.CommandTimeout = 60;

                            using (var reader2 = cmd2.ExecuteReader())
                            {
                                while (reader2.Read())
                                {
                                    // Same leaf name on both sides = the `next` call.
                                    var srcLeaf = LeafSegment(reader2.GetString(0));
                                    var tgtLeaf = LeafSegment(reader2.GetString(1));
                                    if (srcLeaf == null || tgtLeaf == null) continue;
                                    if (!string.Equals(srcLeaf, tgtLeaf, StringComparison.OrdinalIgnoreCase)) continue;
                                    if (!wrappedMethods.Contains(tgtLeaf))
                                        wrappedMethods.Add(tgtLeaf);
                                }
                            }
                        }

                        results.Add(new ExtensionClassDetailModel
                        {
                            ClassName = extClassName,
                            Module = module,
                            ExtendedElement = element,
                            WrappedMethods = wrappedMethods,
                        });
                    }

                    // Ordered so the caller's grouping is stable and the requested object's own
                    // extensions lead, with nested elements (data sources, controls, data fields)
                    // following in path order.
                    results.Sort((a, b) =>
                    {
                        var byElement = string.Compare(a.ExtendedElement, b.ExtendedElement, StringComparison.OrdinalIgnoreCase);
                        return byElement != 0 ? byElement : string.Compare(a.ClassName, b.ClassName, StringComparison.OrdinalIgnoreCase);
                    });

                    return new
                    {
                        baseClassName,
                        count = results.Count,
                        extensions = results,
                        _source = "C# bridge (DYNAMICSXREFDB)"
                    };
                }
            }
            catch (Exception ex)
            {
                throw QueryFailed("findExtensionClasses", baseClassName, ex);
            }
        }

        // ============================================================
        // P4: FindEventSubscribers — enriched with event type filtering
        // ============================================================

        /// <summary>
        /// Find event handler / subscriber classes for a given target object.
        /// Enriched: supports optional eventName and handlerType filtering.
        /// Returns individual method entries with eventName and handlerType classification.
        /// </summary>
        public object FindEventSubscribers(string targetName, string? eventNameFilter = null, string? handlerTypeFilter = null)
        {
            var results = new List<EventSubscriberDetailModel>();

            try
            {
                using (var conn = new SqlConnection(_connectionString))
                {
                    conn.Open();

                    // Query: find all references TO the target from classes with event-related patterns
                    // Broader than before: include ALL referencing classes, not just *EventHandler named ones
                    var sql = @"
                        SELECT DISTINCT src.Path, m.Module
                        FROM [References] r
                        JOIN [Names] src ON r.SourceId = src.Id
                        JOIN [Names] tgt ON r.TargetId = tgt.Id
                        LEFT JOIN [Modules] m ON src.ModuleId = m.Id
                        WHERE (
                            tgt.Path LIKE @TargetTable
                            OR tgt.Path LIKE @TargetTablePath
                            OR tgt.Path LIKE @TargetClass
                            OR tgt.Path LIKE @TargetClassPath
                        )
                        AND src.Path LIKE '/Classes/%'
                        AND (
                            src.Path LIKE '%EventHandler%'
                            OR src.Path LIKE '%_Handler%'
                            OR src.Path LIKE '%Events%'
                            OR src.Path LIKE '%_Extension%'
                        )
                        ORDER BY src.Path";

                    using (var cmd = new SqlCommand(sql, conn))
                    {
                        // All four are compared with LIKE (see the WHERE above), so all four
                        // are escaped — including the two with no trailing wildcard, where an
                        // unescaped "_" would still match any single character.
                        var escTarget = EscapeLike(targetName);
                        cmd.Parameters.AddWithValue("@TargetTable", $"/Tables/{escTarget}");
                        cmd.Parameters.AddWithValue("@TargetTablePath", $"/Tables/{escTarget}/%");
                        cmd.Parameters.AddWithValue("@TargetClass", $"/Classes/{escTarget}");
                        cmd.Parameters.AddWithValue("@TargetClassPath", $"/Classes/{escTarget}/%");

                        using (var reader = cmd.ExecuteReader())
                        {
                            while (reader.Read())
                            {
                                var path = reader.GetString(0);
                                var parts = path.Split('/');
                                var className = parts.Length >= 3 ? parts[2] : path;
                                var methodName = parts.Length >= 5 ? parts[4] : null;
                                var module = reader.IsDBNull(1) ? null : reader.GetString(1);

                                // Classify handler type based on naming conventions
                                var handlerType = ClassifyHandlerType(className, methodName, path);
                                var eventName = ExtractEventName(methodName, className, targetName);

                                // Apply filters
                                if (eventNameFilter != null && eventName != null
                                    && !string.Equals(eventName, eventNameFilter, StringComparison.OrdinalIgnoreCase))
                                    continue;
                                if (handlerTypeFilter != null && handlerTypeFilter != "all"
                                    && !string.Equals(handlerType, handlerTypeFilter, StringComparison.OrdinalIgnoreCase))
                                    continue;

                                results.Add(new EventSubscriberDetailModel
                                {
                                    ClassName = className,
                                    Module = module,
                                    MethodName = methodName,
                                    EventName = eventName,
                                    HandlerType = handlerType,
                                });
                            }
                        }
                    }
                }

                // Deduplicate by class+method
                var distinct = results
                    .GroupBy(r => $"{r.ClassName}.{r.MethodName}")
                    .Select(g => g.First())
                    .ToList();

                return new
                {
                    targetName,
                    count = distinct.Count,
                    handlers = distinct,
                    _source = "C# bridge (DYNAMICSXREFDB)"
                };
            }
            catch (Exception ex)
            {
                throw QueryFailed("findEventSubscribers", targetName, ex);
            }
        }

        /// <summary>Classify handler type based on naming conventions.</summary>
        private static string ClassifyHandlerType(string className, string? methodName, string path)
        {
            var combined = $"{className}.{methodName}".ToLowerInvariant();
            if (combined.Contains("dataevent") || combined.Contains("oninserted") ||
                combined.Contains("onupdated") || combined.Contains("ondeleted") ||
                combined.Contains("onvalidated") || combined.Contains("oninit"))
                return "dataEvent";
            if (combined.Contains("pre_") || combined.Contains("_pre"))
                return "pre";
            if (combined.Contains("post_") || combined.Contains("_post"))
                return "post";
            if (combined.Contains("delegate"))
                return "delegate";
            return "static"; // default for SubscribesTo handlers
        }

        /// <summary>Extract event name from method/class naming patterns.</summary>
        private static string? ExtractEventName(string? methodName, string className, string targetName)
        {
            if (methodName == null) return null;

            // Common patterns: onInserted_handler, onValidatedWrite_handler, etc.
            var lower = methodName.ToLowerInvariant();
            var standardEvents = new[] { "oninserted", "onupdated", "ondeleted",
                "onvalidatedwrite", "onvalidatedinsert", "onvalidateddelete",
                "oninitialized", "oninitvalue" };

            foreach (var ev in standardEvents)
            {
                if (lower.Contains(ev))
                    return ev.Substring(0, 1).ToUpper() + ev.Substring(1); // Capitalize
            }

            return methodName;
        }

        // ============================================================
        // P5: FindApiUsageCallers — callers of an API via References
        // ============================================================

        /// <summary>
        /// Find all callers of a given API class/method via cross-reference database.
        /// Groups results by caller class for pattern analysis.
        /// </summary>
        public object FindApiUsageCallers(string apiName, int limit = 200)
        {
            var callers = new List<ApiUsageCallerModel>();

            var pathVariants = new List<string>();
            if (apiName.StartsWith("/"))
            {
                pathVariants.Add(apiName);
            }
            else
            {
                // The "/%" children are LIKE patterns and get escaped; the bare paths are
                // dispatched to "=" below, where "_" is an ordinary character.
                pathVariants.Add($"/Classes/{apiName}");
                pathVariants.Add($"/Classes/{EscapeLike(apiName)}/%");
                pathVariants.Add($"/Tables/{apiName}");
                pathVariants.Add($"/Tables/{EscapeLike(apiName)}/%");
            }

            // Build WHERE clause
            var conditions = new List<string>();
            var allParams = new List<(string name, string value)>();
            for (int i = 0; i < pathVariants.Count; i++)
            {
                var pname = $"@T{i}";
                if (pathVariants[i].Contains("%"))
                    conditions.Add($"tgt.Path LIKE {pname}");
                else
                    conditions.Add($"tgt.Path = {pname}");
                allParams.Add((pname, pathVariants[i]));
            }

            var query = $@"
                SELECT TOP {limit}
                    src.Path AS SourcePath,
                    sm.Module AS SourceModule,
                    r.Kind,
                    r.Line
                FROM [References] r
                INNER JOIN dbo.Names tgt ON tgt.Id = r.TargetId
                INNER JOIN dbo.Names src ON src.Id = r.SourceId
                LEFT  JOIN dbo.Modules sm ON sm.Id = src.ModuleId
                WHERE ({string.Join(" OR ", conditions)})
                AND src.Path LIKE '/Classes/%'
                ORDER BY sm.Module, src.Path, r.Line";

            try
            {
                using (var conn = new SqlConnection(_connectionString))
                {
                    conn.Open();
                    using (var cmd = new SqlCommand(query, conn))
                    {
                        foreach (var (name, value) in allParams)
                            cmd.Parameters.AddWithValue(name, value);
                        cmd.CommandTimeout = 30;

                        using (var reader = cmd.ExecuteReader())
                        {
                            while (reader.Read())
                            {
                                var sourcePath = reader.GetString(0);
                                var (_, callerClass, seg, segName) = ParsePath(sourcePath);

                                callers.Add(new ApiUsageCallerModel
                                {
                                    CallerClass = callerClass,
                                    CallerMethod = seg == "Methods" ? segName : null,
                                    Module = reader.IsDBNull(1) ? null : reader.GetString(1),
                                    Kind = reader.IsDBNull(2) ? null : reader.GetByte(2).ToString(),
                                    Line = reader.IsDBNull(3) ? 0 : (int)reader.GetInt16(3),
                                });
                            }
                        }
                    }
                }
            }
            catch (SqlException ex)
            {
                throw QueryFailed("findApiUsageCallers", apiName, ex);
            }

            // Group by caller class for pattern summary
            var byClass = callers
                .GroupBy(c => c.CallerClass)
                .Select(g => new
                {
                    callerClass = g.Key,
                    module = g.First().Module,
                    methods = g.Where(c => c.CallerMethod != null)
                               .Select(c => c.CallerMethod!)
                               .Distinct()
                               .ToList(),
                    callCount = g.Count()
                })
                .OrderByDescending(x => x.callCount)
                .ToList();

            return new
            {
                apiName,
                totalCallers = callers.Count,
                uniqueClasses = byClass.Count,
                callersByClass = byClass,
                callers,
                _source = "C# bridge (DYNAMICSXREFDB)"
            };
        }

        // ============================================================
        // Schema / Debug helpers
        // ============================================================

        /// <summary>
        /// Discover the actual schema of the DYNAMICSXREFDB for debugging.
        /// </summary>
        public object GetSchemaInfo()
        {
            var tables = new List<object>();

            using (var conn = new SqlConnection(_connectionString))
            {
                conn.Open();
                var tableNames = new List<string>();
                using (var cmd = new SqlCommand(
                    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
                    conn))
                {
                    using (var reader = cmd.ExecuteReader())
                    {
                        while (reader.Read()) tableNames.Add(reader.GetString(0));
                    }
                }

                foreach (var tbl in tableNames)
                {
                    var cols = new List<string>();
                    using (var cmd = new SqlCommand(
                        $"SELECT COLUMN_NAME + ' (' + DATA_TYPE + ')' FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @T ORDER BY ORDINAL_POSITION",
                        conn))
                    {
                        cmd.Parameters.AddWithValue("@T", tbl);
                        using (var reader = cmd.ExecuteReader())
                        {
                            while (reader.Read()) cols.Add(reader.GetString(0));
                        }
                    }
                    tables.Add(new { table = tbl, columns = cols });
                }
            }

            return new { database = "DYNAMICSXREFDB", tables };
        }

        /// <summary>
        /// Sample rows from a table for debugging.
        /// </summary>
        public object SampleRows(string tableName)
        {
            if (!System.Text.RegularExpressions.Regex.IsMatch(tableName, @"^[a-zA-Z_]\w*$"))
                throw new ArgumentException("Invalid table name");

            var rows = new List<Dictionary<string, object?>>();

            using (var conn = new SqlConnection(_connectionString))
            {
                conn.Open();
                using (var cmd = new SqlCommand($"SELECT TOP 10 * FROM [{tableName}]", conn))
                {
                    using (var reader = cmd.ExecuteReader())
                    {
                        while (reader.Read())
                        {
                            var row = new Dictionary<string, object?>();
                            for (int i = 0; i < reader.FieldCount; i++)
                            {
                                row[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i)?.ToString();
                            }
                            rows.Add(row);
                        }
                    }
                }
            }

            return new { tableName, count = rows.Count, rows };
        }
    }
}
