/** Fail-closed admission gates. A gate failure means the plugin does not enter the index. */

const NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'];
const GIT_LIFECYCLE = ['prepare', 'prepack', 'prepublishOnly'];

export function checkGates(facts) {
  const { name, version, pkg, tar, report, policy, blocklist, reviewed, source } = facts;
  const failures = [];
  const warnings = [];
  const labels = new Set();

  const fail = (code, detail) => failures.push({ code, detail });
  const warn = (code, detail) => warnings.push({ code, detail });

  if (!NAME_RE.test(name) || name.length > 214) fail('invalid-name', name);
  if (blocklist.names?.includes(name)) fail('blocklisted-name', name);
  if (report.repoFullName && blocklist.repos?.includes(report.repoFullName)) fail('blocklisted-repo', report.repoFullName);
  if (report.publisher && blocklist.publishers?.includes(report.publisher)) fail('blocklisted-publisher', report.publisher);

  const bundle = pkg.dsh?.bundle;
  const patches = bundle?.patch === undefined ? [] : Array.isArray(bundle.patch) ? bundle.patch : [bundle.patch];
  if (patches.length === 0) {
    fail('not-a-bundle', 'package.json has no dsh.bundle.patch');
  } else {
    for (const patch of patches) {
      if (typeof patch !== 'string' || patch.trim() === '' || patch.startsWith('/') || /(^|\/)\.\.(\/|$)/u.test(patch)) {
        fail('invalid-bundle-patch', `unsafe bundle patch path: ${JSON.stringify(patch)}`);
        continue;
      }
      const relative = patch.replace(/^\.\//u, '');
      if (!tar.has(relative)) fail('missing-bundle-patch', `tarball has no ${relative}`);
      else {
        const text = tar.read(relative) ?? '';
        if (!/^(?:#.*\n|\s*\n)*[-\w]|^\s*\[/mu.test(text) && text.trim() === '') fail('empty-bundle-patch', relative);
        if (!/\b(?:plugin|include|group|id|disabled)\b/u.test(text) && text.trim() !== '') {
          // a bundle patch without any loader directive is almost certainly the wrong file
          warn('suspicious-bundle-patch', relative);
        }
      }
    }
  }

  if (pkg.dsh?.manifestVersion !== undefined && pkg.dsh.manifestVersion !== 1) {
    fail('unsupported-manifest-version', String(pkg.dsh.manifestVersion));
  }

  const scripts = pkg.scripts ?? {};
  const installScripts = INSTALL_SCRIPTS.filter((key) => typeof scripts[key] === 'string' && scripts[key].trim() !== '');
  if (installScripts.length > 0 && !reviewed?.installScriptsApproved) {
    fail('install-scripts', `blocked install-time scripts: ${installScripts.join(', ')}`);
  } else if (installScripts.length > 0) {
    labels.add('install-scripts-reviewed');
    warn('install-scripts-reviewed', installScripts.join(', '));
  }
  if (source.type === 'git') {
    labels.add('git-source');
    const lifecycle = GIT_LIFECYCLE.filter((key) => typeof scripts[key] === 'string' && scripts[key].trim() !== '');
    if (lifecycle.length > 0 && !reviewed?.gitLifecycleApproved) {
      fail('git-lifecycle-scripts', `git install would run ${lifecycle.join(', ')}`);
    }
  }

  if (tar.compressedBytes > (policy.maxTarballBytes ?? 32 * 1024 * 1024)) {
    fail('tarball-too-large', `${tar.compressedBytes} bytes`);
  }
  if (tar.entryCount > (policy.maxTarEntries ?? 10000)) fail('too-many-entries', String(tar.entryCount));

  if (!report.license) {
    if (policy.requireLicense) fail('no-license', name);
    else warn('no-license', name);
  }
  if (report.archived) {
    if (policy.blockArchivedRepo) fail('archived-repo', report.repoFullName ?? name);
    else {
      warnings.push({ code: 'archived-repo', detail: report.repoFullName ?? name });
      labels.add('archived-upstream');
    }
  }
  if (report.manifestDeprecated) {
    warnings.push({ code: 'deprecated', detail: String(report.manifestDeprecated) });
    labels.add('deprecated');
  }

  const enginesDsh = pkg.engines?.dsh;
  if (enginesDsh === undefined) labels.add('no-engines');
  else if (typeof enginesDsh === 'string' && enginesDsh.startsWith('workspace:')) fail('workspace-range', enginesDsh);

  if (report.hasProvenance) labels.add('provenance');
  if (report.publisher === 'deepseek-ai' || name.startsWith('@deepseek-ai/')) labels.add('official');
  if (report.clientUi) labels.add('ui');
  if (!report.repoFullName) warn('no-repository', name);
  if (report.monthlyDownloads === 0) warn('no-usage-signal', name);

  if (reviewed?.major === report.major && reviewed?.approved !== false) labels.add('reviewed');

  return { ok: failures.length === 0, failures, warnings, labels: [...labels], version };
}
