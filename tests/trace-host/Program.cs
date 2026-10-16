using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using D365MetadataBridge.Services.Trace;

// Offline checks for the ETW trace aggregation: synthetic event streams with known answers.
// Run: dotnet build tests/trace-host/TraceHost.csproj, then tests/trace-host/bin/Debug/net48/TraceHost.exe
// Optional: TraceHost.exe --etl <file.etl> [--focus A;B] [--pid N] reads a real capture and prints the JSON result.
internal static class Program
{
    private static int failures;

    private static int Main(string[] args)
    {
        if (args.Length >= 2 && args[0] == "--etl") return RunReal(args);

        Nested();
        Recursion();
        UnwoundByOuterExit();
        ExitWithoutFrame();
        OpenAtEnd();
        SqlAttributionAndRollUp();
        RepeatedSql();
        FocusSelectsThreads();
        FocusRootsListedFirst();
        SubtreeScope();
        SubtreeMethodAboveAndBelowFocus();
        SubtreeOpenFocusInShare();
        ProcessFilter();
        StatementNormalisation();
        WideStatementsKeptApart();
        SubtreeBusyTime();
        BindIsCountedOnly();
        ShareUsesBusyTime();
        TempTablesNormalised();
        BatchDispatcherCaveat();
        RootsCountedPastTheCap();
        ResultSerialises();

        Console.WriteLine(failures == 0 ? "PASS: trace aggregation" : "FAIL: " + failures + " check(s)");
        return failures == 0 ? 0 : 1;
    }

    // ── helpers ─────────────────────────────────────────────────────────────
    private static long T(double seconds) => (long)Math.Round(seconds * 1e7);
    private static XppTraceEvent Enter(double s, string m, int tid = 1, int pid = 100) => new XppTraceEvent { Kind = XppTraceEventKind.Enter, Ticks = T(s), Method = m, ThreadId = tid, ProcessId = pid };
    private static XppTraceEvent Exit(double s, string m, int tid = 1, int pid = 100) => new XppTraceEvent { Kind = XppTraceEventKind.Exit, Ticks = T(s), Method = m, ThreadId = tid, ProcessId = pid };
    private static XppTraceEvent Sql(double s, string stmt, double exec, double prep = 0, int tid = 1, int pid = 100) => new XppTraceEvent { Kind = XppTraceEventKind.Sql, Ticks = T(s), SqlStatement = stmt, ExecutionSeconds = exec, PreparationSeconds = prep, ThreadId = tid, ProcessId = pid };

    private static XppTraceResult Run(IEnumerable<XppTraceEvent> events, XppTraceOptions? options = null)
    {
        var a = new XppTraceAggregator(options ?? new XppTraceOptions());
        foreach (var e in events) a.Add(e);
        return a.Build();
    }

    private static XppTraceMethod M(XppTraceResult r, string method) =>
        r.TopInclusive.Concat(r.TopExclusive).Concat(r.TopCalls).FirstOrDefault(x => x.Method == method)
        ?? throw new Exception("method not in result: " + method);

    private static void Check(bool ok, string what)
    {
        if (ok) return;
        failures++;
        Console.Error.WriteLine("FAIL: " + what);
    }

    private static void Near(double actual, double expected, string what) => Check(Math.Abs(actual - expected) < 1e-6, what + " expected " + expected + " got " + actual);

    // ── cases ───────────────────────────────────────────────────────────────
    private static void Nested()
    {
        var r = Run(new[] { Enter(0, "A"), Enter(1, "B"), Exit(3, "B"), Exit(10, "A") });
        Near(M(r, "A").InclusiveSeconds, 10, "nested: A inclusive");
        Near(M(r, "A").ExclusiveSeconds, 8, "nested: A exclusive = inclusive minus child");
        Near(M(r, "B").InclusiveSeconds, 2, "nested: B inclusive");
        Near(M(r, "B").ExclusiveSeconds, 2, "nested: B exclusive");
        Check(M(r, "A").Calls == 1 && M(r, "B").Calls == 1, "nested: one call each");
        Check(r.Pairing.FramesOpenAtEnd == 0 && r.Pairing.ExitsWithoutFrame == 0 && r.Pairing.FramesClosedByOuterExit == 0, "nested: clean pairing");
    }

