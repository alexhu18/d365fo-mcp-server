using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;

namespace D365MetadataBridge.Services.Trace
{
    public enum XppTraceEventKind { Enter, Exit, Sql, Fetch, Bind }

    /// <summary>
    /// One event of a D365FO ETW capture, reduced to what the analysis needs. The reader maps
    /// Microsoft-Dynamics-AX-XppExecutionTraces 24500/24501 to Enter/Exit and
    /// Microsoft-Dynamics-AX-ExecutionTraces 4922/4924/4923 to Sql/Fetch/Bind. A Bind event's
    /// parameter VALUE is never carried here: it is customer data and is only counted.
    /// </summary>
    public sealed class XppTraceEvent
    {
        public XppTraceEventKind Kind { get; set; }
        public int ProcessId { get; set; }
        public int ThreadId { get; set; }
        /// <summary>UTC ticks (100 ns).</summary>
        public long Ticks { get; set; }
        /// <summary>X++ method (Enter/Exit only). In the SQL templates methodName is the C++ kernel, so it is not read.</summary>
        public string? Method { get; set; }
        public string? SqlStatement { get; set; }
        public double PreparationSeconds { get; set; }
        public double ExecutionSeconds { get; set; }
        public string? SessionId { get; set; }
        public string? UserGuid { get; set; }
    }

    public sealed class XppTraceOptions
    {
        /// <summary>Case-insensitive substrings of an X++ method name. A thread is analysed when it entered a matching method; empty = every thread with X++ activity.</summary>
        public IReadOnlyList<string> Focus { get; set; } = Array.Empty<string>();
        /// <summary>0 = any process.</summary>
        public int ProcessId { get; set; }
        /// <summary>Only count work done while a focus method is on the thread's stack (needs Focus).</summary>
        public bool SubtreeOnly { get; set; }
        public int Top { get; set; } = 25;
        public int RepeatedSqlThreshold { get; set; } = 50;
        public int StatementLength { get; set; } = 300;
    }

    /// <summary>
    /// Turns a stream of X++ enter/exit and SQL events into per-method and per-statement totals.
    ///
    /// Accuracy rules, each one stated in the result:
    /// - Frames pair per thread (process id + thread id) on a stack. An exception unwinding X++
    ///   methods still logs their exits, caught or not (measured on a dev VM, 7.0.7858.111). An
    ///   exit whose method is deeper in the stack (a lost event) closes the frames above it at
    ///   that exit's time (an upper bound) and counts them.
    /// - An exit with no matching frame belongs to a frame entered before the capture started: it
    ///   is counted and ignored, never guessed. Frames still open at the end are not added to the
    ///   totals; the longest ones are listed with their time so far (a lower bound).
    /// - Inclusive time is added for the outermost frame of a method only, so recursion is not
    ///   counted twice; exclusive time is inclusive minus the direct children.
    /// - A SQL statement is attributed to the X++ method on top of its thread's stack when the
    ///   AOS logs it (after execution: the method that issued it). Its time also rolls up into the
    ///   callers' inclusive SQL time.
    /// - Per-event ETW overhead inflates small, frequently called methods: rankings are reliable,
    ///   absolute seconds are not.
    /// </summary>
    public sealed class XppTraceAggregator
    {
        private sealed class Frame
        {
            public string Method = "";
            public long Start;
            public long ChildTicks;
            public double SqlSelf;
            public double SqlChildren;
            public bool InScope;
            public bool IsFocus;
        }

        private sealed class MethodStat
        {
            public long Calls;
            public long Closed;
            public long InclusiveTicks;
            public long ExclusiveTicks;
            public double SqlSelfSeconds;
            public double SqlInclusiveSeconds;
            public long SqlStatements;
        }

        private sealed class SqlStat
        {
            public long Count;
            public double Execution;
            public double Preparation;
            public double Max;
        }

