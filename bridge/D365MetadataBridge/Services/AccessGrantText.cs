using System;
using System.Collections.Generic;
using Microsoft.Dynamics.AX.Metadata.Core.MetaModel;

namespace D365MetadataBridge.Services
{
    /// <summary>
    /// Text form of an AccessGrant — AxTable.SubscriberAccessLevel, "Subscriber access
    /// level" in Visual Studio. Six permissions, each Unset/Allow/Deny; the serializer
    /// writes only the set ones, as child elements. AccessGrant is a STRUCT: change a
    /// copy and assign it back, or the change is lost.
    /// </summary>
    internal static class AccessGrantText
    {
        private static readonly string[] Permissions = { "Correct", "Create", "Delete", "Invoke", "Read", "Update" };

        /// <summary>"Create=Deny, Read=Allow" for the set permissions; null when none are.</summary>
        public static string? Describe(AccessGrant grant)
        {
            var parts = new List<string>();
            foreach (var name in Permissions)
            {
                var value = Get(grant, name);
                if (value != AccessGrantPermission.Unset) parts.Add($"{name}={value}");
            }
            return parts.Count > 0 ? string.Join(", ", parts) : null;
        }

        /// <summary>
        /// Parse "Read=Allow,Create=Deny", a bare list "Read,Update" (Allow), or "None".
        /// Permissions not named are Unset. Throws ArgumentException on anything else.
        /// </summary>
        public static AccessGrant Parse(string? text)
        {
            var grant = new AccessGrant();
            var s = (text ?? "").Trim();
            if (s.Length == 0 || s.Equals("None", StringComparison.OrdinalIgnoreCase)
                || s.Equals("Unset", StringComparison.OrdinalIgnoreCase))
                return grant;

            foreach (var raw in s.Split(new[] { ',', ';' }, StringSplitOptions.RemoveEmptyEntries))
            {
                var pair = raw.Split(new[] { '=', ':' }, 2);
                var key = pair[0].Trim();
                var name = Array.Find(Permissions, p => p.Equals(key, StringComparison.OrdinalIgnoreCase))
                    ?? throw new ArgumentException(
                        $"Unknown subscriber permission '{key}'. Permissions: {string.Join(", ", Permissions)}; " +
                        "values: Allow, Deny, Unset. Example: \"Read=Allow,Create=Deny\", or \"None\".");
                var valueText = pair.Length > 1 ? pair[1].Trim() : "Allow";
                if (!Enum.TryParse<AccessGrantPermission>(valueText, true, out var value) || !Enum.IsDefined(typeof(AccessGrantPermission), value))
                    throw new ArgumentException(
                        $"Invalid value '{valueText}' for subscriber permission {name}. Values: Allow, Deny, Unset.");
                grant = Set(grant, name, value);
            }
            return grant;
        }

        /// <summary>What Visual Studio sets on a new regular table: Read=Allow.</summary>
        public static AccessGrant VisualStudioDefault() => Set(new AccessGrant(), "Read", AccessGrantPermission.Allow);

        private static AccessGrantPermission Get(AccessGrant g, string name)
        {
            switch (name)
            {
                case "Correct": return g.Correct;
                case "Create": return g.Create;
                case "Delete": return g.Delete;
                case "Invoke": return g.Invoke;
                case "Read": return g.Read;
                default: return g.Update;
            }
        }

        private static AccessGrant Set(AccessGrant g, string name, AccessGrantPermission value)
        {
            switch (name)
            {
                case "Correct": g.Correct = value; break;
                case "Create": g.Create = value; break;
                case "Delete": g.Delete = value; break;
                case "Invoke": g.Invoke = value; break;
                case "Read": g.Read = value; break;
                default: g.Update = value; break;
            }
            return g;
        }
    }
}