    private static void Recursion()
    {
        // A calls itself: the outer frame alone carries the inclusive time, both carry exclusive.
        var r = Run(new[] { Enter(0, "A"), Enter(1, "A"), Exit(4, "A"), Exit(10, "A") });
        Near(M(r, "A").InclusiveSeconds, 10, "recursion: inclusive counted once (outermost)");
        Near(M(r, "A").ExclusiveSeconds, 10, "recursion: exclusive 3 (inner) + 7 (outer)");
        Check(M(r, "A").Calls == 2, "recursion: two calls");
    }

    private static void UnwoundByOuterExit()
    {
        // B and C never log an exit (an exception unwinding): A's exit closes them at its own time.
        var r = Run(new[] { Enter(0, "A"), Enter(1, "B"), Enter(2, "C"), Exit(10, "A") });
        Check(r.Pairing.FramesClosedByOuterExit == 2, "unwind: two frames closed by the outer exit");
        Near(M(r, "C").InclusiveSeconds, 8, "unwind: C closed at A's exit");
        Near(M(r, "B").ExclusiveSeconds, 1, "unwind: B exclusive = 9 - 8");
        Near(M(r, "A").ExclusiveSeconds, 1, "unwind: A exclusive = 10 - 9");
        Check(r.Caveats.Any(c => c.Contains("upper bound")), "unwind: caveat stated");
    }

    private static void ExitWithoutFrame()
    {
        // Entered before the capture started: counted, never guessed.
        var r = Run(new[] { Enter(0, "A"), Exit(1, "A"), Exit(2, "Before") });
        Check(r.Pairing.ExitsWithoutFrame == 1, "pre-window exit counted");
        Check(!r.TopInclusive.Any(x => x.Method == "Before"), "pre-window frame not invented");
        Check(r.Caveats.Any(c => c.Contains("entered before")), "pre-window caveat stated");
    }

    private static void OpenAtEnd()
    {
        var r = Run(new[] { Enter(0, "Outer"), Enter(1, "B"), Exit(2, "B"), Sql(5, "SELECT 1", 0.1) });
        Check(r.Pairing.FramesOpenAtEnd == 1, "open frame counted");
        Check(r.OpenAtEnd.Count == 1 && r.OpenAtEnd[0].Method == "Outer", "open frame listed");
        Near(r.OpenAtEnd[0].OpenForAtLeastSeconds, 5, "open frame time so far (lower bound)");
        Near(r.TopInclusive.FirstOrDefault(x => x.Method == "Outer")?.InclusiveSeconds ?? 0, 0, "open frame not in inclusive totals");
        Check(M(r, "Outer").Calls == 1, "open frame's call is counted");
    }

    private static void SqlAttributionAndRollUp()
    {
        var r = Run(new[] { Enter(0, "A"), Enter(1, "B"), Sql(2, "SELECT X FROM T", 0.5, 0.1), Exit(3, "B"), Exit(4, "A") });
        Near(M(r, "B").SqlSelfSeconds, 0.6, "sql: issued by B");
        Near(M(r, "B").SqlInclusiveSeconds, 0.6, "sql: B inclusive");
        Near(M(r, "A").SqlSelfSeconds, 0, "sql: not A's own");
        Near(M(r, "A").SqlInclusiveSeconds, 0.6, "sql: rolls up into A");
        Check(r.TopSqlByTime.Count == 1 && r.TopSqlByTime[0].Callers[0].Method == "B", "sql: caller is the top of the stack");
        Near(r.TopSqlByTime[0].ExecutionSeconds, 0.5, "sql: execution seconds");
        Near(r.TopSqlByTime[0].PreparationSeconds, 0.1, "sql: preparation seconds");
        Near(r.TopSqlByTime[0].Callers[0].Seconds ?? -1, 0.6, "sql: caller carries its seconds");
    }