        private sealed class ThreadState
        {
            public int ProcessId;
            public int ThreadId;
            public readonly Stack<Frame> Stack = new Stack<Frame>();
            public readonly Dictionary<string, int> OnStack = new Dictionary<string, int>(StringComparer.Ordinal);
            /// <summary>
            /// In-scope frames per method. Recursion is judged on these, not OnStack: in subtree scope a method
            /// can sit both above the focus (out of scope) and below it, and only the in-scope one is counted.
            /// </summary>
            public readonly Dictionary<string, int> OnStackInScope = new Dictionary<string, int>(StringComparer.Ordinal);
            public readonly Dictionary<string, MethodStat> Methods = new Dictionary<string, MethodStat>(StringComparer.Ordinal);
            public readonly Dictionary<string, SqlStat> Sql = new Dictionary<string, SqlStat>(StringComparer.Ordinal);
            public readonly Dictionary<string, SqlStat> Fetch = new Dictionary<string, SqlStat>(StringComparer.Ordinal);
            public readonly HashSet<string> Sessions = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            public readonly HashSet<string> Users = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            public long First = long.MaxValue, Last, Enters, Exits, SqlEvents, BindEvents;
            public long ExitsWithoutFrame, FramesClosedByOuterExit;
            public long FocusTicks;
            /// <summary>Time inside closed root frames: the thread running X++, not idling between calls.</summary>
            public long BusyTicks;
            /// <summary>SQL issued with no X++ frame on the stack, which BusyTicks cannot contain.</summary>
            public double SqlWithoutFrame;
            public int FocusDepth;
            public bool MatchedFocus;
            public readonly Dictionary<string, int> RootCounts = new Dictionary<string, int>(StringComparer.Ordinal);
            /// <summary>A BatchRun:: root was seen, even past the RootCounts cap.</summary>
            public bool SawBatchRun;
            /// <summary>Roots a focus method ran under, listed first in threads[].roots.</summary>
            public readonly HashSet<string> FocusRoots = new HashSet<string>(StringComparer.Ordinal);
        }

        private readonly XppTraceOptions options;
        private readonly Dictionary<long, ThreadState> threads = new Dictionary<long, ThreadState>();
        private long eventsSeen;

        public XppTraceAggregator(XppTraceOptions options) { this.options = options; }

        public void Add(XppTraceEvent e)
        {
            if (options.ProcessId != 0 && e.ProcessId != options.ProcessId) return;
            eventsSeen++;
            long key = ((long)e.ProcessId << 32) | (uint)e.ThreadId;
            if (!threads.TryGetValue(key, out var ts))
            {
                ts = new ThreadState { ProcessId = e.ProcessId, ThreadId = e.ThreadId };
                threads[key] = ts;
            }
            if (e.Ticks < ts.First) ts.First = e.Ticks;
            if (e.Ticks > ts.Last) ts.Last = e.Ticks;
            if (!string.IsNullOrEmpty(e.SessionId) && e.SessionId != "NULL" && ts.Sessions.Count < 16) ts.Sessions.Add(e.SessionId!);
            if (!string.IsNullOrEmpty(e.UserGuid) && ts.Users.Count < 16) ts.Users.Add(e.UserGuid!);

            switch (e.Kind)
            {
                case XppTraceEventKind.Enter: Enter(ts, e); break;
                case XppTraceEventKind.Exit: Exit(ts, e); break;
                case XppTraceEventKind.Sql: Sql(ts, e); break;
                case XppTraceEventKind.Fetch: Fetch(ts, e); break;
                case XppTraceEventKind.Bind: ts.BindEvents++; break;
            }
        }

        private bool IsFocus(string method)
        {
            foreach (var p in options.Focus)
                if (p.Length > 0 && method.IndexOf(p, StringComparison.OrdinalIgnoreCase) >= 0) return true;
            return false;
        }

        private static MethodStat Stat(Dictionary<string, MethodStat> map, string method)
        {
            if (!map.TryGetValue(method, out var s)) { s = new MethodStat(); map[method] = s; }
            return s;
        }

