using System;
using Microsoft.Dynamics.AX.Metadata.MetaModel;

namespace D365MetadataBridge.Services
{
    /// <summary>
    /// sa.global fork: AxTable properties the upstream SetAxTableProperty switch does not cover.
    /// Kept in its own file and reached only from that switch's default branch, so upstream
    /// can keep extending its switch without merge conflicts. When upstream adds one of these
    /// properties, its own case handles it first and the copy here is no longer reached.
    /// </summary>
    public partial class MetadataWriteService
    {
        /// <summary>
        /// Sets an AxTable property upstream does not handle. Returns false when `prop` is not
        /// recognized here either, so the caller reports it as unknown.
        /// </summary>
        private bool SetAxTablePropertySab(AxTable tbl, string prop, string value)
        {
            switch (prop.ToLowerInvariant())
            {
                // ── String properties ──────────────────────────────────────────────
                case "singularlabel":               tbl.SingularLabel = value; break;
                case "listpageref":                 tbl.ListPageRef = value; break;
                case "reportref":                   tbl.ReportRef = value; break;
                case "previewpartref":              tbl.PreviewPartRef = value; break;
                case "countryregioncodes":          tbl.CountryRegionCodes = value; break;
                case "countryregioncontextfield":   tbl.CountryRegionContextField = value; break;
                case "tags":                        tbl.Tags = value; break;

                // ── NoYes properties ───────────────────────────────────────────────
                case "allowchangetracking":             tbl.AllowChangeTracking = ParseNoYes(value); break;
                case "allowarchival":                   tbl.AllowArchival = ParseNoYes(value); break;
                case "allowretention":                  tbl.AllowRetention = ParseNoYes(value); break;
                case "allowoverride":                   tbl.AllowOverride = ParseNoYes(value); break;
                case "abstract":                        tbl.Abstract = ParseNoYes(value); break;
                case "savedataperpartition":            tbl.SaveDataPerPartition = ParseNoYes(value); break;
                case "systemtable":                     tbl.SystemTable = ParseNoYes(value); break;
                case "createrecidindex":                tbl.CreateRecIdIndex = ParseNoYes(value); break;
                case "occenabled":                      tbl.OccEnabled = ParseNoYes(value); break;
                case "disabledatabaselogging":          tbl.DisableDatabaseLogging = ParseNoYes(value); break;
                case "disablelockescalation":           tbl.DisableLockEscalation = ParseNoYes(value); break;
                case "isobsolete":                      tbl.IsObsolete = ParseNoYes(value); break;
                case "visible":                         tbl.Visible = ParseNoYes(value); break;

                // ── Enum properties ────────────────────────────────────────────────
                case "aosauthorization":
                    if (Enum.TryParse<Microsoft.Dynamics.AX.Metadata.Core.MetaModel.AosAuthorization>(value, true, out var aa))
                        tbl.AosAuthorization = aa;
                    break;
                case "entityrelationshiptype":
                    if (Enum.TryParse<Microsoft.Dynamics.AX.Metadata.Core.MetaModel.EntityRelationshipType>(value, true, out var ert))
                        tbl.EntityRelationshipType = ert;
                    break;
                case "validtimestatefieldtype":
                    if (Enum.TryParse<Microsoft.Dynamics.AX.Metadata.Core.MetaModel.ValidTimeStateFieldType>(value, true, out var vts))
                        tbl.ValidTimeStateFieldType = vts;
                    break;
                case "tablecontents":
                    if (Enum.TryParse<Microsoft.Dynamics.AX.Metadata.Core.MetaModel.TableContents>(value, true, out var tc))
                        tbl.TableContents = tc;
                    break;
                case "datasharingtype":
                    if (Enum.TryParse<Microsoft.Dynamics.AX.Metadata.Core.MetaModel.SysDataSharingType>(value, true, out var dst))
                        tbl.DataSharingType = dst;
                    break;
                case "durability":
                    if (Enum.TryParse<Microsoft.Dynamics.AX.Metadata.Core.MetaModel.Durability>(value, true, out var dur))
                        tbl.Durability = dur;
                    break;
                case "operationaldomain":
                    if (Enum.TryParse<Microsoft.Dynamics.AX.Metadata.Core.MetaModel.OperationalDomain>(value, true, out var od))
                        tbl.OperationalDomain = od;
                    break;
                case "storagemode":
                    if (Enum.TryParse<Microsoft.Dynamics.AX.Metadata.Core.MetaModel.StorageMode>(value, true, out var sm))
                        tbl.StorageMode = sm;
                    break;

                default:
                    return false;
            }
            return true;
        }
    }
}