    private static void RepeatedSql()
    {
        var events = new List<XppTraceEvent> { Enter(0, "Loop") };
        for (int i = 0; i < 60; i++) events.Add(Sql(0.01 * (i + 1), "SELECT * FROM T WHERE ID=?", 0.001));
        for (int i = 0; i < 49; i++) events.Add(Sql(1 + 0.01 * i, "SELECT * FROM U WHERE ID=?", 0.001));
        events.Add(Exit(2, "Loop"));
        var r = Run(events);
        Check(r.RepeatedSql.Count == 1 && r.RepeatedSql[0].Executions == 60 && r.RepeatedSql[0].Caller == "Loop", "repeated: 60 from one caller listed, 49 not");
    }

    private static void FocusSelectsThreads()
    {
        var r = Run(new[]
        {
            Enter(0, "Web::render", tid: 1), Exit(1, "Web::render", tid: 1),
            Enter(0, "BatchRun::run", tid: 2), Enter(1, "BOMCalcJob_All::run", tid: 2), Exit(3, "BOMCalcJob_All::run", tid: 2), Exit(4, "BatchRun::run", tid: 2),
        }, new XppTraceOptions { Focus = new[] { "bomcalc" } });
        Check(r.ThreadsSelected == 1 && r.ThreadsWithActivity == 2, "focus: one of two threads selected (case-insensitive)");
        Check(!r.TopInclusive.Any(x => x.Method == "Web::render"), "focus: other thread excluded");
        Check(r.TopInclusive.Any(x => x.Method == "BatchRun::run"), "focus: whole selected thread kept in thread scope");
        Near(r.Totals!.FocusSeconds ?? -1, 2, "focus: time inside closed focus frames");
    }

    private static void FocusRootsListedFirst()
    {
        // A web thread runs many other requests; the one root the focus ran under comes first.
        var events = new List<XppTraceEvent>();
        double s = 0;
        foreach (var root in new[] { "Menu::a", "Menu::a", "Menu::a", "Menu::b", "Menu::b", "Form::notify", "Form::notify" })
        {
            events.Add(Enter(s, root)); events.Add(Exit(s + 0.5, root)); s += 1;
        }
        events.Add(Enter(s, "SysClassRunner::main")); events.Add(Enter(s + 0.1, "MyTest::main"));
        events.Add(Exit(s + 0.2, "MyTest::main")); events.Add(Exit(s + 0.3, "SysClassRunner::main"));
        var r = Run(events, new XppTraceOptions { Focus = new[] { "MyTest" } });
        var roots = r.Threads.Single().Roots;
        Check(roots.Count == 3 && roots[0] == "SysClassRunner::main", "focus roots: the root the focus ran under is listed first, got " + string.Join(", ", roots));
        Check(roots[1] == "Menu::a", "focus roots: then the most frequent other roots");
    }

    private static void SubtreeScope()
    {
        var r = Run(new[]
        {
            Enter(0, "BatchRun::run"), Enter(1, "BOMCalcJob_All::run"), Enter(2, "X"), Sql(2.5, "SELECT IN", 0.2), Exit(3, "X"), Exit(4, "BOMCalcJob_All::run"),
            Enter(5, "Y"), Sql(5.5, "SELECT OUT", 0.3), Exit(6, "Y"), Exit(7, "BatchRun::run"),
        }, new XppTraceOptions { Focus = new[] { "BOMCalcJob_All" }, SubtreeOnly = true });
        Check(r.TopInclusive.Any(x => x.Method == "X"), "subtree: work inside focus counted");
        Check(!r.TopInclusive.Any(x => x.Method == "Y" || x.Method == "BatchRun::run"), "subtree: work outside focus excluded");
        Check(r.TopSqlByTime.Count == 1 && r.TopSqlByTime[0].Statement == "SELECT IN", "subtree: only SQL inside focus");
        Near(r.Totals!.SqlShareOfTime ?? -1, Math.Round(0.2 / 3, 4), "subtree: share over time inside focus (rounded to 4 places)");
    }

