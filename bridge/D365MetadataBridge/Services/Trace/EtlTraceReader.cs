using System;
using System.Collections.Generic;
using System.Diagnostics.Eventing.Reader;
using System.Globalization;

namespace D365MetadataBridge.Services.Trace
{
    /// <summary>
    /// Reads a D365FO ETW capture (.etl) and feeds an <see cref="XppTraceAggregator"/>.
    ///
    /// Event ids and data names are the ones in the provider manifests shipped with Trace Parser
    /// (DynamicsAXXppExecutionTraces.man, DynamicsAXExecutionTraces.man):
    ///   Microsoft-Dynamics-AX-XppExecutionTraces {C0D248CE-634D-426B-9E31-5A50A6D83024}
    ///     24500 XppMethodEnter, 24501 XppMethodExit — template ExecutionTrace (methodName, sessionId, userGuid, …)
    ///   Microsoft-Dynamics-AX-ExecutionTraces {70560195-BECD-45D4-AC93-97290953AD02}
    ///     4922 AosSqlStatementExecutionLatency (sqlStatement, preparationTimeSeconds, executionTimeSeconds)
    ///     4923 AosSqlStatementInputBind — counted only; parameterValue is customer data and is never selected
    ///     4924 AosSqlRowFetchLatency (executionTimeSeconds)
    /// Rendering the named properties needs those manifests registered on the machine, which they
    /// are on an AOS/dev VM. A property selector is used so that only these few fields are rendered.
    /// Thread and process come from the ETW header, the timestamp from TimeCreated (100 ns).
    /// </summary>
    public static class EtlTraceReader
    {
        public static readonly Guid XppProvider = new Guid("C0D248CE-634D-426B-9E31-5A50A6D83024");
        public static readonly Guid ExecutionProvider = new Guid("70560195-BECD-45D4-AC93-97290953AD02");

        private static readonly string[] Selected =
        {
            "Event/EventData/Data[@Name='methodName']",
            "Event/EventData/Data[@Name='sqlStatement']",
            "Event/EventData/Data[@Name='executionTimeSeconds']",
            "Event/EventData/Data[@Name='preparationTimeSeconds']",
            "Event/EventData/Data[@Name='sessionId']",
            "Event/EventData/Data[@Name='userGuid']",
        };

        public sealed class ReadStats
        {
            public long EventsRead;
            public long EventsUnreadable;
        }

        /// <param name="progress">Called every <paramref name="progressEvery"/> events with the number read so far.</param>
        public static ReadStats Read(string etlPath, XppTraceAggregator aggregator, Action<long>? progress = null, long progressEvery = 250_000)
        {
            var stats = new ReadStats();
            var selector = new EventLogPropertySelector(Selected);
            using (var reader = new EventLogReader(new EventLogQuery(etlPath, PathType.FilePath)))
            {
                EventRecord? record;
                while ((record = reader.ReadEvent()) != null)
                {
                    using (record)
                    {
                        stats.EventsRead++;
                        if (progress != null && stats.EventsRead % progressEvery == 0) progress(stats.EventsRead);
                        var kind = KindOf(record);
                        if (kind == null) continue;
                        if (kind == XppTraceEventKind.Bind)
                        {
                            // Counted only: nothing of a bind event, least of all its value, is rendered.
                            aggregator.Add(new XppTraceEvent
                            {
                                Kind = XppTraceEventKind.Bind, ProcessId = record.ProcessId ?? 0, ThreadId = record.ThreadId ?? 0,
                                Ticks = record.TimeCreated.HasValue ? record.TimeCreated.Value.ToUniversalTime().Ticks : 0,
                            });
                            continue;
                        }
                        IList<object> values;
                        try { values = ((EventLogRecord)record).GetPropertyValues(selector); }
                        catch (EventLogException) { stats.EventsUnreadable++; continue; }
                        // A method event whose name did not render (manifest missing or another version) would
                        // pair as "?" and look clean: count it as unreadable, which the result reports.
                        if ((kind == XppTraceEventKind.Enter || kind == XppTraceEventKind.Exit) && !(values.Count > 0 && values[0] is string))
                        { stats.EventsUnreadable++; continue; }
                        aggregator.Add(new XppTraceEvent
                        {
                            Kind = kind.Value,
                            ProcessId = record.ProcessId ?? 0,
                            ThreadId = record.ThreadId ?? 0,
                            Ticks = record.TimeCreated.HasValue ? record.TimeCreated.Value.ToUniversalTime().Ticks : 0,
                            Method = kind == XppTraceEventKind.Enter || kind == XppTraceEventKind.Exit ? values[0] as string : null,
                            SqlStatement = kind == XppTraceEventKind.Sql ? values[1] as string : null,
                            ExecutionSeconds = ToDouble(values[2]),
                            PreparationSeconds = ToDouble(values[3]),
                            SessionId = values[4] as string,
                            UserGuid = values[5]?.ToString(),
                        });
                    }
                }
            }
            progress?.Invoke(stats.EventsRead);
            return stats;
        }

        private static XppTraceEventKind? KindOf(EventRecord record)
        {
            var provider = record.ProviderId;
            if (provider == XppProvider)
            {
                if (record.Id == 24500) return XppTraceEventKind.Enter;
                if (record.Id == 24501) return XppTraceEventKind.Exit;
                return null;
            }
            if (provider == ExecutionProvider)
            {
                if (record.Id == 4922) return XppTraceEventKind.Sql;
                if (record.Id == 4924) return XppTraceEventKind.Fetch;
                if (record.Id == 4923) return XppTraceEventKind.Bind;
            }
            return null;
        }

        private static double ToDouble(object? value)
        {
            if (value == null) return 0;
            try { return Convert.ToDouble(value, CultureInfo.InvariantCulture); }
            catch (FormatException) { return 0; }
            catch (InvalidCastException) { return 0; }
        }
    }
}