        private void Enter(ThreadState ts, XppTraceEvent e)
        {
            string m = e.Method ?? "?";
            ts.Enters++;
            if (ts.Stack.Count == 0)
            {
                // Capped by distinct roots, not by calls: a root already counted keeps counting.
                if (ts.RootCounts.TryGetValue(m, out var rc)) ts.RootCounts[m] = rc + 1;
                else if (ts.RootCounts.Count < 64) ts.RootCounts[m] = 1;
                if (m.StartsWith("BatchRun::", StringComparison.Ordinal)) ts.SawBatchRun = true;
            }
            bool focus = options.Focus.Count > 0 && IsFocus(m);
            if (focus) { ts.MatchedFocus = true; ts.FocusDepth++; }
            var frame = new Frame { Method = m, Start = e.Ticks, IsFocus = focus, InScope = !options.SubtreeOnly || ts.FocusDepth > 0 };
            ts.Stack.Push(frame);
            if (focus && ts.FocusRoots.Count < 8) ts.FocusRoots.Add(ts.Stack.Last().Method); // Last() is the bottom
            ts.OnStack[m] = ts.OnStack.TryGetValue(m, out var d) ? d + 1 : 1;
            if (frame.InScope)
            {
                Stat(ts.Methods, m).Calls++;
                ts.OnStackInScope[m] = ts.OnStackInScope.TryGetValue(m, out var di) ? di + 1 : 1;
            }
        }

        private void Exit(ThreadState ts, XppTraceEvent e)
        {
            string m = e.Method ?? "?";
            ts.Exits++;
            if (!ts.OnStack.TryGetValue(m, out var depth) || depth == 0) { ts.ExitsWithoutFrame++; return; }
            while (ts.Stack.Count > 0)
            {
                var f = ts.Stack.Pop();
                Close(ts, f, e.Ticks);
                if (f.Method == m) return;
                ts.FramesClosedByOuterExit++;
            }
        }

        private void Close(ThreadState ts, Frame f, long at)
        {
            long inclusive = Math.Max(0, at - f.Start);
            ts.OnStack[f.Method]--;
            if (f.InScope)
            {
                int left = --ts.OnStackInScope[f.Method];
                var s = Stat(ts.Methods, f.Method);
                s.Closed++;
                s.ExclusiveTicks += Math.Max(0, inclusive - f.ChildTicks);
                s.SqlSelfSeconds += f.SqlSelf;
                if (left == 0)
                {
                    s.InclusiveTicks += inclusive;
                    s.SqlInclusiveSeconds += f.SqlSelf + f.SqlChildren;
                }
            }
            if (f.IsFocus)
            {
                ts.FocusDepth--;
                if (ts.FocusDepth == 0) ts.FocusTicks += inclusive;
            }
            if (ts.Stack.Count > 0)
            {
                var parent = ts.Stack.Peek();
                parent.ChildTicks += inclusive;
                parent.SqlChildren += f.SqlSelf + f.SqlChildren;
            }
            else
            {
                // A root frame is the thread working, in either scope: in subtree scope the root is
                // usually above the focus (out of scope), and skipping it reported busySeconds = 0.
                ts.BusyTicks += inclusive;
            }
        }

        private bool SqlInScope(ThreadState ts) => !options.SubtreeOnly || ts.FocusDepth > 0;