    private static void SubtreeMethodAboveAndBelowFocus()
    {
        // A dispatcher on both sides of the focus: only the inner call is in scope, and it is the outermost
        // in-scope frame of A, so its inclusive time counts although an (out-of-scope) A is still below it.
        var r = Run(new[]
        {
            Enter(0, "A"), Enter(1, "F"), Enter(2, "A"), Sql(2.5, "SELECT IN", 0.4), Exit(4, "A"), Exit(5, "F"), Exit(6, "A"),
        }, new XppTraceOptions { Focus = new[] { "F" }, SubtreeOnly = true });
        var a = M(r, "A");
        Check(a.Calls == 1 && a.ClosedCalls == 1, "subtree: only the in-scope call of A counted");
        Near(a.InclusiveSeconds, 2, "subtree: inner A's inclusive time counted despite the outer A");
        Near(a.SqlInclusiveSeconds, 0.4, "subtree: inner A's inclusive SQL counted despite the outer A");
    }

    private static void SubtreeOpenFocusInShare()
    {
        // The second F is still open at the end, and its SQL is in the numerator: its time so far must be in
        // the denominator too, or the share exceeds 1 (5.5 / 1 before).
        var r = Run(new[]
        {
            Enter(0, "F"), Sql(0.5, "SELECT 1", 0.5), Exit(1, "F"),
            Enter(2, "F"), Sql(7, "SELECT 2", 5), Enter(7.5, "G"), Exit(8, "G"),
        }, new XppTraceOptions { Focus = new[] { "F" }, SubtreeOnly = true });
        Near(r.Totals!.FocusSeconds ?? -1, 7, "subtree: open focus frame counted until the thread's last event");
        Check((r.Totals!.SqlShareOfTime ?? 2) <= 1, "subtree: SQL share stays within the focus time");
        Check(!r.Caveats.Any(c => c.Contains("counted nothing closed")), "subtree: a closed focus frame means no 'nothing closed' caveat");
    }

    private static void ProcessFilter()
    {
        var r = Run(new[] { Enter(0, "A", pid: 1), Exit(1, "A", pid: 1), Enter(0, "B", pid: 2), Exit(1, "B", pid: 2) }, new XppTraceOptions { ProcessId = 2 });
        Check(r.TopInclusive.All(x => x.Method == "B"), "pid: other process ignored");
    }

    private static void StatementNormalisation()
    {
        var r = Run(new[] { Enter(0, "A"), Sql(1, "SELECT  A\r\n  FROM\tT", 0.1), Sql(2, "SELECT A FROM T", 0.1), Exit(3, "A") },
            new XppTraceOptions { StatementLength = 300 });
        Check(r.TopSqlByCount.Count == 1 && r.TopSqlByCount[0].Executions == 2 && r.TopSqlByCount[0].Statement == "SELECT A FROM T", "sql: whitespace collapsed into one statement");
        var longStmt = "SELECT " + new string('x', 500);
        var t = Run(new[] { Enter(0, "A"), Sql(1, longStmt, 0.1), Exit(2, "A") }, new XppTraceOptions { StatementLength = 50 });
        Check(t.TopSqlByCount[0].Statement.Length == 51, "sql: statement truncated");
    }

