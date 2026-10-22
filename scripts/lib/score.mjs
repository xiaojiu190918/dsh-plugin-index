/**
 * Deterministic quality score, 0..100. Same inputs always produce the same score,
 * so the index order never depends on wall-clock or iteration order.
 *
 * Weighting (deliberate, documented in docs/POLICY.md):
 *   compatibility 20 · maintenance 20 · safety 20 · provenance 15 · adoption 15 · docs 10
 */

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function daysSince(iso) {
  if (!iso) return Infinity;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return Infinity;
  return Math.max(0, (Date.now() - time) / 86_400_000);
}

function maintenancePoints(iso) {
  const days = daysSince(iso);
  if (days <= 30) return 20;
  if (days <= 60) return 18;
  if (days <= 90) return 16;
  if (days <= 180) return 11;
  if (days <= 365) return 5;
  return 0;
}

function satisfactionPoints(enginesDsh, baseline, semver) {
  if (enginesDsh === undefined) return 10;
  if (typeof enginesDsh !== 'string') return 0;
  try {
    if (semver.validRange(enginesDsh) === null) return 0;
    return semver.satisfies(baseline, enginesDsh, { includePrerelease: true }) ? 20 : 8;
  } catch {
    return 0;
  }
}

export function scorePlugin({ pkg, manifest, report, tar, labels, baseline, semver }) {
  const parts = {};

  parts.compatibility = satisfactionPoints(pkg.engines?.dsh, baseline, semver);

  parts.maintenance = maintenancePoints(report.latestPublish ?? manifest?.time);

  let safety = 0;
  if (!pkg.scripts || !['preinstall', 'install', 'postinstall'].some((key) => pkg.scripts[key])) safety += 8;
  if (tar.entryCount < 2000) safety += 4;
  if (report.license) safety += 4;
  if (labels.includes('provenance')) safety += 4;
  parts.safety = safety;

  let provenance = 0;
  if (labels.includes('provenance')) provenance += 8;
  if (report.repoMatchesPackage) provenance += 4;
  if (!report.archived) provenance += 3;
  parts.provenance = provenance;

  const downloads = report.monthlyDownloads ?? 0;
  parts.adoption = Math.round(clamp((Math.log10(downloads + 1) / 5) * 16, 0, 15));

  let docs = 0;
  if ((pkg.description ?? '').trim().length > 20) docs += 4;
  if (report.hasReadme) docs += 3;
  if ((pkg.keywords ?? []).length > 0) docs += 3;
  parts.docs = clamp(docs, 0, 10);

  const total = Object.values(parts).reduce((sum, value) => sum + value, 0);
  return { total: Math.round(clamp(total, 0, 100)), parts };
}
