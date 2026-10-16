using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;

namespace D365MetadataBridge.Services.Trace
{
    /// <summary>
    /// `D365MetadataBridge.exe --analyze-trace &lt;file.etl&gt; --out &lt;result.json&gt; [options]`
    ///
    /// Runs as its own short-lived process, started by the MCP server, so that an analysis taking
    /// minutes on a multi-GB capture never holds the long-running bridge or its request queue.
    /// It touches no D365FO assembly. Options:
    ///   --focus "A;B"      method-name substrings that select the threads to analyse
    ///   --pid N            only this process (e.g. Batch.exe)
    ///   --scope thread|subtree
    ///   --top N            rows per ranking (default 25)
    ///   --repeat N         executions from one caller that count as repeated SQL (default 50)
    ///   --progress file    JSON progress, rewritten every 250,000 events
    /// The result is written to --out atomically (temp file, then rename). On failure --out holds
    /// {"error": "..."} and the exit code is non-zero.
    /// </summary>
    public static class TraceAnalysisCommand
    {
        private static readonly JsonSerializerOptions Json = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            WriteIndented = false,
        };

        public static int Run(string[] args)
        {
            string? etl = null, output = null, progressFile = null;
            var options = new XppTraceOptions();
            try
            {
                for (int i = 0; i < args.Length; i++)
                {
                    string arg = args[i];
                    string Next() => i + 1 < args.Length ? args[++i] : throw new ArgumentException(arg + " needs a value.");
                    switch (arg)
                    {
                        case "--analyze-trace": etl = Next(); break;
                        case "--out": output = Next(); break;
                        case "--progress": progressFile = Next(); break;
                        case "--focus": options.Focus = Next().Split(';').Select(s => s.Trim()).Where(s => s.Length > 0).ToList(); break;
                        case "--pid": options.ProcessId = int.Parse(Next(), CultureInfo.InvariantCulture); break;
                        case "--scope":
                            string scope = Next();
                            if (scope != "thread" && scope != "subtree") throw new ArgumentException("--scope must be thread or subtree.");
                            options.SubtreeOnly = scope == "subtree";
                            break;
                        case "--top": options.Top = Math.Max(1, Math.Min(100, int.Parse(Next(), CultureInfo.InvariantCulture))); break;
                        case "--repeat": options.RepeatedSqlThreshold = Math.Max(2, int.Parse(Next(), CultureInfo.InvariantCulture)); break;
                        default: throw new ArgumentException("Unknown argument: " + arg);
                    }
                }
                if (string.IsNullOrWhiteSpace(etl) || string.IsNullOrWhiteSpace(output))
                    throw new ArgumentException("Usage: --analyze-trace <file.etl> --out <result.json> [--focus A;B] [--pid N] [--scope thread|subtree] [--top N] [--repeat N] [--progress file]");
                if (options.SubtreeOnly && options.Focus.Count == 0) throw new ArgumentException("--scope subtree needs --focus.");
                if (!File.Exists(etl)) throw new FileNotFoundException("Trace file not found: " + etl);
            }
            catch (Exception e) when (e is ArgumentException || e is FormatException || e is FileNotFoundException || e is OverflowException)
            {
                if (output != null) WriteAtomic(output, new { error = e.Message });
                Console.Error.WriteLine(e.Message);
                return 2;
            }

            var watch = Stopwatch.StartNew();
            try
            {
                var aggregator = new XppTraceAggregator(options);
                var stats = EtlTraceReader.Read(etl!, aggregator, read =>
                {
                    if (progressFile == null) return;
                    // Best effort: the server polls this file, and a replace that collides with its read
                    // (or an antivirus scan) must not end an analysis that may have run for minutes.
                    try { WriteAtomic(progressFile, new { eventsRead = read, elapsedSeconds = Math.Round(watch.Elapsed.TotalSeconds, 1) }); }
                    catch (IOException) { }
                    catch (UnauthorizedAccessException) { }
                });
                var result = aggregator.Build();
                result.File = Path.GetFullPath(etl!);
                result.FileBytes = new FileInfo(etl!).Length;
                result.EventsRead = stats.EventsRead;
                result.EventsUnreadable = stats.EventsUnreadable;
                result.AnalysisSeconds = Math.Round(watch.Elapsed.TotalSeconds, 1);
                if (stats.EventsUnreadable > 0)
                    result.Caveats.Add($"{stats.EventsUnreadable} events could not be rendered (provider manifest missing or event corrupt) and were skipped.");
                WriteAtomic(output!, result);
                return 0;
            }
            catch (Exception e)
            {
                WriteAtomic(output!, new { error = e.GetType().Name + ": " + e.Message });
                Console.Error.WriteLine(e);
                return 3;
            }
        }

        private static void WriteAtomic(string path, object value)
        {
            string full = Path.GetFullPath(path);
            string temp = full + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(value, Json));
            if (File.Exists(full)) File.Delete(full);
            File.Move(temp, full);
        }
    }
}