    private static void WideStatementsKeptApart()
    {
        // The kernel lists every column, so on a wide table FROM starts past the display length: two queries
        // on the same table with different WHERE clauses share their first 300 characters.
        string columns = string.Join(",", Enumerable.Range(1, 60).Select(i => "T1.FIELD" + i));
        string byAccount = "SELECT " + columns + " FROM CUSTTABLE T1 WHERE ((T1.PARTITION=?) AND (T1.ACCOUNTNUM=?))";
        string byParty = "SELECT " + columns + " FROM CUSTTABLE T1 WHERE ((T1.PARTITION=?) AND (T1.PARTY=?))";
        Check(byAccount.Substring(0, 300) == byParty.Substring(0, 300), "wide: the fixture shares its first 300 characters");
        var events = new List<XppTraceEvent> { Enter(0, "Loop") };
        for (int i = 0; i < 30; i++) events.Add(Sql(0.01 * (i + 1), byAccount, 0.001));
        for (int i = 0; i < 30; i++) events.Add(Sql(1 + 0.01 * i, byParty, 0.001));
        events.Add(Exit(2, "Loop"));
        var r = Run(events);
        Check(r.TopSqlByCount.Count == 2 && r.TopSqlByCount.All(s => s.Executions == 30), "wide: two statements of 30 executions, got " + string.Join(", ", r.TopSqlByCount.Select(s => s.Executions)));
        Check(r.RepeatedSql.Count == 0, "wide: neither reaches the repeated threshold of 50");
        Check(r.TopSqlByCount.Any(s => s.Statement.Contains("FROM CUSTTABLE T1 WHERE") && s.Statement.Contains("ACCOUNTNUM"))
            && r.TopSqlByCount.Any(s => s.Statement.Contains("PARTY=?")), "wide: the shown text keeps FROM … WHERE");
        Check(r.TopSqlByCount.All(s => s.Statement.StartsWith("SELECT T1.FIELD1,") && s.Statement.Length <= 301), "wide: head kept, length bounded");
    }

    private static void SubtreeBusyTime()
    {
        // In subtree scope the root sits above the focus: the thread was still busy for its 10 s.
        var r = Run(new[] { Enter(0, "Root"), Enter(1, "Foo"), Exit(5, "Foo"), Exit(10, "Root") },
            new XppTraceOptions { Focus = new[] { "Foo" }, SubtreeOnly = true });
        Near(r.Totals!.BusySeconds, 10, "subtree: busy time counts the root frame");
        Near(r.Totals!.FocusSeconds ?? -1, 4, "subtree: focus time");
    }

    private static void BindIsCountedOnly()
    {
        var r = Run(new[] { Enter(0, "A"), new XppTraceEvent { Kind = XppTraceEventKind.Bind, Ticks = T(1), ThreadId = 1, ProcessId = 100 }, Exit(2, "A") });
        Check(r.SqlBindEventsCounted == 1, "bind: counted");
        Check(!JsonSerializer.Serialize(r).Contains("parameterValue"), "bind: no value field in the result");
    }

    private static void ShareUsesBusyTime()
    {
        // Thread 1 works for 10 s; thread 2 spans 10 s but works 1 s + 1 s, with 0.5 s of SQL
        // between its calls. SQL 2.5 s over busy 12.5 s = 20 %, not 2.5 / 20 thread-seconds.
        var r = Run(new[]
        {
            Enter(0, "A", tid: 1), Sql(5, "S1", 1, tid: 1), Exit(10, "A", tid: 1),
            Enter(0, "B", tid: 2), Sql(0.5, "S2", 1, tid: 2), Exit(1, "B", tid: 2),
            Sql(5, "S3", 0.5, tid: 2),
            Enter(9, "C", tid: 2), Exit(10, "C", tid: 2),
        });
        Near(r.Totals!.ThreadSeconds, 20, "share: thread seconds summed");
        Near(r.Totals!.BusySeconds, 12.5, "share: busy = root frames + SQL outside frames");
        Near(r.Totals!.SqlShareOfTime ?? -1, 0.2, "share: SQL over busy time");
        Near(r.Span!.WallSeconds, 10, "share: wall span reported separately");
        Check(r.TopSqlByTime.Any(x => x.Statement == "S3" && x.Callers[0].Method == XppTraceAggregator.NoFrame), "share: frameless SQL attributed to no frame");
    }

