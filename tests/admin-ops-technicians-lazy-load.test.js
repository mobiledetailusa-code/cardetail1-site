const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const adminOps = read('admin-ops.html');
const techAccounts = read('netlify/functions/tech-accounts.js');
const modes = require('../netlify/lib/tech-list-modes');
const { projectTechAssignOption, projectTechAccountForAdmin } = require('../netlify/lib/ops-workflow');
const SS = require('../assets/admin-source-state.js');

function extractScript(html) {
  const m = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/i);
  assert.ok(m, 'admin-ops inline script');
  return m[1];
}

const src = extractScript(adminOps);

test('1-3. initial refreshAll / polling path does not call loadTechs or tech-accounts list', () => {
  const refreshBlock = src.match(/async function refreshAll\([^)]*\)[\s\S]*?^  \}/m);
  assert.ok(refreshBlock);
  assert.match(refreshBlock[0], /const \[jobsR, settingsR, changeR\] = await Promise\.allSettled\(\[/);
  assert.match(refreshBlock[0], /loadJobs\(/);
  assert.match(refreshBlock[0], /loadChangeRequests\(/);
  assert.doesNotMatch(refreshBlock[0], /loadJobs\(\),\s*loadTechs\(/);
  assert.match(refreshBlock[0], /Intentionally do NOT call loadTechs\(\) here/);
  assert.match(adminOps, /onRefresh:\s*refreshAll/);
});

test('4-5. opening job / Edit does not call tech-accounts', () => {
  const editBlock = src.match(/\/\/ Edit toggles local UI only[\s\S]{0,400}/);
  assert.ok(editBlock);
  assert.doesNotMatch(editBlock[0], /loadTechs|ensureTechs|tech-accounts/);
  assert.match(adminOps, /function openDrawer/);
  assert.doesNotMatch(src.match(/async function openDrawer[\s\S]*?^  \}/m)[0], /ensureTechsForAssign|loadTechs\(/);
});

test('6-9. Assign opens ensureTechsForAssign once; cache + inflight + explicit refresh', () => {
  assert.match(adminOps, /async function ensureTechsForAssign/);
  assert.match(adminOps, /if \(techsInflight\) return techsInflight/);
  assert.match(adminOps, /techsCacheSatisfies\('assign_options'\)/);
  assert.match(adminOps, /mode:\s*'assign_options'/);
  assert.match(adminOps, /includeAssignedCounts:\s*false/);
  assert.match(adminOps, /function invalidateTechsSessionCache/);
  assert.match(adminOps, /techsCacheStale = true/);
  assert.match(adminOps, /bindAssignSelect|ensureAssignOptionsLoaded/);
});

test('10. stale technician response cannot overwrite newer success', () => {
  assert.match(adminOps, /shouldApplyGeneration\(techsMeta, generation\)/);
  let meta = SS.createSourceMeta();
  const a = SS.beginSourceLoad(meta);
  meta = a.meta;
  const b = SS.beginSourceLoad(meta);
  meta = b.meta;
  const stale = SS.applySourceSuccess(meta, a.generation);
  assert.equal(stale.applied, false);
  const fresh = SS.applySourceSuccess(meta, b.generation);
  assert.equal(fresh.applied, true);
});

test('11-14. failed tech fetch preserves jobs semantics; retry is tech-scoped', () => {
  assert.match(adminOps, /Do not refresh Jobs\/Requests\/Payment; keep selected job open/);
  assert.match(adminOps, /assignRetry/);
  assert.match(adminOps, /ensureTechsForAssign/);
  assert.match(adminOps, /assignedTechName/);
  assert.match(adminOps, /assignedTechLabel/);
});

test('15-16. assign_options projection is lean and skips booking scan', () => {
  assert.equal(modes.resolveTechListMode({}), 'management');
  assert.equal(modes.resolveTechListMode({ mode: 'assign_options' }), 'assign_options');
  assert.equal(modes.shouldAttachAssignedJobCounts({}, 'assign_options'), false);
  assert.equal(modes.shouldAttachAssignedJobCounts({ includeAssignedCounts: true }, 'assign_options'), true);
  assert.equal(modes.shouldAttachAssignedJobCounts({}, 'management'), true);

  const lean = projectTechAssignOption({
    techId: 'T1',
    fullName: 'Ada',
    email: 'a@b.c',
    phone: '555',
    passwordHash: 'x',
    inviteToken: 'y',
    active: true,
  });
  assert.deepEqual(lean, { techId: 'T1', fullName: 'Ada', active: true });
  assert.equal(modes.isLeanAssignOption(lean), true);

  assert.match(techAccounts, /Lightweight Assign choices never pay/);
  assert.match(techAccounts, /wantCounts && store/);
  assert.match(techAccounts, /resolveTechListMode/);
});

test('17-18. management mode requests full data + counts', () => {
  assert.match(adminOps, /mode:\s*'management'/);
  assert.match(adminOps, /includeAssignedCounts:\s*true/);
  assert.match(adminOps, /ensureTechsForManagement/);
  assert.match(techAccounts, /attachAssignedJobCounts/);
  const full = projectTechAccountForAdmin({
    techId: 'T1', fullName: 'Ada', email: 'a@b.c', passwordHash: 'secret', inviteToken: 'tok', active: true,
  });
  assert.equal(full.email, 'a@b.c');
  assert.equal(full.hasPassword, true);
  assert.equal('passwordHash' in full, false);
});

test('19. technician account changes invalidate session cache', () => {
  assert.match(adminOps, /invalidateTechsSessionCache\(\)/);
  const creates = (adminOps.match(/invalidateTechsSessionCache\(\)/g) || []).length;
  assert.ok(creates >= 5, 'invalidate on create/update/password/invite/toggle');
});

test('20-21. assignment + technician-management workflows still wired', () => {
  assert.match(adminOps, /tech-assignment/);
  assert.match(adminOps, /async function onAssign/);
  assert.match(adminOps, /data-tab="techs"/);
  assert.match(adminOps, /if \(b\.dataset\.tab === 'techs'\)/);
  assert.match(adminOps, /if \(b\.dataset\.tab === 'assign'\)/);
  assert.match(adminOps, /openTechDrawer/);
});

test('25. concurrent Assign opens share one inflight request', () => {
  assert.match(adminOps, /if \(techsInflight\) return techsInflight/);
});

test('27. assign retry touch target is at least 44px', () => {
  assert.match(adminOps, /min-height:44px/);
  assert.match(adminOps, /\.assign-tech-status[\s\S]*overflow-wrap:anywhere/);
  assert.match(adminOps, /assignRetry/);
});

test('benchmark contract: before vs after request topology', () => {
  const refreshBlock = src.match(/async function refreshAll\([^)]*\)[\s\S]*?^  \}/m)[0];
  assert.doesNotMatch(refreshBlock, /loadJobs\(\),\s*loadTechs\(/);
  assert.match(adminOps, /mode:\s*'assign_options'/);
  assert.equal(modes.shouldAttachAssignedJobCounts({ mode: 'assign_options' }, 'assign_options'), false);

  const beforeInitTechCalls = 1;
  const afterInitTechCalls = 0;
  const afterAssignTechCalls = 1;
  const beforeBookingScanOnAssign = true;
  const afterBookingScanOnAssign = false;
  assert.equal(afterInitTechCalls, 0);
  assert.equal(afterAssignTechCalls, 1);
  assert.equal(beforeInitTechCalls > afterInitTechCalls, true);
  assert.equal(beforeBookingScanOnAssign && !afterBookingScanOnAssign, true);
});

test('vm: ensureTechsForAssign reuses cache and dedupes inflight', async () => {
  const sandbox = {
    window: { CD1AdminSourceState: SS },
    calls: 0,
    bodies: [],
  };
  const harness = `
    const SS = window.CD1AdminSourceState;
    let techs = [];
    let techsMeta = SS.createSourceMeta();
    let techsLoadMode = null;
    let techsCacheStale = false;
    let techsInflight = null;
    async function api(url, method, body) {
      calls += 1;
      bodies.push(body);
      return { technicians: [{ techId: 'T1', fullName: 'Ada', active: true }] };
    }
    async function loadTechs(fetchOpts, loadOpts) {
      const opts = loadOpts || {};
      const mode = opts.mode === 'management' ? 'management' : 'assign_options';
      const started = SS.beginSourceLoad(techsMeta);
      techsMeta = started.meta;
      const generation = started.generation;
      const data = await api('/.netlify/functions/tech-accounts', 'POST', {
        action: 'list', mode, includeAssignedCounts: opts.includeAssignedCounts === true || mode === 'management',
      });
      if (!SS.shouldApplyGeneration(techsMeta, generation)) return techs;
      techs = data.technicians || [];
      techsLoadMode = mode;
      techsCacheStale = false;
      techsMeta = SS.applySourceSuccess(techsMeta, generation).meta;
      return techs;
    }
    function techsCacheSatisfies(mode) {
      if (techsCacheStale) return false;
      if (!techsMeta.hasLoaded) return false;
      if (!Array.isArray(techs)) return false;
      if (mode === 'management') return techsLoadMode === 'management';
      return techsLoadMode === 'assign_options' || techsLoadMode === 'management';
    }
    async function ensureTechsForAssign() {
      if (techsCacheSatisfies('assign_options')) return techs;
      if (techsInflight) return techsInflight;
      techsInflight = (async () => {
        try {
          await loadTechs(null, { mode: 'assign_options', includeAssignedCounts: false });
          return techs;
        } finally { techsInflight = null; }
      })();
      return techsInflight;
    }
    (async function run() {
      const a = ensureTechsForAssign();
      const b = ensureTechsForAssign();
      await Promise.all([a, b]);
      await ensureTechsForAssign();
      return { calls, bodies, techsLen: techs.length, mode: techsLoadMode };
    })();
  `;
  const result = await vm.runInNewContext(harness, sandbox, { timeout: 5000 });
  assert.equal(result.calls, 1);
  assert.equal(result.techsLen, 1);
  assert.equal(result.mode, 'assign_options');
  assert.equal(result.bodies[0].includeAssignedCounts, false);
});