        private static readonly Regex TempTable = new Regex(@"(tempdb\.""?dbo""?\.""?)(t\d+)[\w-]*", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

        /// <summary>
        /// The grouping key of a statement: the WHOLE statement, whitespace collapsed. It is never
        /// truncated: the kernel lists every column (SELECT T1.A,T1.B,… FROM …), so on a wide table
        /// FROM and WHERE start well past any display length, and a key cut there would merge
        /// every query on that table into one row (and flag them as one repeated statement).
        /// </summary>
        private static string Normalize(string? statement)
        {
            if (string.IsNullOrEmpty(statement)) return "";
            var collapsed = string.Join(" ", statement!.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
            // A temp table's name carries the session that made it (t18093Batch<machine>_<pid>_<guid>),
            // which would split one statement into one row per session: keep the table id only.
            return TempTable.Replace(collapsed, "$1$2_*");
        }

        /// <summary>
        /// The statement as shown, at most StatementLength characters (plus the ellipsis). When FROM lies
        /// beyond that, the head of the column list is kept short and the rest shows FROM … WHERE, which
        /// names the table and the filter: the part that tells two statements apart.
        /// </summary>
        internal string Display(string statement)
        {
            int limit = Math.Max(20, options.StatementLength);
            if (statement.Length <= limit) return statement;
            int from = statement.IndexOf(" FROM ", StringComparison.OrdinalIgnoreCase);
            if (from < 0 || from + 6 <= limit) return statement.Substring(0, limit) + "…";
            const string gap = " … ";
            int head = Math.Min(from, limit / 4);
            string tail = statement.Substring(from + 1);
            int room = limit - head - gap.Length;
            return statement.Substring(0, head) + gap + (tail.Length > room ? tail.Substring(0, room) + "…" : tail);
        }

        private void Sql(ThreadState ts, XppTraceEvent e)
        {
            ts.SqlEvents++;
            if (!SqlInScope(ts)) return;
            double seconds = Math.Max(0, e.ExecutionSeconds) + Math.Max(0, e.PreparationSeconds);
            string caller = ts.Stack.Count > 0 ? ts.Stack.Peek().Method : NoFrame;
            if (ts.Stack.Count > 0) ts.Stack.Peek().SqlSelf += seconds;
            else ts.SqlWithoutFrame += seconds;
            Stat(ts.Methods, caller).SqlStatements++;
            string key = caller + "\u0001" + Normalize(e.SqlStatement);
            if (!ts.Sql.TryGetValue(key, out var s)) { s = new SqlStat(); ts.Sql[key] = s; }
            s.Count++;
            s.Execution += Math.Max(0, e.ExecutionSeconds);
            s.Preparation += Math.Max(0, e.PreparationSeconds);
            if (seconds > s.Max) s.Max = seconds;
        }

        private void Fetch(ThreadState ts, XppTraceEvent e)
        {
            if (!SqlInScope(ts)) return;
            string caller = ts.Stack.Count > 0 ? ts.Stack.Peek().Method : NoFrame;
            if (!ts.Fetch.TryGetValue(caller, out var s)) { s = new SqlStat(); ts.Fetch[caller] = s; }
            s.Count++;
            s.Execution += Math.Max(0, e.ExecutionSeconds);
            if (e.ExecutionSeconds > s.Max) s.Max = e.ExecutionSeconds;
        }

        public const string NoFrame = "(no X++ frame on the thread)";

        public XppTraceResult Build()
        {
            var all = threads.Values.Where(t => t.Enters > 0 || t.SqlEvents > 0).ToList();
            var selected = options.Focus.Count > 0 ? all.Where(t => t.MatchedFocus).ToList() : all.Where(t => t.Enters > 0).ToList();
            var result = new XppTraceResult
            {
                EventsAnalysed = eventsSeen,
                ThreadsWithActivity = all.Count,
                ThreadsSelected = selected.Count,
                Options = new XppTraceResultOptions
                {
                    Focus = options.Focus.ToList(), ProcessId = options.ProcessId, Scope = options.SubtreeOnly ? "subtree" : "thread",
                    Top = options.Top, RepeatedSqlThreshold = options.RepeatedSqlThreshold,
                },
            };
            result.Threads = (selected.Count > 0 ? selected : all)
                .OrderByDescending(t => t.Enters).Take(20)
                .Select(t => new XppTraceThread
                {
                    ProcessId = t.ProcessId, ThreadId = t.ThreadId, Selected = selected.Contains(t),
                    XppEnters = t.Enters, SqlStatements = t.SqlEvents, SpanSeconds = Seconds(t.Last - t.First),
                    Roots = t.FocusRoots.OrderByDescending(r => t.RootCounts.TryGetValue(r, out var c) ? c : 0)
                        .Concat(t.RootCounts.Where(r => !t.FocusRoots.Contains(r.Key)).OrderByDescending(r => r.Value).Select(r => r.Key))
                        .Take(3).ToList(),
                    Sessions = t.Sessions.Take(3).ToList(), Users = t.Users.Take(3).ToList(),
                }).ToList();
            if (selected.Count == 0)
            {
                result.Caveats.Add(options.Focus.Count > 0
                    ? "No thread entered a method matching the focus. Check the names in threads[].roots, or capture while the process runs."
                    : "No X++ method events in the capture: was Microsoft-Dynamics-AX-XppExecutionTraces enabled?");
                return result;
            }

            var methods = new Dictionary<string, MethodStat>(StringComparer.Ordinal);
            var sql = new Dictionary<string, SqlStat>(StringComparer.Ordinal);
            var fetch = new Dictionary<string, SqlStat>(StringComparer.Ordinal);
            var open = new Dictionary<string, (int Count, long Max)>(StringComparer.Ordinal);
            long first = long.MaxValue, last = 0, threadTicks = 0, focusTicks = 0, busyTicks = 0;
            double sqlWithoutFrame = 0;
            foreach (var t in selected)
            {
                first = Math.Min(first, t.First);
                last = Math.Max(last, t.Last);
                threadTicks += t.Last - t.First;
                focusTicks += t.FocusTicks;
                busyTicks += t.BusyTicks;
                sqlWithoutFrame += t.SqlWithoutFrame;
                // A root frame still open at the end was busy until the thread's last event.
                if (t.Stack.Count > 0) busyTicks += Math.Max(0, t.Last - t.Stack.Last().Start);
                // Likewise an outermost focus frame still open: its SQL is in the numerator, so its time
                // so far belongs in the denominator, or the share can exceed 1.
                var openFocus = t.Stack.LastOrDefault(f => f.IsFocus);
                if (openFocus != null) focusTicks += Math.Max(0, t.Last - openFocus.Start);
                result.Pairing.Enters += t.Enters;
                result.Pairing.Exits += t.Exits;
                result.Pairing.ExitsWithoutFrame += t.ExitsWithoutFrame;
                result.Pairing.FramesClosedByOuterExit += t.FramesClosedByOuterExit;
                result.Pairing.FramesOpenAtEnd += t.Stack.Count;
                result.SqlBindEventsCounted += t.BindEvents;
                foreach (var kv in t.Methods)
                {
                    var a = Stat(methods, kv.Key);
                    a.Calls += kv.Value.Calls; a.Closed += kv.Value.Closed;
                    a.InclusiveTicks += kv.Value.InclusiveTicks; a.ExclusiveTicks += kv.Value.ExclusiveTicks;
                    a.SqlSelfSeconds += kv.Value.SqlSelfSeconds; a.SqlInclusiveSeconds += kv.Value.SqlInclusiveSeconds;
                    a.SqlStatements += kv.Value.SqlStatements;
                }
                Merge(sql, t.Sql);
                Merge(fetch, t.Fetch);
                foreach (var f in t.Stack)
                {
                    long so = t.Last - f.Start;
                    open[f.Method] = open.TryGetValue(f.Method, out var o) ? (o.Count + 1, Math.Max(o.Max, so)) : (1, so);
                }
            }

            double sqlExecution = sql.Values.Sum(s => s.Execution), sqlPreparation = sql.Values.Sum(s => s.Preparation);
            double rowFetch = fetch.Values.Sum(s => s.Execution);
            result.Span = new XppTraceSpan { FirstUtc = new DateTime(first, DateTimeKind.Utc), LastUtc = new DateTime(last, DateTimeKind.Utc), WallSeconds = Seconds(last - first) };
            // Not the threads' spans: a pool thread idle for most of the capture would dilute the share
            // (two batch threads, one idle: 10.6% of the spans against 23.9% of the time doing work).
            double busySeconds = busyTicks / 1e7 + sqlWithoutFrame;
            double denominator = options.SubtreeOnly ? focusTicks / 1e7 : busySeconds;
            result.Totals = new XppTraceTotals
            {
                ThreadSeconds = Seconds(threadTicks),
                BusySeconds = Round(busySeconds),
                FocusSeconds = options.Focus.Count > 0 ? Seconds(focusTicks) : (double?)null,
                SqlExecutionSeconds = Round(sqlExecution), SqlPreparationSeconds = Round(sqlPreparation), RowFetchSeconds = Round(rowFetch),
                SqlStatements = sql.Values.Sum(s => s.Count),
                SqlShareOfTime = denominator > 0 ? Round((sqlExecution + sqlPreparation) / denominator) : (double?)null,
                RowFetchShareOfTime = denominator > 0 ? Round(rowFetch / denominator) : (double?)null,
                ShareBasis = options.SubtreeOnly
                    ? "time inside focus frames (one still open at the end counts until the thread's last event)"
                    : "busySeconds: time the selected threads spent inside X++ root frames, plus SQL issued outside any frame; idle gaps excluded",
            };

            int top = Math.Max(1, options.Top);
            Func<KeyValuePair<string, MethodStat>, XppTraceMethod> toMethod = kv => new XppTraceMethod
            {
                Method = kv.Key, Calls = kv.Value.Calls, ClosedCalls = kv.Value.Closed,
                ExclusiveSeconds = Seconds(kv.Value.ExclusiveTicks), InclusiveSeconds = Seconds(kv.Value.InclusiveTicks),
                SqlSelfSeconds = Round(kv.Value.SqlSelfSeconds), SqlInclusiveSeconds = Round(kv.Value.SqlInclusiveSeconds),
                SqlStatements = kv.Value.SqlStatements,
            };
            var named = methods.Where(kv => kv.Key != NoFrame).ToList();
            result.TopExclusive = named.OrderByDescending(kv => kv.Value.ExclusiveTicks).Take(top).Select(toMethod).ToList();
            result.TopInclusive = named.OrderByDescending(kv => kv.Value.InclusiveTicks).Take(top).Select(toMethod).ToList();
            result.TopCalls = named.OrderByDescending(kv => kv.Value.Calls).Take(top).Select(toMethod).ToList();

            var byStatement = new Dictionary<string, (SqlStat Total, Dictionary<string, SqlStat> Callers)>(StringComparer.Ordinal);
            foreach (var kv in sql)
            {
                int split = kv.Key.IndexOf('\u0001');
                string caller = kv.Key.Substring(0, split), statement = kv.Key.Substring(split + 1);
                if (!byStatement.TryGetValue(statement, out var entry)) { entry = (new SqlStat(), new Dictionary<string, SqlStat>(StringComparer.Ordinal)); byStatement[statement] = entry; }
                entry.Total.Count += kv.Value.Count; entry.Total.Execution += kv.Value.Execution; entry.Total.Preparation += kv.Value.Preparation;
                entry.Total.Max = Math.Max(entry.Total.Max, kv.Value.Max);
                if (!entry.Callers.TryGetValue(caller, out var c)) { c = new SqlStat(); entry.Callers[caller] = c; }
                c.Count += kv.Value.Count; c.Execution += kv.Value.Execution; c.Preparation += kv.Value.Preparation;
            }
            Func<KeyValuePair<string, (SqlStat Total, Dictionary<string, SqlStat> Callers)>, XppTraceStatement> toStatement = kv => new XppTraceStatement
            {
                Statement = Display(kv.Key), Executions = kv.Value.Total.Count,
                TotalSeconds = Round(kv.Value.Total.Execution + kv.Value.Total.Preparation),
                ExecutionSeconds = Round(kv.Value.Total.Execution), PreparationSeconds = Round(kv.Value.Total.Preparation),
                MaxSeconds = Round(kv.Value.Total.Max),
                Callers = kv.Value.Callers.OrderByDescending(c => c.Value.Execution + c.Value.Preparation).ThenByDescending(c => c.Value.Count).Take(3)
                    .Select(c => new XppTraceCaller { Method = c.Key, Executions = c.Value.Count, Seconds = Round(c.Value.Execution + c.Value.Preparation) }).ToList(),
            };
            result.TopSqlByTime = byStatement.OrderByDescending(kv => kv.Value.Total.Execution + kv.Value.Total.Preparation).Take(Math.Min(top, 20)).Select(toStatement).ToList();
            result.TopSqlByCount = byStatement.OrderByDescending(kv => kv.Value.Total.Count).Take(Math.Min(top, 20)).Select(toStatement).ToList();
            result.RepeatedSql = sql.Where(kv => kv.Value.Count >= options.RepeatedSqlThreshold)
                .OrderByDescending(kv => kv.Value.Count).Take(Math.Min(top, 20))
                .Select(kv =>
                {
                    int split = kv.Key.IndexOf('\u0001');
                    return new XppTraceRepeated
                    {
                        Caller = kv.Key.Substring(0, split), Statement = Display(kv.Key.Substring(split + 1)), Executions = kv.Value.Count,
                        TotalSeconds = Round(kv.Value.Execution + kv.Value.Preparation),
                    };
                }).ToList();
            result.TopRowFetch = fetch.OrderByDescending(kv => kv.Value.Execution).Take(10)
                .Select(kv => new XppTraceCaller { Method = kv.Key, Executions = kv.Value.Count, Seconds = Round(kv.Value.Execution) }).ToList();
            result.OpenAtEnd = open.OrderByDescending(kv => kv.Value.Max).Take(10)
                .Select(kv => new XppTraceOpenFrame { Method = kv.Key, Frames = kv.Value.Count, OpenForAtLeastSeconds = Seconds(kv.Value.Max) }).ToList();

            result.Caveats.Add("ETW adds a cost to every X++ method event, which inflates small, frequently called methods: compare rankings, not absolute seconds, and measure the untraced run for the real duration.");
            if (result.Pairing.ExitsWithoutFrame > 0)
                result.Caveats.Add($"{result.Pairing.ExitsWithoutFrame} exits had no frame in the capture (entered before it started); those frames' time is not counted.");
            if (result.Pairing.FramesOpenAtEnd > 0)
                result.Caveats.Add($"{result.Pairing.FramesOpenAtEnd} frames were still open at the end; they are not in the totals, see openAtEnd for their time so far.");
            if (result.Pairing.FramesClosedByOuterExit > 0)
                result.Caveats.Add($"{result.Pairing.FramesClosedByOuterExit} frames had no exit of their own and were closed by an outer method's exit (a lost event); their time is an upper bound.");
            if (options.Focus.Count > 0 && methods.Keys.Any(m => m == "Batch::insert" || m == "BatchHeader::save")
                && !selected.Any(t => t.SawBatchRun))
                result.Caveats.Add("The focus threads scheduled batch tasks (Batch::insert / BatchHeader::save) and none was seen running under BatchRun::. If this is the dialog or controller (a short thread in the web process), the work runs later in Batch.exe: analyse again with focus on the task's class and pid set to Batch.exe, whose threads[].roots start with BatchRun:: when the task began inside the capture.");
            if (options.SubtreeOnly && selected.All(t => t.FocusTicks == 0))
                result.Caveats.Add("Subtree scope counted nothing closed: the focus method may have started before the capture. Use thread scope for a window taken mid-run.");
            return result;
        }

        private static void Merge(Dictionary<string, SqlStat> into, Dictionary<string, SqlStat> from)
        {
            foreach (var kv in from)
            {
                if (!into.TryGetValue(kv.Key, out var a)) { a = new SqlStat(); into[kv.Key] = a; }
                a.Count += kv.Value.Count; a.Execution += kv.Value.Execution; a.Preparation += kv.Value.Preparation; a.Max = Math.Max(a.Max, kv.Value.Max);
            }
        }

        private static double Seconds(long ticks) => Round(ticks / 1e7);
        private static double Round(double value) => Math.Round(value, 4);
    }

    public sealed class XppTraceResult
    {
        public int Version { get; set; } = 1;
        public string? File { get; set; }
        public long? FileBytes { get; set; }
        public double? AnalysisSeconds { get; set; }
        public long EventsRead { get; set; }
        public long EventsAnalysed { get; set; }
        public long EventsUnreadable { get; set; }
        public XppTraceResultOptions Options { get; set; } = new XppTraceResultOptions();
        public int ThreadsWithActivity { get; set; }
        public int ThreadsSelected { get; set; }
        public List<XppTraceThread> Threads { get; set; } = new List<XppTraceThread>();
        public XppTraceSpan? Span { get; set; }
        public XppTraceTotals? Totals { get; set; }
        public XppTracePairing Pairing { get; set; } = new XppTracePairing();
        public long SqlBindEventsCounted { get; set; }
        public List<XppTraceMethod> TopExclusive { get; set; } = new List<XppTraceMethod>();
        public List<XppTraceMethod> TopInclusive { get; set; } = new List<XppTraceMethod>();
        public List<XppTraceMethod> TopCalls { get; set; } = new List<XppTraceMethod>();
        public List<XppTraceStatement> TopSqlByTime { get; set; } = new List<XppTraceStatement>();
        public List<XppTraceStatement> TopSqlByCount { get; set; } = new List<XppTraceStatement>();
        public List<XppTraceRepeated> RepeatedSql { get; set; } = new List<XppTraceRepeated>();
        public List<XppTraceCaller> TopRowFetch { get; set; } = new List<XppTraceCaller>();
        public List<XppTraceOpenFrame> OpenAtEnd { get; set; } = new List<XppTraceOpenFrame>();
        public List<string> Caveats { get; set; } = new List<string>();
    }

    public sealed class XppTraceResultOptions
    {
        public List<string> Focus { get; set; } = new List<string>();
        public int ProcessId { get; set; }
        public string Scope { get; set; } = "thread";
        public int Top { get; set; }
        public int RepeatedSqlThreshold { get; set; }
    }

    public sealed class XppTraceThread
    {
        public int ProcessId { get; set; }
        public int ThreadId { get; set; }
        public bool Selected { get; set; }
        public long XppEnters { get; set; }
        public long SqlStatements { get; set; }
        public double SpanSeconds { get; set; }
        public List<string> Roots { get; set; } = new List<string>();
        public List<string> Sessions { get; set; } = new List<string>();
        public List<string> Users { get; set; } = new List<string>();
    }

    public sealed class XppTraceSpan
    {
        public DateTime FirstUtc { get; set; }
        public DateTime LastUtc { get; set; }
        public double WallSeconds { get; set; }
    }

    public sealed class XppTraceTotals
    {
        public double ThreadSeconds { get; set; }
        public double BusySeconds { get; set; }
        public double? FocusSeconds { get; set; }
        public double SqlExecutionSeconds { get; set; }
        public double SqlPreparationSeconds { get; set; }
        public double RowFetchSeconds { get; set; }
        public long SqlStatements { get; set; }
        public double? SqlShareOfTime { get; set; }
        public double? RowFetchShareOfTime { get; set; }
        public string ShareBasis { get; set; } = "";
    }

    public sealed class XppTracePairing
    {
        public long Enters { get; set; }
        public long Exits { get; set; }
        public long ExitsWithoutFrame { get; set; }
        public long FramesClosedByOuterExit { get; set; }
        public long FramesOpenAtEnd { get; set; }
    }

    public sealed class XppTraceMethod
    {
        public string Method { get; set; } = "";
        public long Calls { get; set; }
        public long ClosedCalls { get; set; }
        public double ExclusiveSeconds { get; set; }
        public double InclusiveSeconds { get; set; }
        public double SqlSelfSeconds { get; set; }
        public double SqlInclusiveSeconds { get; set; }
        public long SqlStatements { get; set; }
    }

    public sealed class XppTraceStatement
    {
        public string Statement { get; set; } = "";
        public long Executions { get; set; }
        public double TotalSeconds { get; set; }
        public double ExecutionSeconds { get; set; }
        public double PreparationSeconds { get; set; }
        public double MaxSeconds { get; set; }
        public List<XppTraceCaller> Callers { get; set; } = new List<XppTraceCaller>();
    }

    public sealed class XppTraceCaller
    {
        public string Method { get; set; } = "";
        public long Executions { get; set; }
        public double? Seconds { get; set; }
    }

    public sealed class XppTraceRepeated
    {
        public string Caller { get; set; } = "";
        public string Statement { get; set; } = "";
        public long Executions { get; set; }
        public double TotalSeconds { get; set; }
    }

    public sealed class XppTraceOpenFrame
    {
        public string Method { get; set; } = "";
        public int Frames { get; set; }
        public double OpenForAtLeastSeconds { get; set; }
    }
}