    private static void TempTablesNormalised()
    {
        // One statement on a session's temp table, run by two sessions: one row, table id kept.
        var r = Run(new[]
        {
            Enter(0, "A"),
            Sql(1, "INSERT INTO tempdb.\"DBO\".t18093BatchHOST01_15772_0123abcd (X) VALUES (?)", 0.1),
            Sql(2, "INSERT INTO tempdb.\"DBO\".t18093BatchHOST01_9944_89ef4567 (X) VALUES (?)", 0.1),
            Exit(3, "A"),
        });
        Check(r.TopSqlByCount.Count == 1 && r.TopSqlByCount[0].Executions == 2, "tempdb: sessions merged into one statement");
        Check(r.TopSqlByCount[0].Statement == "INSERT INTO tempdb.\"DBO\".t18093_* (X) VALUES (?)", "tempdb: normalised to the table id, got " + r.TopSqlByCount[0].Statement);
    }

    private static void BatchDispatcherCaveat()
    {
        var dialog = Run(new[] { Enter(0, "MyJob::run"), Enter(1, "BatchHeader::save"), Exit(2, "BatchHeader::save"), Exit(3, "MyJob::run") },
            new XppTraceOptions { Focus = new[] { "MyJob" } });
        Check(dialog.Caveats.Any(c => c.Contains("Batch.exe")), "batch: a focus that only schedules tasks points at Batch.exe");
        var task = Run(new[] { Enter(0, "BatchRun::runJobStaticCodeFromBuffer"), Enter(1, "MyJob::run"), Enter(2, "Batch::insert"), Exit(3, "Batch::insert"), Exit(4, "MyJob::run"), Exit(5, "BatchRun::runJobStaticCodeFromBuffer") },
            new XppTraceOptions { Focus = new[] { "MyJob" } });
        Check(!task.Caveats.Any(c => c.Contains("Batch.exe")), "batch: no hint when the task itself runs under BatchRun");
    }

    private static void RootsCountedPastTheCap()
    {
        // 64 distinct roots fill the map; a root already in it keeps counting, and a later BatchRun:: root
        // is still seen by the Batch.exe caveat.
        var events = new List<XppTraceEvent>();
        for (int i = 0; i < 70; i++) { events.Add(Enter(i, "Root" + i)); events.Add(Exit(i + 0.5, "Root" + i)); }
        for (int i = 0; i < 5; i++) { events.Add(Enter(100 + i, "Root63")); events.Add(Exit(100.5 + i, "Root63")); }
        events.AddRange(new[] { Enter(200, "BatchRun::runJobStaticCodeFromBuffer"), Enter(201, "MyJob::run"), Enter(202, "Batch::insert"), Exit(203, "Batch::insert"), Exit(204, "MyJob::run"), Exit(205, "BatchRun::runJobStaticCodeFromBuffer") });
        var r = Run(events, new XppTraceOptions { Focus = new[] { "MyJob" } });
        Check(r.Threads[0].Roots.Contains("Root63"), "roots: a counted root keeps counting past the cap");
        Check(!r.Caveats.Any(c => c.Contains("Batch.exe")), "roots: a BatchRun:: root past the cap still silences the Batch.exe hint");
    }

    private static void ResultSerialises()
    {
        var r = Run(new[] { Enter(0, "A"), Exit(1, "A") });
        var json = JsonSerializer.Serialize(r, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
        Check(json.Contains("\"topExclusive\"") && json.Contains("\"pairing\""), "json: camelCase result");
    }

    private static int RunReal(string[] args)
    {
        var options = new XppTraceOptions();
        for (int i = 2; i < args.Length; i++)
        {
            if (args[i] == "--focus" && i + 1 < args.Length) options.Focus = args[++i].Split(';');
            else if (args[i] == "--pid" && i + 1 < args.Length) options.ProcessId = int.Parse(args[++i]);
        }
        var aggregator = new XppTraceAggregator(options);
        var stats = EtlTraceReader.Read(args[1], aggregator, n => Console.Error.WriteLine("read " + n));
        var result = aggregator.Build();
        result.EventsRead = stats.EventsRead;
        Console.WriteLine(JsonSerializer.Serialize(result, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, WriteIndented = true }));
        return 0;
    }
}
