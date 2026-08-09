
(function(){
  const KEY = CD1AdminSession.SESS_KEY;
  const token = CD1AdminSession.getToken();
  if (!token) { location.replace('admin.html'); return; }

  const JOB_STATUSES = ['pending_review','confirmed','assigned','accepted','en_route','arrived','in_progress','issue_reported','completed_pending_admin_review','completed_pending_payment','completed_paid','reopened','cancelled'];
  const PAY_STATUSES = ['no_payment_required_yet','pending_admin_review','awaiting_customer_payment','payment_action_required','payment_succeeded','payment_failed','cash_paid','refunded'];
  const inviteCache = {};

  let jobs = [], techs = [], activeJob = null, activeTech = null;
  let expandedJobId = null;
  // Stage 3 — canonical add-on data for the open job detail (server-provided only).
  // Catalog rows/prices and money figures come from get_job — never computed locally.
  let drawerAddonData = null;
  // Server-declared capability state for the open job (see get_job.operationalControls).
  let drawerControls = null;
  const refundRequestKeys = {};
  const adminMutationKeys = Object.create(null);
  let showTest = false, platformSettings = {}, platformAvailability = null, auctions = [], subscriptions = [], changeRequests = [];
  let requestsStatusFilter = 'pending';
  let jobDetailPanel = 'summary';
  let jobDetailDirty = false;
  let openDrawerFocusRequests = false;
  // Per-source load meta — data arrays above remain the single authority for records.
  const SS = window.CD1AdminSourceState || null;
  let jobsMeta = SS ? SS.createSourceMeta() : { hasLoaded:false, isLoading:false, error:null, lastSuccessAt:null, generation:0 };
  let techsMeta = SS ? SS.createSourceMeta() : { hasLoaded:false, isLoading:false, error:null, lastSuccessAt:null, generation:0 };
  let changeRequestsMeta = SS ? SS.createSourceMeta() : { hasLoaded:false, isLoading:false, error:null, lastSuccessAt:null, generation:0 };
  /** 'assign_options' | 'management' | null — session cache projection level */
  let techsLoadMode = null;
  let techsCacheStale = false;
  let techsInflight = null;
  let refreshAllInflight = null;
  let refreshAllSignal = null;
  let jobsSyncVersion = '';
  let requestsSyncVersion = '';
  let lastJobsNotModified = false;
  let lastRequestsNotModified = false;
  let opsRefresh = null;
  let sourceAbort = { jobs: null, techs: null, changeRequests: null };
  let pendingOpenBookingId = null;
  try {
    const u = new URL(location.href);
    const fromQuery = u.searchParams.get('bookingId') || u.searchParams.get('job');
    const fromHash = (u.hash.match(/^#(?:booking|job)=([^&]+)/i) || [])[1];
    const raw = fromQuery || (fromHash ? decodeURIComponent(fromHash) : '');
    if (raw && String(raw).trim()) pendingOpenBookingId = String(raw).trim();
  } catch (_) {}
  const SOURCE_FETCH_TIMEOUT_MS = 25000;

  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
  const toast = msg => { const t=$('#toast'); t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2800); };
  const JOBS_COLSPAN = 9;

  function newOperationKey() {
    return window.crypto && typeof window.crypto.randomUUID === 'function'
      ? window.crypto.randomUUID()
      : ('op_' + Date.now() + '_' + Math.random().toString(36).slice(2));
  }

  function mutationSignature(url, body) {
    const clean = Object.assign({}, body || {});
    delete clean.idempotencyKey;
    delete clean.requestKey;
    delete clean.expectedBookingVersion;
    const sorted = {};
    Object.keys(clean).sort().forEach((key) => { sorted[key] = clean[key]; });
    return url + ':' + JSON.stringify(sorted);
  }

  function adminLogout() {
    const t = CD1AdminSession.getToken();
    if (t) {
      fetch('/.netlify/functions/admin-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': t },
        body: JSON.stringify({ action: 'logout', token: t }),
      }).catch(()=>{});
    }
    CD1AdminSession.clearToken();
    localStorage.removeItem('cd1_session');
    location.replace('admin.html');
  }

  async function ensureAdminSession() {
    const t = CD1AdminSession.getToken();
    if (!t) { location.replace('admin.html'); return false; }
    try {
      const res = await fetch('/.netlify/functions/admin-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': t },
        body: JSON.stringify({ action: 'validate', token: t }),
      });
      const data = await res.json();
      if (!data.ok) { CD1AdminSession.clearToken(); location.replace('admin.html'); return false; }
      CD1AdminSession.syncWindowKey();
      return true;
    } catch {
      // Network failure must not pretend the session is valid.
      toast('Could not verify Admin session — check your connection and refresh.');
      return false;
    }
  }

  async function api(url, method, body, extraOpts) {
    let mutationKeySignature = '';
    const readActions = new Set(['get_job', 'list_audit', 'list']);
    if (method === 'POST' && body && body.action && !readActions.has(String(body.action))) {
      if (body.bookingId && (body.expectedBookingVersion == null || body.expectedBookingVersion === '')) {
        const current = activeJob && activeJob.id === body.bookingId
          ? activeJob
          : jobs.find((job) => job && job.id === body.bookingId);
        if (current && current.bookingVersion != null) body.expectedBookingVersion = current.bookingVersion;
      }
      mutationKeySignature = mutationSignature(url, body);
      if (!body.idempotencyKey) {
        body.idempotencyKey = adminMutationKeys[mutationKeySignature]
          || (adminMutationKeys[mutationKeySignature] = newOperationKey());
      }
    }
    const opts = Object.assign({ method: method||'GET', headers: { 'x-admin-key': CD1AdminSession.getToken() } }, extraOpts || {});
    if (!opts.headers) opts.headers = { 'x-admin-key': CD1AdminSession.getToken() };
    if (!opts.headers['x-admin-key']) opts.headers['x-admin-key'] = CD1AdminSession.getToken();
    if (body) { opts.headers['Content-Type']='application/json'; opts.body=JSON.stringify(body); }
    let timeoutId = null;
    let timedOut = false;
    const outerSignal = opts.signal || null;
    if (SOURCE_FETCH_TIMEOUT_MS > 0 && typeof AbortController !== 'undefined') {
      const ctrl = new AbortController();
      opts.signal = ctrl.signal;
      if (outerSignal) {
        if (outerSignal.aborted) {
          try { ctrl.abort(); } catch (_) {}
        } else {
          outerSignal.addEventListener('abort', () => { try { ctrl.abort(); } catch (_) {} }, { once: true });
        }
      }
      timeoutId = setTimeout(() => { timedOut = true; try { ctrl.abort(); } catch (_) {} }, SOURCE_FETCH_TIMEOUT_MS);
    }
    try {
      const res = await fetch(url, opts);
      const data = await res.json().catch(()=>({}));
      if (!res.ok || data.ok === false) {
        const err = data.error || ('HTTP '+res.status);
        if (err === 'unauthorized' || res.status === 401) {
          CD1AdminSession.clearToken();
          throw new Error('Session expired — log in again at admin.html');
        }
        var requestError = new Error(err);
        requestError.retryable = data.retryable === true;
        requestError.status = res.status;
        requestError.statusCode = res.status;
        requestError.data = data;
        const retryHeader = Number(res.headers && res.headers.get && res.headers.get('Retry-After'));
        requestError.retryAfterMs = Number(data.retryAfterSec) > 0
          ? Number(data.retryAfterSec) * 1000
          : (retryHeader > 0 ? retryHeader * 1000 : 0);
        throw requestError;
      }
      if (method && method !== 'GET' && body && body.action && opsRefresh) {
        opsRefresh.markPending(30000);
      }
      if (mutationKeySignature) delete adminMutationKeys[mutationKeySignature];
      return data;
    } catch (e) {
      if (mutationKeySignature && e && e.status && e.status < 500 && e.status !== 429) {
        delete adminMutationKeys[mutationKeySignature];
      }
      if (timedOut) throw new Error('timeout');
      if (e && e.name === 'AbortError') throw new Error('aborted');
      throw e;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  function badge(text, cls) { return '<span class="badge '+cls+'">'+esc(text.replace(/_/g,' '))+'</span>'; }
  function jobBadge(st) {
    const m = {completed_paid:'b-ok',completed_pending_admin_review:'b-warn',completed_pending_payment:'b-warn',issue_reported:'b-err',in_progress:'b-ac',assigned:'b-ac',cancelled:'b-st'};
    return badge(st, m[st]||'b-st');
  }
  function payBadge(st) {
    const m = {payment_succeeded:'b-ok',payment_failed:'b-err',payment_action_required:'b-warn',pending_admin_review:'b-warn',cash_paid:'b-ok',refunded:'b-warn'};
    return badge(st, m[st]||'b-pay');
  }
  function cust(j) { return ((j.firstName||'')+' '+(j.lastName||'')).trim()||j.email||j.id; }
  function dt(s) { if(!s) return '—'; try { return new Date(s).toLocaleString(); } catch { return s; } }

  async function loadChangeRequests(fetchOpts) {
    const started = SS ? SS.beginSourceLoad(changeRequestsMeta) : { meta: changeRequestsMeta, generation: (changeRequestsMeta.generation||0)+1 };
    changeRequestsMeta = started.meta;
    const generation = started.generation;
    if (sourceAbort.changeRequests) { try { sourceAbort.changeRequests.abort(); } catch (_) {} }
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    sourceAbort.changeRequests = ctrl;
    try {
      const q = new URLSearchParams({ action: 'list', status: requestsStatusFilter || 'pending' });
      if (requestsSyncVersion) q.set('ifSyncVersion', requestsSyncVersion);
      const data = await api('/.netlify/functions/admin-customer-requests?' + q.toString(), 'GET', null, Object.assign({ signal: ctrl && ctrl.signal }, fetchOpts || {}));
      if (SS && !SS.shouldApplyGeneration(changeRequestsMeta, generation)) return changeRequests;
      if (data.syncVersion) requestsSyncVersion = data.syncVersion;
      if (data.notModified === true) {
        lastRequestsNotModified = true;
        if (SS) changeRequestsMeta = SS.applySourceSuccess(changeRequestsMeta, generation).meta;
        else { changeRequestsMeta.hasLoaded = true; changeRequestsMeta.isLoading = false; changeRequestsMeta.error = null; changeRequestsMeta.lastSuccessAt = Date.now(); }
        return changeRequests;
      }
      lastRequestsNotModified = false;
      changeRequests = data.requests || [];
      if (SS) changeRequestsMeta = SS.applySourceSuccess(changeRequestsMeta, generation).meta;
      else { changeRequestsMeta.hasLoaded = true; changeRequestsMeta.isLoading = false; changeRequestsMeta.error = null; changeRequestsMeta.lastSuccessAt = Date.now(); }
      return changeRequests;
    } catch (e) {
      if (String(e && e.message) === 'aborted') return changeRequests;
      if (SS && !SS.shouldApplyGeneration(changeRequestsMeta, generation)) return changeRequests;
      if (SS) changeRequestsMeta = SS.applySourceFailure(changeRequestsMeta, generation, e && e.message).meta;
      else { changeRequestsMeta.isLoading = false; changeRequestsMeta.error = e && e.message; }
      throw e;
    }
  }

  function isOpenChangeRequest(r) {
    const st = String((r && r.status) || '').toLowerCase();
    return st === 'pending' || st === 'pending_approval' || st === 'needs_clarification' || st === 'awaiting_admin';
  }

  function pendingChangeRequestsOf(j) {
    if (!j) return [];
    if (Array.isArray(j.pendingChangeRequests) && j.pendingChangeRequests.length) {
      return j.pendingChangeRequests.filter(isOpenChangeRequest);
    }
    return (Array.isArray(j.changeRequests) ? j.changeRequests : []).filter(isOpenChangeRequest);
  }

  function pendingRequestCountOf(j) {
    if (!j) return 0;
    // Lean list rows expose a server count; full get_job may also include arrays.
    if (j.pendingChangeRequestCount != null && Number.isFinite(Number(j.pendingChangeRequestCount))) {
      const n = Math.max(0, Math.round(Number(j.pendingChangeRequestCount)));
      if (n > 0) return n;
    }
    const fromCr = pendingChangeRequestsOf(j).length;
    if (fromCr > 0) return fromCr;
    let legacy = 0;
    if (j.cancellationRequestStatus === 'requested') legacy += 1;
    if (j.rescheduledByClient) legacy += 1;
    if (j.addressChangedByClient || j.requestedAddress) legacy += 1;
    return legacy;
  }

  function renderEmbeddedChangeRequestCards(j) {
    const pending = pendingChangeRequestsOf(j);
    if (!pending.length) return '';
    return pending.map((r) => {
      const t = r.requestType || r.type;
      const prev = plainPrevious(r);
      const req = plainRequested(r);
      const rid = r.id || r.requestId;
      let actions = '';
      if (t === 'vehicle_remove_request') {
        actions = '<div class="actions" style="margin-top:10px">'+
          '<button type="button" class="btn sm emb-cr-approve" data-id="'+esc(rid)+'">Approve removal</button>'+
          '<button type="button" class="btn ghost sm emb-cr-reject" data-id="'+esc(rid)+'">Decline</button></div>';
      } else {
        actions = '<div class="actions" style="margin-top:10px">'+
          '<button type="button" class="btn sm emb-cr-approve" data-id="'+esc(rid)+'">Approve</button>'+
          '<button type="button" class="btn ghost sm emb-cr-reject" data-id="'+esc(rid)+'">Decline</button></div>';
      }
      return '<div class="req-box" data-emb-req="'+esc(rid)+'">'+
        '<strong>'+esc(requestTitle(r))+'</strong>'+
        '<div style="font-size:12px;color:var(--mu);margin:6px 0">'+esc(r.status||'pending')+' · '+dt(r.createdAt||r.submittedAt)+
        (r.vehicleId ? ' · vehicle <code>'+esc(r.vehicleId)+'</code>' : '')+'</div>'+
        (r.paymentImpact === 'payment_adjustment_required'
          ? '<div class="req-warn">Payment-impact warning: paid/partial booking — approval blocked until adjustment authority exists.</div>'
          : '')+
        (req.warnings||[]).map(w => '<div class="req-warn">⚠ '+esc(w)+'</div>').join('')+
        '<div class="req-cols">'+
          '<div class="req-col"><div class="req-col-h">CURRENT</div>'+dlRows(prev)+'</div>'+
          '<div class="req-col req-col-new"><div class="req-col-h">REQUESTED</div>'+dlRows(req.lines)+'</div>'+
        '</div>'+actions+'</div>';
    }).join('');
  }

  function bindEmbeddedChangeRequestActions(j) {
    const root = $('#dBody');
    if (!root) return;
    root.querySelectorAll('.emb-cr-approve').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('Approve this customer request?')) return;
        b.disabled = true;
        try {
          await decideChangeRequest(b.dataset.id, 'approve');
          toast('Request approved');
          await refreshAll();
          if (expandedJobId === j.id) openDrawer(j.id);
        } catch (e) {
          toast(e.message);
          b.disabled = false;
        }
      };
    });
    root.querySelectorAll('.emb-cr-reject').forEach((b) => {
      b.onclick = async () => {
        const note = prompt('Decline note (optional):');
        if (note === null) return;
        b.disabled = true;
        try {
          await decideChangeRequest(b.dataset.id, 'reject', note);
          toast('Request declined');
          await refreshAll();
          if (expandedJobId === j.id) openDrawer(j.id);
        } catch (e) {
          toast(e.message);
          b.disabled = false;
        }
      };
    });
  }

  function setApptPanel(panelId) {
    const root = $('#dBody');
    if (!root) return;
    const next = String(panelId || 'summary');
    if (jobDetailDirty && next !== jobDetailPanel) {
      if (!confirm('You have unsaved edits in this appointment. Switch panels and discard local changes?')) return;
      jobDetailDirty = false;
    }
    jobDetailPanel = next;
    root.querySelectorAll('.appt-panel-tab').forEach((tab) => {
      const on = tab.dataset.workspaceTab === next;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    root.querySelectorAll('.appt-panel').forEach((panel) => {
      const on = panel.dataset.apptPanel === next;
      panel.classList.toggle('on', on);
      if (on) panel.removeAttribute('hidden');
      else panel.setAttribute('hidden', 'hidden');
    });
  }

  /**
   * Unlock the appointment workspace for editing.
   *
   * Shared by "Edit details" in the sticky summary and "Edit" in the sticky
   * footer. Both said Edit; only one of them unlocked anything, which is why
   * operators reported that Edit does not edit.
   *
   * Local UI only — never refreshAll, never clear jobs/filters/selection.
   * Returns false when the source-state guard says a refresh is pending.
   */
  function enableApptEditMode() {
    const root = $('#dBody');
    if (!root) return false;
    if (SS && SS.editShouldTriggerRefreshAll && SS.editShouldTriggerRefreshAll()) return false;
    if (root.classList.contains('appt-edit-mode')) return true;
    root.classList.add('appt-edit-mode');
    root.classList.remove('appt-readonly');
    const workspace = root.querySelector('.appt-workspace');
    if (workspace) workspace.classList.remove('appt-readonly');
    root.querySelectorAll('input,select,textarea').forEach((el) => {
      el.setAttribute('data-edit-enabled', '1');
    });
    jobDetailDirty = true;
    toast('Edit mode on — save buttons are available in each panel');
    return true;
  }

  function bindApptWorkspace(j, defaultPanel) {
    const root = $('#dBody');
    if (!root) return;
    root.querySelectorAll('.appt-panel-tab').forEach((tab) => {
      tab.onclick = () => setApptPanel(tab.dataset.workspaceTab);
    });
    // Requests are a primary Admin destination, so they are not a workspace tab.
    // The above-the-fold alert and the More panel both open the in-job panel.
    root.querySelectorAll('[data-open-requests-panel]').forEach((btn) => {
      btn.onclick = () => setApptPanel('requests');
    });
    const editBtn = $('#dEnableEdit');
    if (editBtn) {
      // Edit toggles local UI only — must not call refreshAll or clear jobs/filters/selection.
      editBtn.onclick = () => { enableApptEditMode(); };
    }
    root.querySelectorAll('input,select,textarea').forEach((el) => {
      el.addEventListener('input', () => { jobDetailDirty = true; });
      el.addEventListener('change', () => { jobDetailDirty = true; });
    });
    setApptPanel(defaultPanel);
  }

  /** Booking authority may hold CRs the blob index missed — merge into global tab. */
  function mergeRequestsWithJobs(list) {
    const byId = new Map();
    (list || []).forEach((r) => {
      const id = String((r && (r.id || r.requestId)) || '').trim();
      if (id) byId.set(id, r);
    });
    (jobs || []).forEach((j) => {
      pendingChangeRequestsOf(j).forEach((r) => {
        const id = String(r.id || r.requestId || '').trim();
        if (!id) return;
        const prev = byId.get(id) || {};
        byId.set(id, {
          ...prev,
          ...r,
          id,
          bookingId: r.bookingId || j.id,
          customerName: r.customerName || cust(j),
          typeLabel: r.typeLabel || requestTitle(r),
        });
      });
    });
    return [...byId.values()].sort((a, b) =>
      String(b.createdAt || b.submittedAt || '').localeCompare(String(a.createdAt || a.submittedAt || ''))
    );
  }

  function updateRequestsTabBadge() {
    const n = mergeRequestsWithJobs(changeRequests).filter(isOpenChangeRequest).length;
    const badge = $('#requestsPendingBadge');
    const reqTab = [...document.querySelectorAll('#tabs .tab')].find((t) => t.getAttribute('data-tab') === 'requests');
    if (badge) {
      badge.textContent = String(n);
      badge.hidden = n < 1;
    }
    if (reqTab) {
      let tb = reqTab.querySelector('.tab-badge');
      if (!tb) {
        tb = document.createElement('span');
        tb.className = 'tab-badge';
        reqTab.appendChild(tb);
      }
      tb.textContent = String(n);
      tb.hidden = n < 1;
    }
  }

  async function decideChangeRequest(requestId, decision, adminNote, extra) {
    const request = mergeRequestsWithJobs(changeRequests).find((row) => row && row.id === requestId);
    const body = Object.assign({
      action: 'decide',
      requestId,
      decision,
      adminNote: adminNote || '',
      expectedBookingVersion: request && request.currentBookingVersion != null
        ? request.currentBookingVersion
        : (request && request.embeddedBookingVersion),
      expectedQuoteVersion: request && request.quoteVersion != null ? request.quoteVersion : undefined,
    }, extra || {});
    try {
      return await api('/.netlify/functions/admin-customer-requests', 'POST', body);
    } catch (e) {
      // Booking moved since the request — retry once with requote acceptance.
      if (decision === 'approve' && String(e.message || '') === 'version_conflict' && !body.acceptRequote) {
        if (confirm('Booking changed since this request. Approve using the updated quote?')) {
          return api('/.netlify/functions/admin-customer-requests', 'POST', Object.assign({}, body, {
            acceptRequote: true,
            expectedBookingVersion: e.data && e.data.actualBookingVersion != null
              ? e.data.actualBookingVersion
              : body.expectedBookingVersion,
          }));
        }
      }
      throw e;
    }
  }

  async function loadJobs(extra, fetchOpts) {
    const started = SS ? SS.beginSourceLoad(jobsMeta) : { meta: jobsMeta, generation: (jobsMeta.generation||0)+1 };
    jobsMeta = started.meta;
    const generation = started.generation;
    if (sourceAbort.jobs) { try { sourceAbort.jobs.abort(); } catch (_) {} }
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    sourceAbort.jobs = ctrl;
    try {
      const q = new URLSearchParams(extra||{});
      if (showTest) q.set('showTest', '1');
      if (jobsSyncVersion) q.set('ifSyncVersion', jobsSyncVersion);
      const data = await api('/.netlify/functions/admin-ops-jobs?'+q, 'GET', null, Object.assign({ signal: ctrl && ctrl.signal }, fetchOpts || {}));
      if (SS && !SS.shouldApplyGeneration(jobsMeta, generation)) return jobs;
      if (data.syncVersion) jobsSyncVersion = data.syncVersion;
      if (data.notModified === true) {
        lastJobsNotModified = true;
        if (SS) jobsMeta = SS.applySourceSuccess(jobsMeta, generation).meta;
        else { jobsMeta.hasLoaded = true; jobsMeta.isLoading = false; jobsMeta.error = null; jobsMeta.lastSuccessAt = Date.now(); }
        return jobs;
      }
      lastJobsNotModified = false;
      const incoming = Array.isArray(data.jobs) ? data.jobs : [];
      // Poll/list returns lean rows. Preserve in-memory full detail for the open job.
      if (expandedJobId && activeJob && activeJob.id === expandedJobId && activeJob._projection === 'admin_full') {
        const i = incoming.findIndex((j) => j && j.id === expandedJobId);
        if (i >= 0) {
          const lean = incoming[i];
          incoming[i] = Object.assign({}, activeJob, {
            jobStatus: lean.jobStatus,
            paymentWorkflowStatus: lean.paymentWorkflowStatus,
            financialPaymentStatus: lean.financialPaymentStatus,
            remainingCents: lean.remainingCents,
            amountDueApproved: lean.amountDueApproved,
            amountPaid: lean.amountPaid,
            approvedCents: lean.approvedCents,
            settledCents: lean.settledCents,
            approvedFinalAmount: lean.approvedFinalAmount,
            invoicePaid: lean.invoicePaid,
            assignedTechId: lean.assignedTechId,
            assignedTech: lean.assignedTech,
            assignedTechName: lean.assignedTechName,
            pendingChangeRequestCount: lean.pendingChangeRequestCount,
            customerChangePending: lean.customerChangePending,
            hasPendingVehicleRemoval: lean.hasPendingVehicleRemoval,
            cancellationRequestStatus: lean.cancellationRequestStatus,
            rescheduledByClient: lean.rescheduledByClient,
            addressChangedByClient: lean.addressChangedByClient,
            vehicleCount: lean.vehicleCount,
            vehicleLabel: lean.vehicleLabel,
            vehicle: lean.vehicle,
            package: lean.package,
            updatedAt: lean.updatedAt,
            _projection: 'admin_full',
          });
          activeJob = incoming[i];
        }
      }
      jobs = incoming;
      if (SS) jobsMeta = SS.applySourceSuccess(jobsMeta, generation).meta;
      else { jobsMeta.hasLoaded = true; jobsMeta.isLoading = false; jobsMeta.error = null; jobsMeta.lastSuccessAt = Date.now(); }
      return jobs;
    } catch (e) {
      if (String(e && e.message) === 'aborted') return jobs;
      if (SS && !SS.shouldApplyGeneration(jobsMeta, generation)) return jobs;
      if (SS) jobsMeta = SS.applySourceFailure(jobsMeta, generation, e && e.message).meta;
      else { jobsMeta.isLoading = false; jobsMeta.error = e && e.message; }
      throw e;
    }
  }

  async function loadTechs(fetchOpts, loadOpts) {
    const opts = loadOpts || {};
    const mode = opts.mode === 'management' ? 'management' : 'assign_options';
    const includeAssignedCounts = opts.includeAssignedCounts === true || mode === 'management';
    const started = SS ? SS.beginSourceLoad(techsMeta) : { meta: techsMeta, generation: (techsMeta.generation||0)+1 };
    techsMeta = started.meta;
    const generation = started.generation;
    if (sourceAbort.techs) { try { sourceAbort.techs.abort(); } catch (_) {} }
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    sourceAbort.techs = ctrl;
    try {
      const data = await api('/.netlify/functions/tech-accounts', 'POST', {
        action: 'list',
        mode: mode,
        includeAssignedCounts: includeAssignedCounts,
      }, Object.assign({ signal: ctrl && ctrl.signal }, fetchOpts || {}));
      if (SS && !SS.shouldApplyGeneration(techsMeta, generation)) return techs;
      techs = data.technicians || [];
      techsLoadMode = mode;
      techsCacheStale = false;
      if (SS) techsMeta = SS.applySourceSuccess(techsMeta, generation).meta;
      else { techsMeta.hasLoaded = true; techsMeta.isLoading = false; techsMeta.error = null; techsMeta.lastSuccessAt = Date.now(); }
      return techs;
    } catch (e) {
      if (String(e && e.message) === 'aborted') return techs;
      if (SS && !SS.shouldApplyGeneration(techsMeta, generation)) return techs;
      if (SS) techsMeta = SS.applySourceFailure(techsMeta, generation, e && e.message).meta;
      else { techsMeta.isLoading = false; techsMeta.error = e && e.message; }
      throw e;
    }
  }

  function invalidateTechsSessionCache() {
    // Force a fresh fetch on next ensure* call; keep last-good arrays until then.
    techsCacheStale = true;
  }

  function techsCacheSatisfies(mode) {
    if (techsCacheStale) return false;
    if (!techsMeta.hasLoaded) return false;
    if (!Array.isArray(techs)) return false;
    if (mode === 'management') return techsLoadMode === 'management';
    // assign_options can reuse management cache (superset).
    return techsLoadMode === 'assign_options' || techsLoadMode === 'management';
  }

  async function ensureTechsForAssign() {
    if (techsCacheSatisfies('assign_options')) return techs;
    if (techsInflight) return techsInflight;
    techsInflight = (async () => {
      try {
        await loadTechs(null, { mode: 'assign_options', includeAssignedCounts: false });
        return techs;
      } finally {
        techsInflight = null;
      }
    })();
    return techsInflight;
  }

  async function ensureTechsForManagement() {
    if (techsCacheSatisfies('management')) return techs;
    if (techsInflight) {
      await techsInflight;
      if (techsCacheSatisfies('management')) return techs;
    }
    techsInflight = (async () => {
      try {
        await loadTechs(null, { mode: 'management', includeAssignedCounts: true });
        return techs;
      } finally {
        techsInflight = null;
      }
    })();
    return techsInflight;
  }

  function assignedTechLabel(techId) {
    const id = String(techId || '');
    if (!id) return '';
    const fromCache = techs.find((t) => t && String(t.techId) === id);
    if (fromCache && fromCache.fullName) return fromCache.fullName;
    const fromJob = jobs.find((j) => j && String(j.assignedTechId || j.assignedTech || '') === id);
    return (fromJob && fromJob.assignedTechName) || id;
  }

  async function loadSettings() {
    const data = await api('/.netlify/functions/ops-settings');
    platformSettings = data.settings || {};
    platformAvailability = data.availability || null;
    return platformSettings;
  }

  async function loadAuctions() {
    const data = await api('/.netlify/functions/auction', 'POST', { action: 'list' });
    auctions = data.auctions || [];
    return auctions;
  }

  async function loadSubscriptions() {
    const data = await api('/.netlify/functions/subscriptions-ops', 'POST', { action: 'list' });
    subscriptions = data.subscriptions || [];
    return subscriptions;
  }

  function showLoadBanner(failures) {
    let bar = document.getElementById('loadBanner');
    if (!failures || !failures.length) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'loadBanner';
      bar.setAttribute('role', 'status');
      bar.style.cssText = 'position:sticky;top:0;z-index:50;background:#3a1212;border:1px solid #7f1d1d;color:#fecaca;padding:10px 16px;font-size:13px;line-height:1.5;max-width:100%;overflow-wrap:anywhere';
      document.body.insertBefore(bar, document.body.firstChild);
    }
    const sessionExpired = failures.some(f => /session expired/i.test(f.message || f));
    const lines = failures.map((f) => {
      const msg = typeof f === 'string' ? f : (f.message || '');
      const source = typeof f === 'object' && f.source ? f.source : '';
      const retryAttr = source ? ' data-retry-source="'+esc(source)+'"' : '';
      return '<div style="margin:4px 0">'+esc(msg)+
        (source ? ' <button type="button" class="loadRetrySource"'+retryAttr+' style="margin-left:8px;background:#7f1d1d;color:#fff;border:none;border-radius:5px;padding:3px 10px;cursor:pointer;min-height:44px">Retry '+esc(source)+'</button>' : '')+
        '</div>';
    }).join('');
    bar.innerHTML = lines +
      (sessionExpired
        ? ' — <a href="admin.html" style="color:#fff;text-decoration:underline">log in again</a>'
        : ' <button type="button" id="loadRetry" style="margin-left:8px;background:#7f1d1d;color:#fff;border:none;border-radius:5px;padding:3px 10px;cursor:pointer;min-height:44px">Retry all</button>');
    const rb = document.getElementById('loadRetry');
    if (rb) rb.onclick = () => refreshAll();
    bar.querySelectorAll('.loadRetrySource').forEach((btn) => {
      btn.onclick = () => retrySource(btn.getAttribute('data-retry-source'));
    });
  }

  function sourceFailureEntry(source, meta, label) {
    if (!meta || !meta.error) return null;
    const hasLoaded = !!meta.hasLoaded;
    const message = SS
      ? SS.refreshFailureMessage(label, hasLoaded)
      : (hasLoaded
        ? (label + ' could not be refreshed. Showing the last loaded data.')
        : (label + ' could not be loaded.'));
    return { source: source, message: message + ' (' + meta.error + ')', hasLoaded: hasLoaded };
  }

  async function retrySource(source) {
    const key = String(source || '');
    try {
      if (key === 'jobs' || key === 'bookings') {
        await loadJobs();
        renderOverview(); renderJobs(); renderAssign(); renderCompleted(); renderIssues(); renderEvents();
        maybeOpenPendingDirectLink();
      } else if (key === 'technicians' || key === 'techs') {
        await ensureTechsForAssign();
        renderTechs(); renderAssign(); renderOverview();
        refreshAssignSelectsInDom();
      } else if (key === 'requests' || key === 'changeRequests' || key === 'change requests') {
        await loadChangeRequests();
        renderRequests();
        updateRequestsTabBadge();
      } else {
        await refreshAll();
        return;
      }
      renderSourceBannersOnly();
    } catch (e) {
      renderSourceBannersOnly();
      toast((e && e.message) || 'Retry failed');
    }
  }

  function renderSourceBannersOnly() {
    const failures = [];
    const j = sourceFailureEntry('jobs', jobsMeta, 'Jobs');
    const t = sourceFailureEntry('technicians', techsMeta, 'Technicians');
    const c = sourceFailureEntry('requests', changeRequestsMeta, 'Change requests');
    if (j) failures.push(j);
    if (t) failures.push(t);
    if (c) failures.push(c);
    showLoadBanner(failures);
  }

  function maybeOpenPendingDirectLink() {
    if (!pendingOpenBookingId) return;
    const verdict = SS
      ? SS.resolveDirectLink(pendingOpenBookingId, jobs, jobsMeta)
      : (jobs.some((j) => j && j.id === pendingOpenBookingId) ? 'open'
        : (jobsMeta.hasLoaded && !jobsMeta.error ? 'missing' : 'wait'));
    if (verdict === 'open') {
      const id = pendingOpenBookingId;
      pendingOpenBookingId = null;
      openDrawer(id);
    } else if (verdict === 'missing') {
      const id = pendingOpenBookingId;
      pendingOpenBookingId = null;
      toast('Appointment not found: ' + id);
    }
    // 'wait' — keep pendingOpenBookingId for a later successful jobs load
  }

  function adminSyncPending() {
    const pendingJob = jobs.some((j) => {
      const pay = String(j && (j.paymentAttemptStatus || j.paymentWorkflowStatus) || '').toLowerCase();
      // awaiting_customer_payment is a steady unpaid state — do not force 2.5s
      // polling forever for every open balance. Boost only while a PI is live
      // or a webhook settle is in flight.
      return pendingRequestCountOf(j) > 0
        || ['creating','open','processing','pending_webhook'].includes(pay);
    });
    return pendingJob || mergeRequestsWithJobs(changeRequests).some(isOpenChangeRequest);
  }

  async function refreshAll(refreshContext) {
    const reason = typeof refreshContext === 'string'
      ? refreshContext
      : String((refreshContext && refreshContext.reason) || 'manual');
    const requestSignal = refreshContext && refreshContext.signal;
    // The shared controller aborts an obsolete request before a focus/online
    // refresh. Let that replacement start immediately instead of deduping it
    // onto the already-aborted promise.
    if (refreshAllInflight && !(requestSignal && refreshAllSignal && refreshAllSignal.aborted)) {
      return refreshAllInflight;
    }
    const syncOnly = ['poll','focus','visibility','online','payment_settlement'].includes(reason);
    const run = (async () => {
      // Jobs refresh must NOT pull the full technician roster (lazy-loaded on Assign / Techs tab).
      // Preserve any session-cached techs across jobs/requests refresh.
      lastJobsNotModified = false;
      lastRequestsNotModified = false;
      const [jobsR, settingsR, changeR] = await Promise.allSettled([
        loadJobs(null, { signal: requestSignal }),
        syncOnly ? Promise.resolve(platformSettings) : loadSettings(),
        loadChangeRequests({ signal: requestSignal }),
      ]);
      // Intentionally do NOT assign jobs=[], techs=[], or changeRequests=[] on rejection.
      // Intentionally do NOT call loadTechs() here.
      const bothUnchanged = syncOnly && lastJobsNotModified && lastRequestsNotModified
        && jobsR.status === 'fulfilled' && changeR.status === 'fulfilled';
      if (!bothUnchanged) {
        renderOverview(); renderJobs(); renderAssign(); renderCompleted(); renderIssues(); renderRequests(); renderEvents(); renderTechs();
        updateRequestsTabBadge();
        renderSettingsForm();
      }
      const failures = [];
      if (jobsR.status === 'rejected') {
        failures.push(sourceFailureEntry('jobs', jobsMeta, 'Jobs') || {
          source: 'jobs',
          message: 'Jobs could not be refreshed. Showing the last loaded data. (' + ((jobsR.reason && jobsR.reason.message) || jobsR.reason) + ')',
        });
      }
      if (settingsR.status === 'rejected') {
        failures.push({ source: '', message: 'settings (' + ((settingsR.reason && settingsR.reason.message) || settingsR.reason) + ')' });
      }
      if (changeR.status === 'rejected') {
        failures.push(sourceFailureEntry('requests', changeRequestsMeta, 'Change requests') || {
          source: 'requests',
          message: 'Change requests could not be refreshed. Showing the last loaded data. (' + ((changeR.reason && changeR.reason.message) || changeR.reason) + ')',
        });
      }
      // Successful sources clear their own error inside loaders; rebuild banner from current meta + settings.
      // Technicians errors only appear after an explicit tech load attempt (Assign / Techs tab / Retry).
      const fromMeta = [];
      const j = sourceFailureEntry('jobs', jobsMeta, 'Jobs');
      const t = sourceFailureEntry('technicians', techsMeta, 'Technicians');
      const c = sourceFailureEntry('requests', changeRequestsMeta, 'Change requests');
      if (j) fromMeta.push(j);
      if (t && techsMeta.hasLoaded) fromMeta.push(t);
      if (c) fromMeta.push(c);
      failures.filter((f) => f && !f.source).forEach((f) => fromMeta.push(f));
      showLoadBanner(fromMeta.length ? fromMeta : failures.filter(Boolean));
      maybeOpenPendingDirectLink();
      // Keep selected job open when it still exists locally after a partial failure.
      if (expandedJobId && jobs.some((j) => j && j.id === expandedJobId) && activeJob) {
        /* leave drawer as-is — renderJobs preserves expansion when the job remains in memory */
      }
      const syncFailure = jobsR.status === 'rejected' ? jobsR.reason
        : (changeR.status === 'rejected' ? changeR.reason : null);
      return {
        ok: !syncFailure,
        error: syncFailure && (syncFailure.message || String(syncFailure)),
        status: syncFailure && (syncFailure.status || syncFailure.statusCode || 0),
        retryAfterMs: syncFailure && syncFailure.retryAfterMs,
        pending: adminSyncPending(),
        notModified: bothUnchanged,
        changed: !bothUnchanged,
      };
    })();
    refreshAllInflight = run;
    refreshAllSignal = requestSignal || null;
    try {
      return await run;
    } finally {
      if (refreshAllInflight === run) {
        refreshAllInflight = null;
        refreshAllSignal = null;
      }
    }
  }

  async function refreshRequestsTab() {
    const el = $('#requestsList');
    const hadCache = !!(changeRequestsMeta.hasLoaded && changeRequests && changeRequests.length);
    if (el && !hadCache) el.innerHTML = '<div class="empty">Loading customer requests…</div>';
    try {
      await loadChangeRequests();
      renderRequests();
      renderSourceBannersOnly();
    } catch (e) {
      if (hadCache) {
        renderRequests();
        if (el) {
          const note = document.createElement('div');
          note.className = 'req-warn';
          note.style.marginBottom = '10px';
          note.textContent = (SS ? SS.refreshFailureMessage('Change requests', true) : 'Change requests could not be refreshed. Showing the last loaded data.') + ' (' + ((e && e.message) || 'error') + ')';
          el.insertBefore(note, el.firstChild);
        }
      } else if (el) {
        el.innerHTML = '<div class="empty">Could not load customer requests: ' + esc(e.message) + '</div>';
      }
      renderSourceBannersOnly();
    }
  }

  async function refreshAuctionsTab() {
    try { await loadAuctions(); renderAuctions(); } catch(e) { $('#auctionsList').innerHTML='<div class="empty">'+esc(e.message)+'</div>'; }
  }

  async function refreshSubsTab() {
    try { await loadSubscriptions(); renderSubscriptions(); } catch(e) { $('#subsList').innerHTML='<div class="empty">'+esc(e.message)+'</div>'; }
  }

  function renderSettingsForm() {
    const s = platformSettings;
    $('#setAutoConfirm').checked = !!s.autoConfirmAppointments;
    $('#setAutoAuction').checked = !!s.autoPostToAuctionOnConfirm;
    $('#setDispatch').value = s.dispatchMode || 'manual';
    $('#setBidPct').value = s.bidMaxPercent != null ? s.bidMaxPercent : 85;
    $('#setBidOverride').value = s.bidMaxOverride != null ? s.bidMaxOverride : '';
    $('#setBidWin').value = s.bidWindowMinutes != null ? s.bidWindowMinutes : 60;
    $('#setBidWinRv').value = s.bidWindowMinutesBoatRv != null ? s.bidWindowMinutesBoatRv : 90;
    $('#setMinRating').value = s.minTechRatingToBid != null ? s.minTechRatingToBid : 0;
    $('#setCompound').checked = s.requireCompoundExperience !== false;
    renderAvailabilityForm();
  }

  function renderAvailabilityForm() {
    const a = platformAvailability || {};
    const tz = $('#avTimezone');
    const mode = $('#avWeekendMode');
    const eff = $('#avEffectiveDate');
    const hint = $('#avModeHint');
    if (!tz || !mode) return;
    tz.value = a.businessTimezone || 'America/New_York';
    mode.value = a.weekendMode || 'legacy';
    eff.value = a.supervisedEffectiveDate || '';
    if (hint) {
      if ((a.weekendMode || 'legacy') === 'legacy') {
        hint.textContent = 'Legacy mode active: Saturdays remain bookable with default weekend slots; Sundays stay closed unless you add an override.';
      } else if (!a.supervisedEffectiveDate) {
        hint.textContent = 'Supervised mode needs an effective date before it can activate.';
      } else {
        hint.textContent = 'Supervised mode configured. Activation on/after ' + a.supervisedEffectiveDate +
          ' closes weekends by default; only enabled overrides are bookable. Not auto-activated by deploy.';
      }
    }
    const list = $('#avOverridesList');
    if (list) {
      const ov = a.dateOverrides || {};
      const keys = Object.keys(ov).sort();
      if (!keys.length) {
        list.innerHTML = '<div class="empty" style="padding:8px 0">No date overrides yet.</div>';
      } else {
        list.innerHTML = '<div class="sec-title">Saved overrides</div>' + keys.map((d) => {
          const o = ov[d];
          return '<div style="padding:4px 0;border-bottom:1px solid rgba(255,255,255,.06)">' +
            '<strong>' + esc(d) + '</strong> · ' + (o.enabled ? 'open' : 'closed') +
            ' · cap ' + esc(o.capacity || 1) +
            (o.arrivalWindows ? ' · ' + esc((o.arrivalWindows || []).join(', ')) : '') +
            (o.note ? ' · note: ' + esc(o.note) : '') +
            '</div>';
        }).join('');
      }
    }
  }

  function resolveOverrideWindows() {
    const mode = $('#avOverrideWindows')?.value || 'sat';
    if (mode === 'weekday') return ['8:00 AM', '10:00 AM', '12:00 PM', '2:00 PM'];
    if (mode === 'weekday_late') return ['8:00 AM', '10:00 AM', '12:00 PM', '2:00 PM', '4:00 PM'];
    if (mode === 'sat_late') return ['8:00 AM', '10:00 AM', '4:00 PM'];
    if (mode === 'custom') {
      return String($('#avOverrideCustom')?.value || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return ['8:00 AM', '10:00 AM'];
  }

  function renderAuctions() {
    const el = $('#auctionsList');
    if (!auctions.length) { el.innerHTML='<div class="empty">No open auctions. Confirm a job and click Post to Auction, or enable auto-post in Settings.</div>'; return; }
    el.innerHTML = auctions.map(a => {
      const j = a.job || {};
      const bids = (a.bids||[]).slice().sort((x,y)=>x.amount-y.amount);
      const bidRows = bids.length ? bids.map((b,i)=>'<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0;color:'+(i===0?'var(--ok)':'var(--mu)')+'"><span>'+(i===0?'🏆 ':'')+esc(b.techName||b.techId)+'</span><span>$'+b.amount+'</span></div>').join('') : '<div style="font-size:12px;color:var(--mu)">No bids yet</div>';
      return '<div class="req-box" data-job="'+esc(a.jobId)+'"><h5>'+esc(a.jobId)+' · '+esc(j.package||'—')+'</h5>'+
        '<div style="font-size:12px;color:var(--mu);margin-bottom:8px">'+esc(j.vehicle||'')+' · '+esc(j.date||'')+' · '+esc(j.area||'')+
        ' · Max bid: '+(a.bidMax!=null?'$'+a.bidMax:'—')+' · Closes: '+dt(a.closesAt)+' · Status: '+esc(a.status)+'</div>'+
        bidRows+
        '<div class="actions" style="margin-top:10px">'+
        (a.winner?'<button type="button" class="btn sm auc-assign" data-id="'+esc(a.jobId)+'">Assign winner ('+esc(a.winner.techName)+' $'+a.winner.amount+')</button>':'')+
        '<button type="button" class="btn ghost sm auc-extend" data-id="'+esc(a.jobId)+'">+30 min</button>'+
        (a.status==='open'?'<button type="button" class="btn ghost sm auc-close" data-id="'+esc(a.jobId)+'">Close auction</button>':'')+
        '<button type="button" class="btn ghost sm auc-open" data-id="'+esc(a.jobId)+'">Open job</button></div></div>';
    }).join('');
    el.querySelectorAll('.auc-assign').forEach(b => b.onclick = () => auctionAction(b.dataset.id, 'assign_winner'));
    el.querySelectorAll('.auc-extend').forEach(b => b.onclick = () => auctionAction(b.dataset.id, 'extend_deadline', { extraMinutes: 30 }));
    el.querySelectorAll('.auc-close').forEach(b => b.onclick = () => auctionAction(b.dataset.id, 'close'));
    el.querySelectorAll('.auc-open').forEach(b => b.onclick = () => openDrawer(b.dataset.id));
  }

  async function auctionAction(jobId, action, extra) {
    try {
      if (action === 'assign_winner') await jobAction(jobId, 'assign_auction_winner', extra||{});
      else await api('/.netlify/functions/auction', 'POST', { action, job: jobId, ...extra });
      toast('Auction updated');
      await refreshAll();
      await refreshAuctionsTab();
    } catch(e) { toast('Auction failed: '+e.message); }
  }

  function renderSubscriptions() {
    const el = $('#subsList');
    const active = subscriptions.filter(s => s.status === 'active');
    if (!active.length) { el.innerHTML='<div class="empty">No active subscriptions. Create one for recurring customers.</div>'; return; }
    el.innerHTML = '<table class="tbl"><thead><tr><th>Customer</th><th>Plan</th><th>Interval</th><th>Price</th><th>Next visit</th><th>Actions</th></tr></thead><tbody>'+
      active.map(s => '<tr><td>'+esc(s.customerName||s.email)+'<div class="tech-meta">'+esc(s.email)+'</div></td>'+
      '<td>'+esc(s.planName)+'</td><td>'+s.intervalMonths+' mo</td><td>$'+s.price+'</td><td>'+esc(s.nextVisitDate||'—')+'</td>'+
      '<td><button type="button" class="btn ghost sm sub-cancel" data-id="'+esc(s.id)+'">Cancel</button></td></tr>').join('')+
      '</tbody></table>';
    el.querySelectorAll('.sub-cancel').forEach(b => b.onclick = async () => {
      if (!confirm('Cancel this subscription?')) return;
      try { await api('/.netlify/functions/subscriptions-ops','POST',{action:'cancel',id:b.dataset.id}); toast('Cancelled'); refreshSubsTab(); } catch(e){ toast(e.message); }
    });
  }

  function techOptions(sel) {
    const selected = String(sel || '');
    let html = '<option value="">— Unassigned —</option>';
    if (techsMeta.hasLoaded && Array.isArray(techs)) {
      const active = techs.filter((t) => t && t.active !== false);
      html += active.map((t) =>
        '<option value="'+esc(t.techId)+'"'+(selected === String(t.techId) ? ' selected' : '')+'>'+esc(t.fullName)+'</option>'
      ).join('');
      // Keep an inactive / missing assigned tech visible.
      if (selected && !active.some((t) => String(t.techId) === selected)) {
        html += '<option value="'+esc(selected)+'" selected>'+esc(assignedTechLabel(selected))+'</option>';
      }
      return html;
    }
    if (selected) {
      html += '<option value="'+esc(selected)+'" selected>'+esc(assignedTechLabel(selected))+'</option>';
    }
    if (techsMeta.isLoading) {
      html += '<option value="" disabled>Loading technicians…</option>';
    } else if (techsMeta.error && !techsMeta.hasLoaded) {
      html += '<option value="" disabled>Technicians unavailable</option>';
    } else {
      html += '<option value="" disabled>Open to load technicians…</option>';
    }
    return html;
  }

  function assignStatusHtml() {
    if (techsMeta.isLoading) {
      return '<span class="assign-tech-status">Loading technicians…</span>';
    }
    if (techsMeta.error && !techsMeta.hasLoaded) {
      return '<span class="assign-tech-status is-error">Technicians could not be loaded. <button type="button" class="btn ghost sm assignRetry" style="min-height:44px">Retry</button></span>';
    }
    return '';
  }

  function bindAssignSelect(sel) {
    if (!sel) return;
    const kick = () => { ensureAssignOptionsLoaded(sel); };
    sel.addEventListener('mousedown', kick);
    sel.addEventListener('focus', kick);
    sel.addEventListener('touchstart', kick, { passive: true });
    sel.onchange = () => onAssign(sel.dataset.id, sel.value);
    sel.addEventListener('click', (e) => e.stopPropagation());
  }

  async function ensureAssignOptionsLoaded(selEl) {
    if (techsCacheSatisfies('assign_options')) return;
    const cells = [];
    if (selEl && selEl.parentElement) cells.push(selEl.parentElement);
    document.querySelectorAll('.job-assign-cell, td').forEach((td) => {
      if (td.querySelector && td.querySelector('.assignSel, .assignSel2, #dAssign')) cells.push(td);
    });
    cells.forEach((cell) => {
      let note = cell.querySelector('.assign-tech-status');
      if (!note) {
        note = document.createElement('span');
        note.className = 'assign-tech-status';
        cell.appendChild(note);
      }
      note.classList.remove('is-error');
      note.textContent = 'Loading technicians…';
    });
    // Re-render selects into loading state without wiping jobs.
    try {
      await ensureTechsForAssign();
      refreshAssignSelectsInDom();
      renderOverview();
    } catch (e) {
      cells.forEach((cell) => {
        let note = cell.querySelector('.assign-tech-status');
        if (!note) {
          note = document.createElement('span');
          note.className = 'assign-tech-status is-error';
          cell.appendChild(note);
        }
        note.className = 'assign-tech-status is-error';
        note.innerHTML = 'Technicians could not be loaded. <button type="button" class="btn ghost sm assignRetry" style="min-height:44px">Retry</button>';
        const btn = note.querySelector('.assignRetry');
        if (btn) btn.onclick = (ev) => {
          ev.stopPropagation();
          techsCacheStale = true;
          ensureAssignOptionsLoaded(selEl);
        };
      });
      // Do not refresh Jobs/Requests/Payment; keep selected job open.
    }
  }

  function refreshAssignSelectsInDom() {
    document.querySelectorAll('select.assignSel, select.assignSel2').forEach((sel) => {
      const cur = sel.value;
      const bookingId = sel.dataset.id;
      const job = jobs.find((j) => j && j.id === bookingId);
      const preferred = cur || (job && (job.assignedTechId || job.assignedTech)) || '';
      sel.innerHTML = techOptions(preferred);
      sel.value = preferred;
      const cell = sel.parentElement;
      if (cell) {
        cell.querySelectorAll('.assign-tech-status').forEach((n) => n.remove());
        const extra = assignStatusHtml();
        if (extra) cell.insertAdjacentHTML('beforeend', extra);
        const retry = cell.querySelector('.assignRetry');
        if (retry) retry.onclick = (ev) => {
          ev.stopPropagation();
          techsCacheStale = true;
          ensureAssignOptionsLoaded(sel);
        };
      }
    });
    const da = $('#dAssign');
    if (da && activeJob) {
      const preferred = activeJob.assignedTechId || activeJob.assignedTech || da.value || '';
      da.innerHTML = techOptions(preferred);
      da.value = preferred;
    }
  }

  function renderOverview() {
    const c = { total:jobs.length, pending:0, assigned:0, active:0, review:0, issues:0, unassigned:0 };
    jobs.forEach(j => {
      const s = j.jobStatus;
      if (s==='pending_review'||s==='confirmed') c.pending++;
      if (s==='assigned'||s==='accepted') c.assigned++;
      if (['en_route','arrived','in_progress'].includes(s)) c.active++;
      if (s==='completed_pending_admin_review') c.review++;
      if (s==='issue_reported') c.issues++;
      if (!j.assignedTechId && !j.assignedTech) c.unassigned++;
    });
    const techStat = techsMeta.hasLoaded ? techs.length : '—';
    $('#overviewStats').innerHTML = [
      ['Total jobs',c.total],['Pending / confirmed',c.pending],['Assigned',c.assigned],
      ['In field',c.active],['Awaiting review',c.review],['Issues',c.issues],['Unassigned',c.unassigned],['Technicians',techStat]
    ].map(([l,v])=>'<div class="card"><h3>'+l+'</h3><div class="stat">'+v+'</div></div>').join('');
  }

  function jobVehicles(j) {
    return Array.isArray(j && j.vehicles) ? j.vehicles.filter(v => v && typeof v === 'object') : [];
  }

  function vehicleSearchHaystack(j) {
    const parts = [j.vehicle, j.vehicleLabel, j.package, j.vehicleCount];
    jobVehicles(j).forEach(v => {
      parts.push(v.vehicleLabel, v.year, v.make, v.model, v.packageName, v.pkgName, v.category, v.cat);
      (Array.isArray(v.addons) ? v.addons : []).forEach(a => parts.push(a && a.name));
    });
    return parts.filter(Boolean).join(' ');
  }

  function jobsVehicleSummary(j) {
    if (j && j.vehicleCount != null && Number(j.vehicleCount) > 1) {
      return Number(j.vehicleCount) + ' vehicles';
    }
    if (j && j.vehicleLabel) return j.vehicleLabel;
    const vehs = jobVehicles(j);
    if (vehs.length > 1) return vehs.length + ' vehicles';
    if (vehs.length === 1) {
      const label = vehs[0].vehicleLabel || [vehs[0].year, vehs[0].make, vehs[0].model].filter(Boolean).join(' ').trim();
      if (label) return label;
    }
    return j.vehicleLabel || j.vehicle || '—';
  }

  function jobsBalanceLabel(j) {
    if (j && j.remainingCents != null && Number.isFinite(Number(j.remainingCents))) {
      return '$' + (Number(j.remainingCents) / 100).toFixed(2);
    }
    if (j && j.amountDueApproved != null && Number.isFinite(Number(j.amountDueApproved))) {
      return '$' + Number(j.amountDueApproved).toFixed(2);
    }
    return '—';
  }

  function jobsDateTimeLabel(j) {
    const d = j.confirmedDate || j.preferredDate || '';
    const t = j.confirmedTime || j.confirmedTimeWindow || j.preferredTime || '';
    const parts = [d, t].filter(Boolean);
    return parts.length ? parts.join(' · ') : '—';
  }

  function ensureJobsTab() {
    const panel = $('#p-jobs');
    if (panel && !panel.classList.contains('on')) {
      document.querySelectorAll('.tab').forEach(t => { t.classList.remove('on'); t.setAttribute('aria-selected','false'); });
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('on'));
      const tab = [...document.querySelectorAll('#tabs .tab')].find(t => t.dataset && t.dataset.tab === 'jobs');
      if (tab) {
        tab.classList.add('on');
        tab.setAttribute('aria-selected','true');
      }
      panel.classList.add('on');
    }
  }

  function getActiveDetailRow() {
    return document.getElementById('activeJobDetailRow');
  }

  function parkActiveDetailRow() {
    const row = getActiveDetailRow();
    const holder = $('#jobDetailHolder');
    if (row && holder) {
      const tb = holder.querySelector('tbody') || holder;
      if (row.parentNode !== tb) tb.appendChild(row);
      row.hidden = true;
    }
  }

  function placeActiveDetailRow(jobId) {
    const row = getActiveDetailRow();
    const summary = document.querySelector('#jobsTable tbody tr.job-row[data-id="'+CSS.escape(jobId)+'"]');
    if (!row || !summary) {
      parkActiveDetailRow();
      return false;
    }
    const td = row.querySelector('td');
    if (td) td.colSpan = JOBS_COLSPAN;
    summary.insertAdjacentElement('afterend', row);
    row.hidden = false;
    return true;
  }

  function isInteractiveToggleTarget(el) {
    if (!el || !el.closest) return false;
    return !!el.closest('button, a, input, textarea, select, label, .assignSel, .job-detail-row');
  }

  function collapseJobDetail() {
    expandedJobId = null;
    activeJob = null;
    drawerAddonData = null;
    const stickyBar = $('#dStickyActions');
    if (stickyBar) stickyBar.hidden = true;
    parkActiveDetailRow();
    document.querySelectorAll('#jobsTable tbody tr.job-row.is-expanded').forEach(tr => {
      tr.classList.remove('is-expanded');
      const btn = tr.querySelector('.job-chevron');
      if (btn) {
        btn.setAttribute('aria-expanded', 'false');
        btn.textContent = '▸';
      }
    });
  }

  function markExpandedRow(jobId) {
    document.querySelectorAll('#jobsTable tbody tr.job-row').forEach(tr => {
      const on = tr.dataset.id === jobId;
      tr.classList.toggle('is-expanded', on);
      const btn = tr.querySelector('.job-chevron');
      if (btn) {
        btn.setAttribute('aria-expanded', on ? 'true' : 'false');
        btn.textContent = on ? '▾' : '▸';
      }
    });
  }

  async function toggleJobExpand(jobId) {
    if (!jobId) return;
    if (expandedJobId === jobId) {
      collapseJobDetail();
      return;
    }
    await openDrawer(jobId);
  }

  // Review queue buckets. Business logic is untouched — these only group the
  // jobStatus values the server already returns.
  const NEEDS_ACTION_STATUSES = ['issue_reported','completed_pending_admin_review','completed_pending_payment','reopened'];
  const CONFIRMED_STATUSES = ['confirmed','assigned','accepted','en_route','arrived','in_progress'];
  const QUEUE_BUCKETS = [
    { id:'all', label:'All', match: () => true },
    { id:'pending_review', label:'Pending Review', match: j => j.jobStatus === 'pending_review' },
    { id:'needs_action', label:'Needs Action', match: j => NEEDS_ACTION_STATUSES.includes(j.jobStatus) },
    { id:'confirmed', label:'Confirmed', match: j => CONFIRMED_STATUSES.includes(j.jobStatus) },
  ];
  let queueFilter = 'all';

  /** High-priority marker: something is blocked on a human decision. */
  function jobNeedsAttention(j) {
    if (!j) return false;
    if (j.jobStatus === 'issue_reported') return true;
    if (j.jobStatus === 'completed_pending_admin_review') return true;
    if (j.customerChangePending) return true;
    if (pendingRequestCountOf(j) > 0) return true;
    if (j.cancellationRequestStatus === 'requested') return true;
    if (j.jobStatus === 'completed_pending_payment' && Number(j.remainingCents || 0) > 0) return true;
    return false;
  }

  function renderQueueFilters() {
    const host = $('#jobsQueueFilters');
    if (!host) return;
    host.innerHTML = QUEUE_BUCKETS.map(b => {
      const count = jobs.filter(b.match).length;
      const on = queueFilter === b.id;
      return '<button type="button" class="queue-chip" data-queue="'+esc(b.id)+'" aria-pressed="'+(on?'true':'false')+'">'+
        esc(b.label)+'<span class="qc-count">'+count+'</span></button>';
    }).join('');
    host.querySelectorAll('[data-queue]').forEach(btn => {
      btn.onclick = () => {
        queueFilter = btn.dataset.queue;
        renderQueueFilters();
        renderJobs();
      };
    });
  }

  function filterJobs(search, status) {
    let list = jobs;
    const bucket = QUEUE_BUCKETS.find(b => b.id === queueFilter);
    if (bucket) list = list.filter(bucket.match);
    if (status) list = list.filter(j => j.jobStatus === status);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(j => [j.id,j.firstName,j.lastName,j.phone,j.email,j.assignedTechName,vehicleSearchHaystack(j)].join(' ').toLowerCase().includes(q));
    }
    return list;
  }

  // Admin Lite Payments: a read-only projection over the lean Jobs rows already in
  // memory. It never fetches — money comes from the same financialProjection fields
  // the Jobs list uses, so Admin has exactly one money authority.
  function centsLabel(cents, fallbackDollars) {
    if (cents != null && Number.isFinite(Number(cents))) return '$' + (Number(cents) / 100).toFixed(2);
    if (fallbackDollars != null && Number.isFinite(Number(fallbackDollars))) return '$' + Number(fallbackDollars).toFixed(2);
    return '—';
  }

  function paymentIsSettled(j) {
    return !!(j && (j.invoicePaid || j.financialPaymentStatus === 'paid'
      || j.paymentWorkflowStatus === 'payment_succeeded' || j.paymentWorkflowStatus === 'cash_paid'
      || (Number(j.remainingCents || 0) === 0 && Number(j.settledCents || 0) > 0)));
  }

  function renderPayments() {
    const tb = $('#paymentsTable tbody');
    if (!tb) return;
    const search = ($('#paymentsSearch') && $('#paymentsSearch').value.trim().toLowerCase()) || '';
    const state = ($('#paymentsStatus') && $('#paymentsStatus').value) || '';
    const stale = !!(jobsMeta && jobsMeta.error && jobsMeta.hasLoaded);
    const list = jobs.filter((j) => {
      if (!j || j.archived) return false;
      if (search) {
        const hay = [j.id, j.bookingId, j.firstName, j.lastName, j.email, j.phone]
          .filter(Boolean).join(' ').toLowerCase();
        if (hay.indexOf(search) === -1) return false;
      }
      if (state === 'due') return !paymentIsSettled(j) && Number(j.remainingCents || 0) > 0;
      if (state === 'paid') return paymentIsSettled(j);
      return true;
    });
    if (!list.length) {
      tb.innerHTML = '<tr><td colspan="8" class="empty">No payments found</td></tr>';
      return;
    }
    const banner = stale
      ? '<tr><td colspan="8" style="background:rgba(245,158,11,.1);color:var(--warn);font-size:12px;padding:8px 12px">'+
        esc(SS ? SS.refreshFailureMessage('Jobs', true) : 'Payments could not be refreshed. Showing the last loaded data.')+
        '</td></tr>'
      : '';
    tb.innerHTML = banner + list.map((j) => {
      const name = [j.firstName, j.lastName].filter(Boolean).join(' ') || '—';
      const settled = paymentIsSettled(j);
      return '<tr data-payment-row data-id="'+esc(j.id)+'">'+
        '<td data-label="Customer">'+esc(name)+'</td>'+
        '<td data-label="Booking">'+esc(j.bookingId || j.id || '—')+'</td>'+
        '<td data-label="Date">'+esc(jobsDateTimeLabel(j))+'</td>'+
        '<td data-label="Payment">'+payBadge(settled ? 'payment_succeeded' : j.paymentWorkflowStatus)+'</td>'+
        '<td data-label="Approved">'+esc(centsLabel(j.approvedCents, j.approvedFinalAmount))+'</td>'+
        '<td data-label="Paid">'+esc(centsLabel(j.settledCents, j.amountPaid))+'</td>'+
        '<td data-label="Balance">'+esc(jobsBalanceLabel(j))+'</td>'+
        '<td><button type="button" class="btn ghost sm" data-payment-open="'+esc(j.id)+'" style="min-height:44px">Open job</button></td>'+
        '</tr>';
    }).join('');
  }

  function renderJobs() {
    const search = $('#jobsSearch').value.trim();
    const status = $('#jobsStatus').value;
    const list = filterJobs(search, status);
    const tb = $('#jobsTable tbody');
    renderQueueFilters();
    parkActiveDetailRow();
    const jobsStale = !!(jobsMeta && jobsMeta.error && jobsMeta.hasLoaded);
    const jobsInitialFail = !!(jobsMeta && jobsMeta.error && !jobsMeta.hasLoaded);
    if (!list.length) {
      let emptyMsg = 'No jobs found';
      if (jobsInitialFail) {
        emptyMsg = 'Jobs could not be loaded. Use Retry to try again.';
      } else if (jobsStale && !jobs.length) {
        emptyMsg = 'Jobs could not be refreshed and no local data is available.';
      }
      tb.innerHTML = '<tr><td colspan="'+JOBS_COLSPAN+'" class="empty">'+esc(emptyMsg)+
        (jobsStale || jobsInitialFail
          ? ' <button type="button" class="btn ghost sm jobsRetryBtn" style="min-height:44px;margin-left:8px">Retry jobs</button>'
          : '')+
        '</td></tr>';
      const retryBtn = tb.querySelector('.jobsRetryBtn');
      if (retryBtn) retryBtn.onclick = () => retrySource('jobs');
      // Only collapse when the selected job is truly gone from memory — not on a failed refresh
      // that still holds last-good rows filtered out of the current view.
      if (expandedJobId && !jobs.some((j) => j && j.id === expandedJobId)) collapseJobDetail();
      return;
    }
    const stillVisible = expandedJobId && list.some(j => j.id === expandedJobId);
    if (expandedJobId && !stillVisible && !jobs.some((j) => j && j.id === expandedJobId)) collapseJobDetail();
    // If filters hide the selected job but it still exists, keep it open (do not wipe).
    let staleBanner = '';
    if (jobsStale) {
      staleBanner = '<tr class="job-stale-banner"><td colspan="'+JOBS_COLSPAN+'" style="background:rgba(245,158,11,.1);color:var(--warn);font-size:12px;padding:8px 12px">'+
        esc(SS ? SS.refreshFailureMessage('Jobs', true) : 'Jobs could not be refreshed. Showing the last loaded data.')+
        ' <button type="button" class="btn ghost sm jobsRetryBtn" style="min-height:44px;margin-left:8px">Retry jobs</button></td></tr>';
    }
    tb.innerHTML = staleBanner + list.map(j => {
      const expanded = expandedJobId === j.id;
      const warn = jobNeedsAttention(j)
        ? '<span class="job-warn" title="Needs attention" aria-label="Needs attention">&#9888;</span>'
        : '';
      const pendingN = pendingRequestCountOf(j);
      const reqBadge = pendingN > 0
        ? '<span class="job-req-badge">' + pendingN + ' request' + (pendingN === 1 ? '' : 's') + ' pending</span>'
        : '';
      return '<tr class="job-row'+(expanded?' is-expanded':'')+'" data-id="'+esc(j.id)+'" tabindex="0" role="button" aria-expanded="'+(expanded?'true':'false')+'">'+
        '<td class="job-cell-expand"><button type="button" class="job-chevron" data-id="'+esc(j.id)+'" aria-expanded="'+(expanded?'true':'false')+'" aria-controls="activeJobDetailPanel" title="Expand job details">'+(expanded?'▾':'▸')+'</button></td>'+
        '<td class="job-cell-customer">'+warn+esc(cust(j))+reqBadge+'</td><td data-label="Vehicle">'+esc(jobsVehicleSummary(j))+'</td>'+
        '<td data-label="When">'+esc(jobsDateTimeLabel(j))+'</td>'+
        '<td data-label="Status">'+jobBadge(j.jobStatus)+'</td><td data-label="Payment">'+payBadge(j.paymentWorkflowStatus)+'</td>'+
        '<td data-label="Balance">'+esc(jobsBalanceLabel(j))+'</td>'+
        '<td data-label="Tech">'+esc(j.assignedTechName||'—')+'</td>'+
        '<td class="job-assign-cell"><select class="assignSel" data-id="'+esc(j.id)+'">'+techOptions(j.assignedTechId||j.assignedTech)+'</select>'+assignStatusHtml()+'</td>'+
      '</tr>';
    }).join('');
    tb.querySelectorAll('.assignSel').forEach(sel => bindAssignSelect(sel));
    tb.querySelectorAll('.assignRetry').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        techsCacheStale = true;
        ensureAssignOptionsLoaded(btn.closest('td') && btn.closest('td').querySelector('select'));
      };
    });
    tb.querySelectorAll('.job-chevron').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        toggleJobExpand(btn.dataset.id);
      });
    });
    tb.querySelectorAll('tr.job-row[data-id]').forEach(tr => {
      tr.addEventListener('click', e => {
        if (isInteractiveToggleTarget(e.target)) return;
        toggleJobExpand(tr.dataset.id);
      });
      tr.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        if (isInteractiveToggleTarget(e.target) && e.target !== tr) return;
        e.preventDefault();
        toggleJobExpand(tr.dataset.id);
      });
    });
    tb.querySelectorAll('.jobsRetryBtn').forEach((btn) => {
      btn.onclick = (e) => { e.stopPropagation(); retrySource('jobs'); };
    });
    if (stillVisible) placeActiveDetailRow(expandedJobId);
  }

  function renderAssign() {
    const list = jobs.filter(j => !j.assignedTechId && !j.assignedTech && !['cancelled','completed_paid','archived_test'].includes(j.jobStatus));
    const tb = $('#assignTable tbody');
    if (!list.length) { tb.innerHTML='<tr><td colspan="4" class="empty">All jobs assigned</td></tr>'; return; }
    tb.innerHTML = list.map(j => '<tr data-id="'+esc(j.id)+'">'+
      '<td>'+esc(cust(j))+'</td><td>'+esc(j.package||'—')+'</td><td>'+jobBadge(j.jobStatus)+'</td>'+
      '<td><select class="assignSel2" data-id="'+esc(j.id)+'">'+techOptions('')+'</select>'+assignStatusHtml()+'</td></tr>').join('');
    tb.querySelectorAll('.assignSel2').forEach(sel => bindAssignSelect(sel));
    tb.querySelectorAll('.assignRetry').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        techsCacheStale = true;
        ensureAssignOptionsLoaded(btn.closest('td') && btn.closest('td').querySelector('select'));
      };
    });
    tb.querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = e => { if(e.target.tagName!=='SELECT' && !e.target.closest('button')) openDrawer(tr.dataset.id); });
  }

  function renderCompleted() {
    const list = jobs.filter(j => j.jobStatus === 'completed_pending_admin_review');
    const tb = $('#completedTable tbody');
    if (!list.length) { tb.innerHTML='<tr><td colspan="4" class="empty">No jobs pending review</td></tr>'; return; }
    tb.innerHTML = list.map(j => '<tr data-id="'+esc(j.id)+'">'+
      '<td>'+esc(cust(j))+'</td><td>'+dt(j.completedAt)+'</td><td>'+esc(j.assignedTechName||'—')+'</td>'+
      '<td onclick="event.stopPropagation()"><div class="actions">'+
      '<button type="button" class="btn sm approve" data-id="'+esc(j.id)+'">Approve</button>'+
      '<button type="button" class="btn ghost sm reopen" data-id="'+esc(j.id)+'">Reopen</button>'+
      '<button type="button" class="btn ghost sm correct" data-id="'+esc(j.id)+'">Request fix</button>'+
      '</div></td></tr>').join('');
    tb.querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = e => { if(!e.target.closest('button')) openDrawer(tr.dataset.id); });
    tb.querySelectorAll('.approve').forEach(b => b.onclick = () => jobAction(b.dataset.id,'approve_completion'));
    tb.querySelectorAll('.reopen').forEach(b => b.onclick = () => {
      const r = prompt('Reopen reason (required):');
      if (!r || !r.trim()) { if (r !== null) toast('A reopen reason is required'); return; }
      jobAction(b.dataset.id,'reopen_job', { reason: r.trim() });
    });
    tb.querySelectorAll('.correct').forEach(b => b.onclick = () => { const m=prompt('Correction message:'); if(m) jobAction(b.dataset.id,'request_correction',{message:m}); });
  }

  function safeReqJson(o) {
    try { return JSON.stringify(o || {}); } catch { return '{}'; }
  }

  function moneyLabel(n) {
    if (n == null || n === '') return '';
    const v = Number(n);
    if (!Number.isFinite(v)) return '';
    return '$' + v.toFixed(2);
  }

  function categoryLabel(id) {
    const map = {
      cars: 'Car / SUV / Truck',
      boats: 'Boat / Marine',
      rvs: 'RV / Trailer',
      powersports: 'Powersports',
      fleet: 'Fleet / Commercial',
    };
    return map[String(id || '').toLowerCase()] || (id || '—');
  }

  function requestTitle(r) {
    const titles = {
      package_change_request: 'Change package',
      addon_request: 'Add service add-ons',
      vehicle_add_request: 'Add a vehicle',
      vehicle_replace_request: 'Replace vehicle',
      vehicle_remove_request: 'Remove a vehicle',
      reschedule_request: 'Reschedule appointment',
      address_update: 'Update service address',
      cancellation: 'Cancel appointment',
      cancellation_request: 'Cancel appointment',
      maintenance_request: 'Maintenance plan request',
      discount_request: 'Discount request',
    };
    return titles[r.requestType] || r.typeLabel || r.requestType || 'Customer request';
  }

  function plainPrevious(r) {
    const p = r.previousState || {};
    const lines = [];
    if (p.package || p.service) lines.push(['Current package', p.package || p.service]);
    if (p.preferredDate) lines.push(['Current date', p.preferredDate + (p.preferredTime ? ' · ' + p.preferredTime : '')]);
    if (p.address) lines.push(['Current address', p.address]);
    if (p.vehicleLabel || p.vehicle) lines.push(['Current vehicle', p.vehicleLabel || p.vehicle]);
    if (p.vehicle && typeof p.vehicle === 'object') {
      const vl = p.vehicle.vehicleLabel || [p.vehicle.year, p.vehicle.make, p.vehicle.model].filter(Boolean).join(' ');
      if (vl) lines.push(['Vehicle', vl]);
      if (p.vehicle.packageName) lines.push(['Package', p.vehicle.packageName]);
      const ads = Array.isArray(p.vehicle.addons) ? p.vehicle.addons : [];
      if (ads.length) {
        lines.push(['Add-ons', ads.map(a => a.name || a.id || 'Add-on').join(', ')]);
      } else {
        lines.push(['Add-ons', 'None']);
      }
      if (p.vehicle.subtotal != null) lines.push(['Vehicle subtotal', moneyLabel(p.vehicle.subtotal)]);
    }
    if (p.packageName && !p.vehicle) lines.push(['Package', p.packageName]);
    if (p.vehicleSubtotal != null && !p.vehicle) lines.push(['Vehicle subtotal', moneyLabel(p.vehicleSubtotal)]);
    if (p.vehicleCount != null) lines.push(['Vehicles on booking', String(p.vehicleCount)]);
    if (p.status) lines.push(['Booking status', p.status]);
    if (p.approvedFinalAmount != null || p.totalPrice != null) {
      lines.push(['Approved booking total', moneyLabel(p.approvedFinalAmount != null ? p.approvedFinalAmount : p.totalPrice)]);
    }
    if (p.paidAmount != null) lines.push(['Paid amount', moneyLabel(p.paidAmount)]);
    if (p.remainingBalance != null) lines.push(['Remaining balance', moneyLabel(p.remainingBalance)]);
    return lines;
  }

  function plainRequested(r) {
    const rs = r.requestedState || {};
    const t = r.requestType;
    const lines = [];
    const warnings = [];

    if (t === 'package_change_request') {
      lines.push(['Requested package', rs.packageName || rs.packageId || '—']);
      if (rs.packageDescription) lines.push(['What it includes', rs.packageDescription]);
      if (rs.lengthFt) lines.push(['Vehicle length', rs.lengthFt + ' ft']);
      if (rs.vehicleCategory) lines.push(['Category', categoryLabel(rs.vehicleCategory)]);
      if (rs.packagePrice != null) lines.push(['Package price', moneyLabel(rs.packagePrice)]);
      if (rs.proposedTotal != null) lines.push(['New total if approved', moneyLabel(rs.proposedTotal)]);
    } else if (t === 'addon_request') {
      const names = (rs.addons || []).map(a => {
        const price = a.price != null ? ' (' + moneyLabel(a.price) + ')' : '';
        return (a.name || a.id || 'Add-on') + price;
      });
      lines.push(['Add-ons requested', names.length ? names.join(', ') : (rs.requestedAddons || '—')]);
      if (rs.addonTotal != null) lines.push(['Add-ons subtotal', moneyLabel(rs.addonTotal)]);
      if (rs.proposedTotal != null) lines.push(['New total if approved', moneyLabel(rs.proposedTotal)]);
    } else if (t === 'vehicle_remove_request') {
      const snap = rs.vehicleSnapshot || {};
      const label = snap.vehicleLabel || [snap.year, snap.make, snap.model].filter(Boolean).join(' ') || 'Vehicle';
      lines.push(['Remove vehicle and attached services', label]);
      if (snap.packageName) lines.push(['Package removed', snap.packageName]);
      const ads = Array.isArray(snap.addons) ? snap.addons : [];
      lines.push(['Add-ons removed', ads.length ? ads.map(a => a.name || a.id || 'Add-on').join(', ') : 'None']);
      if (snap.subtotal != null) lines.push(['Vehicle subtotal removed', moneyLabel(snap.subtotal)]);
      if (rs.proposedTotal != null) lines.push(['Authoritatively recalculated proposed total', moneyLabel(rs.proposedTotal)]);
      if (rs.priceDifference != null) lines.push(['Price difference', moneyLabel(rs.priceDifference)]);
      if (Number(rs.currentApprovedCents) > 0 && Number(rs.proposedApprovedCents) < Number(rs.currentApprovedCents)) {
        warnings.push('Payment-impact warning: approving may require a refund/credit adjustment if payment was collected.');
      }
    } else if (t === 'vehicle_add_request' || t === 'vehicle_replace_request') {
      const label = rs.vehicleLabel || [rs.year, rs.make, rs.model].filter(Boolean).join(' ') || '—';
      lines.push([t === 'vehicle_replace_request' ? 'Replace with' : 'Add vehicle', label]);
      if (rs.category) lines.push(['Category', categoryLabel(rs.category)]);
      if (rs.year) lines.push(['Year', rs.year]);
      if (rs.make) lines.push(['Make', rs.make]);
      if (rs.model) lines.push(['Model', rs.model]);
      if (rs.lengthFt) lines.push(['Length', rs.lengthFt + ' ft']);
      const cat = String(rs.category || '').toLowerCase();
      const hay = (label + ' ' + (rs.make || '') + ' ' + (rs.model || '')).toLowerCase();
      if (cat === 'boats' && /civic|camry|accord|corolla|f-?150|silverado|rav4|cr-?v/i.test(hay)) {
        warnings.push('Category is Boat, but the vehicle name looks like a car. Confirm with customer before approving.');
      }
      if (cat === 'rvs' && /civic|camry|accord|corolla/i.test(hay)) {
        warnings.push('Category is RV, but the vehicle name looks like a car. Confirm with customer before approving.');
      }
      if ((cat === 'cars' || !cat) && /\b(ft|foot|yacht|pontoon|trailer|motorhome|class\s*[abc])\b/i.test(hay)) {
        warnings.push('Vehicle name may not match a standard car category. Double-check size/type.');
      }
    } else if (t === 'maintenance_request') {
      lines.push(['Frequency', rs.maintenancePeriodLabel || rs.periodLabel || rs.maintenancePeriod || rs.period || '—']);
      lines.push(['Plan package', rs.packageName || rs.packageId || '—']);
      if (rs.packagePrice != null) lines.push(['Package base', moneyLabel(rs.packagePrice)]);
      if (rs.maintenanceNote || rs.note) lines.push(['Customer note', rs.maintenanceNote || rs.note]);
    } else if (t === 'reschedule_request') {
      lines.push(['New preferred date', rs.preferredDate || rs.newDate || '—']);
      if (rs.preferredTime || rs.newTime) lines.push(['New preferred time', rs.preferredTime || rs.newTime]);
    } else if (t === 'address_update') {
      lines.push(['New address', rs.address || rs.newAddress || '—']);
    } else if (t === 'cancellation' || t === 'cancellation_request') {
      lines.push(['Reason', rs.reason || 'Customer requested cancellation']);
    } else if (rs && Object.keys(rs).length) {
      Object.keys(rs).forEach(k => {
        const v = rs[k];
        if (v == null || v === '' || typeof v === 'object') return;
        lines.push([k, String(v)]);
      });
    } else {
      lines.push(['Details', 'No structured details on this request']);
    }
    return { lines, warnings };
  }

  function dlRows(rows) {
    if (!rows || !rows.length) return '<div class="hint" style="margin:0">No details on file.</div>';
    return '<dl class="req-dl">' + rows.map(([k, v]) =>
      '<div><dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd></div>'
    ).join('') + '</dl>';
  }

  function formatRequestSummary(r) {
    const { lines } = plainRequested(r);
    return lines.map(([k, v]) => k + ': ' + v).join(' · ');
  }

  function filterMergedRequestsForStatus(list) {
    const f = String(requestsStatusFilter || 'pending').toLowerCase();
    const rows = Array.isArray(list) ? list : [];
    if (f === 'all') return rows;
    if (f === 'approved' || f === 'applied') {
      return rows.filter((r) => {
        const st = String(r && r.status || '').toLowerCase();
        return st === 'applied' || st === 'approved';
      });
    }
    if (f === 'declined' || f === 'rejected') {
      return rows.filter((r) => {
        const st = String(r && r.status || '').toLowerCase();
        return st === 'rejected' || st === 'declined';
      });
    }
    if (f === 'needs_clarification') {
      return rows.filter((r) => String(r && r.status || '').toLowerCase() === 'needs_clarification');
    }
    if (f === 'needs_payment_adjustment' || f === 'payment_adjustment') {
      return rows.filter((r) => r && r.paymentImpact === 'payment_adjustment_required' && isOpenChangeRequest(r));
    }
    // pending (default): open only — do not re-inject closed rows from jobs.
    return rows.filter(isOpenChangeRequest);
  }

  function requestsEmptyCopy() {
    const f = String(requestsStatusFilter || 'pending');
    if (f === 'approved') return 'No approved customer change requests';
    if (f === 'declined' || f === 'rejected') return 'No declined customer change requests';
    if (f === 'needs_clarification') return 'No requests waiting on customer clarification';
    if (f === 'needs_payment_adjustment') return 'No open requests that need payment adjustment';
    if (f === 'all') return 'No customer change requests';
    return 'No pending customer change requests';
  }

  function renderRequests() {
    const el = $('#requestsList');
    // Merge keeps in-job open CRs visible, then re-apply the active status filter
    // so Approved/Declined views are not polluted by every open job CR.
    const list = filterMergedRequestsForStatus(mergeRequestsWithJobs(changeRequests || []));
    updateRequestsTabBadge();
    if (!list.length) {
      el.innerHTML = '<div class="empty">'+esc(requestsEmptyCopy())+'</div>';
      return;
    }
    const autoApply = new Set([
      'reschedule_request','address_update','cancellation','cancellation_request',
      'package_change_request','addon_request','vehicle_add_request','vehicle_replace_request',
      'vehicle_remove_request',
    ]);
    el.innerHTML = list.map(r => {
      const prevRows = plainPrevious(r);
      const req = plainRequested(r);
      const manual = !autoApply.has(r.requestType);
      const moneyChange = ['package_change_request','addon_request','discount_request','vehicle_remove_request'].includes(r.requestType);
      const proposed = r.requestedState && r.requestedState.proposedTotal;
      const title = requestTitle(r);
      const vehicleBit = r.vehicleLabel || (r.requestedState && r.requestedState.vehicleSnapshot && r.requestedState.vehicleSnapshot.vehicleLabel) || r.vehicleId || '';
      return '<div class="req-box" data-req="'+esc(r.id)+'">'+
        '<h5 style="font-size:15px;margin-bottom:4px">'+esc(title)+'</h5>'+
        '<div style="font-size:12px;color:var(--mu);margin-bottom:8px">Booking <code>'+esc(r.bookingId)+'</code>'+
        (r.customerName ? ' · '+esc(r.customerName) : '')+
        (vehicleBit ? ' · Vehicle '+esc(vehicleBit) : '')+
        ' · '+dt(r.createdAt || r.submittedAt)+' · '+esc(r.status || 'pending')+'</div>'+
        (r.paymentImpact === 'payment_adjustment_required'
          ? '<div class="req-warn">Payment adjustment required — do not auto-remove or rewrite ledger.</div>'
          : '')+
        (manual
          ? '<div class="req-pill warn">Needs manual follow-up after approve</div>'
          : '<div class="req-pill ok">Approving updates the booking automatically</div>')+
        (moneyChange && proposed != null
          ? '<div class="req-money">New total if approved: <strong>'+esc(moneyLabel(proposed))+'</strong></div>'
          : '')+
        (req.warnings || []).map(w => '<div class="req-warn">⚠ '+esc(w)+'</div>').join('')+
        '<div class="req-cols">'+
          '<div class="req-col"><div class="req-col-h">Currently on booking</div>'+dlRows(prevRows)+'</div>'+
          '<div class="req-col req-col-new"><div class="req-col-h">Customer is asking for</div>'+dlRows(req.lines)+'</div>'+
        '</div>'+
        (r.customerVisibleResult ? '<div class="hint" style="margin-top:8px">Last customer message: '+esc(r.customerVisibleResult)+'</div>' : '')+
        '<details class="req-tech"><summary>Technical details (optional)</summary>'+
          '<div class="hint" style="margin-top:6px">Request ID: <code>'+esc(r.shortId || r.id)+'</code> · Type: <code>'+esc(r.requestType)+'</code></div>'+
          '<pre class="req-pre">'+esc(safeReqJson({ previous: r.previousState, requested: r.requestedState }))+'</pre>'+
        '</details>'+
        '<div class="actions" style="margin-top:12px">'+
        (isOpenChangeRequest(r) ? '<button type="button" class="btn sm req-approve" data-id="'+esc(r.id)+'">Approve</button>'+
        '<button type="button" class="btn ghost sm req-reject" data-id="'+esc(r.id)+'">Decline</button>'+
        '<button type="button" class="btn ghost sm req-clarify" data-id="'+esc(r.id)+'">Ask customer for clarification</button>' : '')+
        '<button type="button" class="btn ghost sm req-open" data-bid="'+esc(r.bookingId)+'">Open appointment</button>'+
        '</div></div>';
    }).join('');

    el.querySelectorAll('.req-approve').forEach(b => b.onclick = async () => {
      const id = b.dataset.id;
      const r = list.find(x => x.id === id);
      const msg = r && !autoApply.has(r.requestType)
        ? 'This request still needs manual follow-up after approval. Continue?'
        : (r && r.requestType === 'vehicle_remove_request'
          ? 'Approve vehicle removal and reprice the booking on the server?'
          : 'Approve this request and update the booking?');
      if (!confirm(msg)) return;
      b.disabled = true;
      try {
        await decideChangeRequest(id, 'approve');
        toast('Request approved — booking updated');
        await refreshAll();
      } catch(e) {
        toast(e.message);
        b.disabled = false;
      }
    });
    el.querySelectorAll('.req-reject').forEach(b => b.onclick = async () => {
      const note = prompt('Rejection note for customer (optional):');
      if (note === null) return;
      if (!confirm('Decline this request?')) return;
      b.disabled = true;
      try {
        await decideChangeRequest(b.dataset.id, 'reject', note);
        toast('Request declined');
        await refreshAll();
      } catch(e) { toast(e.message); b.disabled = false; }
    });
    el.querySelectorAll('.req-clarify').forEach(b => b.onclick = async () => {
      const note = prompt('Clarification message for the customer:');
      if (!note) return;
      b.disabled = true;
      try {
        await decideChangeRequest(b.dataset.id, 'clarify', note);
        toast('Clarification requested');
        await refreshAll();
      } catch(e) { toast(e.message); b.disabled = false; }
    });
    el.querySelectorAll('.req-open').forEach(b => b.onclick = () => {
      openDrawerFocusRequests = true;
      openDrawer(b.dataset.bid);
    });
  }

  function renderIssues() {
    const list = jobs.filter(j => j.jobStatus === 'issue_reported' || j.issueNotes);
    const tb = $('#issuesTable tbody');
    if (!list.length) { tb.innerHTML='<tr><td colspan="4" class="empty">No issues</td></tr>'; return; }
    tb.innerHTML = list.map(j => '<tr data-id="'+esc(j.id)+'">'+
      '<td>'+esc(cust(j))+'</td><td>'+esc(j.vehicleLabel||j.vehicle||'—')+'</td>'+
      '<td>'+esc(j.assignedTechName||'—')+'</td><td>'+jobBadge(j.jobStatus)+'</td></tr>').join('');
    tb.querySelectorAll('tr[data-id]').forEach(tr => tr.onclick = () => openDrawer(tr.dataset.id));
  }

  function renderEvents() {
    const q = ($('#evSearch').value||'').toLowerCase();
    const evs = [];
    // Lean Jobs list omits eventLog. Show history from jobs that already have full detail
    // (opened via get_job) and from the currently open appointment.
    const sources = [];
    jobs.forEach((j) => { if (j && Array.isArray(j.eventLog) && j.eventLog.length) sources.push(j); });
    if (activeJob && Array.isArray(activeJob.eventLog) && activeJob.eventLog.length
      && !sources.some((j) => j.id === activeJob.id)) {
      sources.push(activeJob);
    }
    sources.forEach(j => (j.eventLog||[]).forEach(e => evs.push({...e, bookingId:j.id, customer:cust(j)})));
    evs.sort((a,b) => String(b.at||'').localeCompare(String(a.at||'')));
    const filtered = q ? evs.filter(e => JSON.stringify(e).toLowerCase().includes(q)) : evs;
    const el = $('#evList');
    if (!filtered.length) {
      el.innerHTML = '<div class="empty">No loaded event history yet. Open a job to load its full detail (history lives on the appointment, not the Jobs list).</div>';
      return;
    }
    el.innerHTML = filtered.slice(0,200).map(e =>
      '<div class="ev"><time>'+dt(e.at)+' · '+esc(e.bookingId)+' · '+esc(e.customer)+'</time>'+
      '<strong>'+esc(e.action||e.by||'event')+'</strong>'+
      (e.note?' — '+esc(e.note):'')+(e.message?' — '+esc(e.message):'')+(e.techName?' · '+esc(e.techName):'')+
      '</div>'
    ).join('');
  }

  function renderTechs() {
    const el = $('#techList');
    if (techsMeta.isLoading && !techsMeta.hasLoaded) {
      el.innerHTML = '<div class="empty">Loading technicians…</div>';
      return;
    }
    if (techsMeta.error && !techsMeta.hasLoaded) {
      el.innerHTML = '<div class="empty">Technicians could not be loaded. <button type="button" class="btn ghost sm" id="techsPageRetry" style="min-height:44px;margin-left:8px">Retry</button></div>';
      const rb = $('#techsPageRetry');
      if (rb) rb.onclick = async () => {
        techsCacheStale = true;
        try {
          await ensureTechsForManagement();
          renderTechs(); renderOverview();
        } catch (e) {
          toast((e && e.message) || 'Retry failed');
          renderTechs();
        }
      };
      return;
    }
    if (!techs.length) { el.innerHTML='<div class="empty">No technicians yet — create one above</div>'; return; }
    el.innerHTML = '<table class="tbl"><thead><tr>'+
      '<th>Name</th><th>Email</th><th>Phone</th><th>Status</th><th>Rating</th><th>Onboarding</th><th>Jobs</th><th>Login</th><th>Actions</th>'+
      '</tr></thead><tbody>'+
      techs.map(t => '<tr data-tid="'+esc(t.techId)+'">'+
        '<td><strong>'+esc(t.fullName)+'</strong><div class="tech-meta">'+esc(t.techId)+'</div></td>'+
        '<td>'+esc(t.email||'—')+'</td>'+
        '<td>'+esc(t.phone||'—')+'</td>'+
        '<td>'+(t.active?badge('active','b-ok'):badge('inactive','b-st'))+'</td>'+
        '<td>'+(t.ratingAverage?('⭐ '+t.ratingAverage+' ('+t.ratingCount+')'):'—')+'</td>'+
        '<td>'+(t.onboardingComplete?badge('onboarded','b-ok'):badge('onboarding pending','b-warn'))+'</td>'+
        '<td>'+(t.assignedJobsCount!=null?t.assignedJobsCount:(techsLoadMode==='management'?0:'—'))+'</td>'+
        '<td>'+(t.hasPassword?badge('password set','b-ok'):badge('invite pending','b-warn'))+
          (t.lastLoginAt?'<div class="tech-meta">Last: '+dt(t.lastLoginAt)+'</div>':'')+'</td>'+
        '<td onclick="event.stopPropagation()"><div class="actions">'+
        '<button type="button" class="btn sm edit-tech" data-tid="'+esc(t.techId)+'">Manage</button>'+
        '</div></td></tr>').join('')+
      '</tbody></table>';
    el.querySelectorAll('.edit-tech').forEach(b => b.onclick = () => openTechDrawer(b.dataset.tid));
    el.querySelectorAll('tr[data-tid]').forEach(tr => tr.onclick = e => {
      if (!e.target.closest('button')) openTechDrawer(tr.dataset.tid);
    });
  }

  function openTechDrawer(techId) {
    const t = techs.find(x => x.techId === techId);
    if (!t) return;
    activeTech = t;
    $('#tdTitle').textContent = t.fullName || 'Technician';
    $('#tdBadges').innerHTML = (t.active ? badge('active','b-ok') : badge('inactive','b-st')) +
      (t.hasPassword ? badge('password set','b-ok') : badge('no password','b-warn'));
    $('#tdId').value = t.techId;
    $('#tdName').value = t.fullName || '';
    $('#tdEmail').value = t.email || '';
    $('#tdPhone').value = t.phone || '';
    $('#tdArea').value = t.serviceArea || '';
    $('#tdCaps').value = (t.capabilities || []).join(', ');
    $('#tdSmsConsent').checked = t.smsConsent === true;
    $('#tdPass').value = '';
    $('#tdPass2').value = '';
    $('#tdPwStatus').textContent = t.hasPassword
      ? 'Password is set. Enter a new password below to replace it.'
      : 'No password yet. Set one below or send an invite link.';
    $('#tdMeta').innerHTML =
      '<div><b>Created:</b> '+dt(t.createdAt)+'</div>'+
      '<div><b>Updated:</b> '+dt(t.updatedAt)+'</div>'+
      '<div><b>Last login:</b> '+dt(t.lastLoginAt)+'</div>'+
      '<div><b>Assigned jobs:</b> '+(t.assignedJobsCount||0)+'</div>'+
      '<div><b>Invite:</b> '+(t.hasInviteToken ? (t.inviteExpired ? 'expired — reset invite' : 'active') : 'none')+'</div>';
    const tok = inviteCache[t.techId];
    const link = tok ? buildInviteLink(t.email, tok) : '';
    $('#tdInvLink').textContent = link || 'Generate invite to see link here.';
    const toggle = $('#tdToggle');
    toggle.textContent = t.active ? 'Deactivate technician' : 'Activate technician';
    toggle.className = t.active ? 'btn danger sm' : 'btn sm';
    $('#techDrawerBg').classList.add('open');
    $('#techDrawer').classList.add('open');
  }

  function closeTechDrawer() {
    $('#techDrawerBg').classList.remove('open');
    $('#techDrawer').classList.remove('open');
    activeTech = null;
  }

  function buildInviteLink(email, token) {
    return location.origin + '/technician.html?invite=' + encodeURIComponent(token) + '&email=' + encodeURIComponent(email);
  }

  async function copyInviteLink(email, token) {
    const link = buildInviteLink(email, token);
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(link);
      return link;
    }
    return link;
  }

  async function saveTechProfile() {
    if (!activeTech) return;
    const caps = $('#tdCaps').value.split(',').map(s => s.trim()).filter(Boolean);
    try {
      await api('/.netlify/functions/tech-accounts', 'POST', {
        action: 'update', techId: activeTech.techId,
        updates: {
          fullName: $('#tdName').value.trim(),
          email: $('#tdEmail').value.trim(),
          phone: $('#tdPhone').value.trim(),
          serviceArea: $('#tdArea').value.trim(),
          capabilities: caps,
          smsConsent: $('#tdSmsConsent').checked,
        },
      });
      toast('Profile saved');
      invalidateTechsSessionCache();
      await ensureTechsForManagement();
      activeTech = techs.find(x => x.techId === $('#tdId').value) || activeTech;
      openTechDrawer($('#tdId').value);
      renderOverview();
      renderTechs();
      refreshAssignSelectsInDom();
    } catch (e) { toast('Save failed: ' + e.message); }
  }

  async function setTechPassword() {
    if (!activeTech) return;
    const p1 = $('#tdPass').value;
    const p2 = $('#tdPass2').value;
    if (!p1 || !p2) { toast('Enter and confirm password'); return; }
    try {
      await api('/.netlify/functions/tech-accounts', 'POST', {
        action: 'set_password', techId: activeTech.techId,
        newPassword: p1, confirmPassword: p2,
      });
      toast('Password set');
      $('#tdPass').value = '';
      $('#tdPass2').value = '';
      invalidateTechsSessionCache();
      await ensureTechsForManagement();
      openTechDrawer(activeTech.techId);
    } catch (e) {
      toast(e.message === 'weak_password' ? 'Password too weak (8+ chars, upper, lower, number)' : ('Failed: ' + e.message));
    }
  }

  async function copyInviteForTech() {
    if (!activeTech) return;
    try {
      if (!inviteCache[activeTech.techId]) {
        const d = await api('/.netlify/functions/tech-accounts', 'POST', { action: 'reset_invite', techId: activeTech.techId });
        inviteCache[activeTech.techId] = d.inviteToken;
      }
      const link = buildInviteLink(activeTech.email, inviteCache[activeTech.techId]);
      await copyInviteLink(activeTech.email, inviteCache[activeTech.techId]);
      $('#tdInvLink').textContent = link;
      toast('Invite link copied');
      invalidateTechsSessionCache();
      await ensureTechsForManagement();
    } catch (e) { toast('Invite failed: ' + e.message); }
  }

  async function resetInviteForTech() {
    if (!activeTech) return;
    if (!confirm('Reset invite? This clears the current password until a new one is set.')) return;
    try {
      const d = await api('/.netlify/functions/tech-accounts', 'POST', { action: 'reset_invite', techId: activeTech.techId });
      inviteCache[activeTech.techId] = d.inviteToken;
      const link = buildInviteLink(activeTech.email, d.inviteToken);
      $('#tdInvLink').textContent = link;
      toast('Invite reset');
      invalidateTechsSessionCache();
      await ensureTechsForManagement();
      openTechDrawer(activeTech.techId);
    } catch (e) { toast('Reset failed: ' + e.message); }
  }

  async function toggleTechFromDrawer() {
    if (!activeTech) return;
    const action = activeTech.active ? 'deactivate' : 'reactivate';
    if (action === 'deactivate' && !confirm('Deactivate this technician? They cannot log in.')) return;
    try {
      await api('/.netlify/functions/tech-accounts', 'POST', { action, techId: activeTech.techId });
      toast(action === 'deactivate' ? 'Deactivated' : 'Activated');
      invalidateTechsSessionCache();
      await ensureTechsForManagement();
      openTechDrawer(activeTech.techId);
      renderOverview();
    } catch (e) { toast('Failed: ' + e.message); }
  }

  async function onAssign(bookingId, techId) {
    try {
      if (!techId) await api('/.netlify/functions/tech-assignment','POST',{action:'unassign',bookingId});
      else await api('/.netlify/functions/tech-assignment','POST',{action:'assign',bookingId,techId});
      toast(techId ? 'Assigned' : 'Unassigned');
      await refreshAll();
    } catch(e) { toast('Assign failed: '+e.message); }
  }

  // Confirmation is idempotent server-side (CAS on bookingVersion), but a
  // double tap still costs a round trip and can look like two confirmations.
  let confirmInFlight = null;

  async function confirmBookingOnce(bookingId, buttons) {
    if (!bookingId || confirmInFlight) return;
    if (!confirm('Confirm this booking and send the customer a confirmation email?')) return;
    confirmInFlight = bookingId;
    const list = (buttons || []).filter(Boolean);
    list.forEach(b => { b.disabled = true; });
    try {
      await jobAction(bookingId, 'confirm_booking');
    } finally {
      confirmInFlight = null;
      list.forEach(b => { if (b.isConnected) b.disabled = false; });
    }
  }

  /**
   * Mirror the primary decisions into a bar that stays on screen. On a phone the
   * detail panel is long, so Confirm/Decline/Edit would otherwise be a scroll away.
   */
  function bindStickyJobActions(j, refs) {
    const bar = $('#dStickyActions');
    if (!bar) return;
    const confirmBtn = $('#dStickyConfirm');
    const editBtn = $('#dStickyEdit');
    const declineBtn = $('#dStickyDecline');
    const pending = j.jobStatus === 'pending_review';
    bar.hidden = false;
    if (confirmBtn) {
      confirmBtn.hidden = !pending;
      confirmBtn.disabled = false;
      confirmBtn.onclick = () => confirmBookingOnce(j.id, [confirmBtn, refs && refs.confirmBtn]);
    }
    if (editBtn) {
      editBtn.onclick = () => {
        // This button said Edit but only scrolled; the unlock lived on
        // "Edit details" in the sticky summary. Same verb, same behaviour now.
        enableApptEditMode();
        const target = $('#dSaveCustomer') || $('#dSaveService') || $('#dBody');
        if (!target) return;
        try { target.scrollIntoView({ behavior:'smooth', block:'center' }); } catch (e) { target.scrollIntoView(); }
        const first = $('#dFirst');
        if (first) { try { first.focus({ preventScroll:true }); } catch (e) { first.focus(); } }
      };
    }
    if (declineBtn) {
      declineBtn.onclick = () => {
        const r = prompt('Decline / cancel reason:');
        if (r !== null) jobAction(j.id,'cancel_booking', { reason: r });
      };
    }
  }

  async function jobAction(bookingId, action, extra) {
    try {
      const data = await api('/.netlify/functions/admin-ops-jobs','POST',{action,bookingId,...extra});
      toast(action === 'close_job' ? (data.noop ? 'Already closed as paid' : 'Job closed as paid') : 'Saved');
      await refreshAll();
      if (action === 'archive_test' && expandedJobId === bookingId) {
        collapseJobDetail();
        return data;
      }
      if (expandedJobId === bookingId || (activeJob && activeJob.id === bookingId)) {
        expandedJobId = bookingId;
        await openDrawer(bookingId);
      }
      return data;
    } catch(e) {
      toast('Action failed: ' + formatActionError(e));
      throw e;
    }
  }

  function formatActionError(e) {
    const data = (e && e.data) || {};
    const parts = [];
    const err = data.error || (e && e.message) || 'unknown_error';
    parts.push(err);
    if (data.message && String(data.message) !== String(err)) parts.push(data.message);
    if (data.reason) parts.push('reason: ' + data.reason);
    if (data.expectedAmountCents != null && Number.isFinite(Number(data.expectedAmountCents))) {
      parts.push('expected $' + (Number(data.expectedAmountCents) / 100).toFixed(2));
    }
    if (data.receivedAmountCents != null && Number.isFinite(Number(data.receivedAmountCents))) {
      parts.push('got $' + (Number(data.receivedAmountCents) / 100).toFixed(2));
    }
    if (err === 'payment_attempt_in_progress') {
      return 'payment_attempt_in_progress — a Stripe payment is already in progress for this booking';
    }
    return parts.join(' · ');
  }

  /** Strip $ / commas; reject NaN. Prefer omitting amount when it matches remaining. */
  function parseCashAmountInput(raw) {
    if (raw == null) return { ok: false, error: 'empty' };
    const s = String(raw).trim().replace(/^\$/, '').replace(/,/g, '').trim();
    if (!s) return { ok: false, error: 'empty' };
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return { ok: false, error: 'invalid' };
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'invalid' };
    return { ok: true, dollars: n, cents: Math.round(n * 100), text: s };
  }

  function fmtServerDollars(n) {
    if (n == null || n === '') return '—';
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    return '$' + v.toFixed(2);
  }

  /**
   * True when the label already states this length, so Admin does not repeat it
   * in the Length row ("Yamaha 222S — 22 ft" + "Length: 22 ft"). Digit
   * boundaries keep a model number like "222S" from matching a 22 ft boat.
   */
  function labelStatesLength(label, len) {
    if (!len) return false;
    return new RegExp('(^|[^0-9.])' + len + "\\s*(ft\\b|ft\\.|feet\\b|')", 'i').test(String(label || ''));
  }

  function vehicleMutationFormHtml() {
    const catalog = drawerAddonData && drawerAddonData.vehicleCatalog;
    if (!catalog || !Array.isArray(catalog.categories)) {
      return '<p class="hint">Vehicle catalog unavailable — reopen this booking.</p>';
    }
    const categoryOptions = catalog.categories.map((row) =>
      '<option value="'+esc(row.id)+'">'+esc(row.label || row.id)+'</option>'
    ).join('');
    const yearOptions = (catalog.years || []).map((year) =>
      '<option value="'+esc(year)+'">'+esc(year)+'</option>'
    ).join('');
    return '<details id="dVehicleMutation" style="margin-top:10px">'+
      '<summary style="cursor:pointer;min-height:44px;display:flex;align-items:center;color:var(--ac);font-weight:700">Add vehicle</summary>'+
      '<div class="op-grid" style="margin-top:8px">'+
      '<input type="hidden" id="dVehicleOp" value="add"><input type="hidden" id="dVehicleId" value="">'+
      '<div><label>Category</label><select id="dVehicleCategory">'+categoryOptions+'</select></div>'+
      '<div><label>Year</label><select id="dVehicleYear">'+yearOptions+'</select></div>'+
      '<div><label>Make</label><input id="dVehicleMake" maxlength="60"></div>'+
      '<div><label>Model</label><input id="dVehicleModel" maxlength="60"></div>'+
      '<div><label>Size / tier</label><select id="dVehicleTier"></select></div>'+
      '<div><label>Package</label><select id="dVehiclePackage"></select></div>'+
      '<div><label>Length (ft, when required)</label><input type="number" id="dVehicleLength" min="1" step="1"></div>'+
      '<div class="full"><label>Reason (required)</label><input id="dVehicleReason" maxlength="300" placeholder="Why is this appointment vehicle changing?"></div>'+
      '<div class="full actions"><button type="button" class="btn sm" id="dVehicleSave">Apply vehicle change</button> '+
      '<button type="button" class="btn ghost sm" id="dVehicleReset">Reset to Add</button></div>'+
      '<p class="hint full" id="dVehicleStatus">Server pricing is authoritative. Paid increases become a delta; decreases become credit/refund due.</p>'+
      '</div></details>';
  }

  function renderVehiclesDetailSection(j) {
    const vehs = jobVehicles(j);
    let out = '<div class="sec full"><h4>Vehicles and services</h4>';
    if (!vehs.length) {
      out += '<div class="kv"><div><b>Vehicle:</b> '+esc(j.vehicleLabel||j.vehicle||'—')+'</div>'+
        '<div><b>Package:</b> '+esc(j.package||j.service||'—')+'</div></div></div>';
      return out;
    }
    vehs.forEach((v, idx) => {
      const label = v.vehicleLabel || [v.year, v.make, v.model].filter(Boolean).join(' ').trim() || ('Vehicle '+(idx+1));
      const pack = v.packageName || v.pkgName || '—';
      const cat = v.category || v.cat || '';
      const tier = v.tierLabel || v.tier || v.tierKey || '';
      const lenFt = Number(v.lengthFt);
      const len = lenFt > 0 && !labelStatesLength(label, lenFt) ? (lenFt + ' ft') : '';
      const showCat = cat && label.toLowerCase().indexOf(String(cat).toLowerCase()) === -1;
      const addons = Array.isArray(v.addons) ? v.addons : [];
      out += '<div class="job-veh-card">'+
        '<h5>'+esc(label)+'</h5>'+
        '<div class="kv">'+
        (showCat ? '<div><b>Category:</b> '+esc(cat)+'</div>' : '')+
        (len ? '<div><b>Length:</b> '+esc(len)+'</div>' : '')+
        (tier ? '<div><b>Tier:</b> '+esc(tier)+'</div>' : '')+
        '<div><b>Package:</b> '+esc(pack)+'</div>'+
        '<div><b>Package / base:</b> '+esc(fmtServerDollars(v.basePrice != null ? v.basePrice : v.packagePrice))+'</div>';
      if (addons.length) {
        out += '<div><b>Add-ons:</b><ul style="margin:4px 0 0 18px;padding:0">'+
          addons.map(a => {
            const name = (a && a.name) || 'Add-on';
            const qty = Number(a && a.qty) > 0 ? Number(a.qty) : 1;
            const price = fmtServerDollars(a && a.price);
            return '<li>'+esc(name)+' × '+esc(String(qty))+' · '+esc(price)+'</li>';
          }).join('')+
          '</ul></div>';
      } else {
        out += '<div><b>Add-ons:</b> None</div>';
      }
      out += '<div><b>Vehicle subtotal:</b> '+esc(fmtServerDollars(v.subtotal))+'</div>'+
        '</div><div class="actions" style="margin-top:8px">'+
        '<button type="button" class="btn ghost sm admin-vehicle-edit" data-vehicle-index="'+idx+'">Edit / replace</button>'+
        (vehs.length > 1
          ? '<button type="button" class="btn danger sm admin-vehicle-remove" data-vehicle-index="'+idx+'">Remove</button>'
          : '<span class="hint" style="margin:0">Final vehicle cannot be removed; cancel the appointment instead.</span>')+
        '</div></div>';
    });
    out += vehicleMutationFormHtml()+'</div>';
    return out;
  }

  function bindVehicleMutationSection(j) {
    const root = $('#dVehicleMutation');
    const catalog = drawerAddonData && drawerAddonData.vehicleCatalog;
    if (!root || !catalog) return;
    const vehicles = jobVehicles(j);
    const category = $('#dVehicleCategory');
    const tier = $('#dVehicleTier');
    const pack = $('#dVehiclePackage');
    const length = $('#dVehicleLength');
    const summary = root.querySelector('summary');
    let pending = false;

    const options = (rows, selected) => (rows || []).map((row) =>
      '<option value="'+esc(row.id)+'"'+(String(row.id)===String(selected||'')?' selected':'')+'>'+esc(row.label || row.name || row.id)+'</option>'
    ).join('');
    function syncCatalog(selectedTier, selectedPackage) {
      const cat = category.value;
      const tiers = catalog.tiersByCategory && catalog.tiersByCategory[cat] || [];
      const packages = catalog.packagesByCategory && catalog.packagesByCategory[cat] || [];
      tier.innerHTML = options(tiers, selectedTier);
      tier.disabled = !tiers.length;
      pack.innerHTML = options(packages, selectedPackage);
      pack.disabled = !packages.length;
      const needsLength = (catalog.lengthCategories || []).includes(cat);
      length.disabled = !needsLength;
      if (!needsLength) length.value = '';
    }
    function reset() {
      $('#dVehicleOp').value = 'add';
      $('#dVehicleId').value = '';
      $('#dVehicleMake').value = '';
      $('#dVehicleModel').value = '';
      $('#dVehicleReason').value = '';
      category.selectedIndex = 0;
      if ($('#dVehicleYear')) $('#dVehicleYear').selectedIndex = 0;
      if (summary) summary.textContent = 'Add vehicle';
      syncCatalog('', '');
    }
    category.onchange = () => syncCatalog('', '');
    const resetBtn = $('#dVehicleReset');
    if (resetBtn) resetBtn.onclick = reset;

    document.querySelectorAll('.admin-vehicle-edit').forEach((button) => {
      button.onclick = () => {
        const vehicle = vehicles[Number(button.dataset.vehicleIndex)];
        if (!vehicle) return;
        $('#dVehicleOp').value = 'replace';
        $('#dVehicleId').value = vehicle.vehicleId || '';
        category.value = vehicle.category || vehicle.cat || 'cars';
        $('#dVehicleYear').value = String(vehicle.year || '');
        $('#dVehicleMake').value = vehicle.make || '';
        $('#dVehicleModel').value = vehicle.model || '';
        $('#dVehicleLength').value = Number(vehicle.lengthFt) > 0 ? Number(vehicle.lengthFt) : '';
        syncCatalog(vehicle.tierKey || vehicle.tier, vehicle.packageId || vehicle.pkgId);
        $('#dVehicleReason').value = '';
        if (summary) summary.textContent = 'Edit / replace '+(vehicle.vehicleLabel || vehicle.make || 'vehicle');
        root.open = true;
        root.scrollIntoView({ behavior:'smooth', block:'start' });
      };
    });
    document.querySelectorAll('.admin-vehicle-remove').forEach((button) => {
      button.onclick = async () => {
        if (pending) return;
        const vehicle = vehicles[Number(button.dataset.vehicleIndex)];
        if (!vehicle || !confirm('Remove this vehicle from the current appointment? Historical quotes and receipts will be preserved.')) return;
        const reason = (prompt('Removal reason (required):') || '').trim();
        if (!reason) { toast('A removal reason is required'); return; }
        pending = true;
        button.disabled = true;
        try {
          const result = await jobAction(j.id, 'vehicle_mutation', {
            vehicleOp: 'remove',
            vehicleId: vehicle.vehicleId,
            reason,
            expectedBookingVersion: j.bookingVersion,
          });
          if (result.outstandingCreditCents > 0) {
            toast('Vehicle removed · credit/refund due '+money(result.outstandingCreditCents));
          }
        } finally {
          pending = false;
          button.disabled = false;
        }
      };
    });

    const save = $('#dVehicleSave');
    if (save) save.onclick = async () => {
      if (pending) return;
      const reason = ($('#dVehicleReason').value || '').trim();
      if (!reason) { toast('A reason is required'); return; }
      if (!$('#dVehicleMake').value.trim() || !$('#dVehicleModel').value.trim() || !pack.value) {
        toast('Complete make, model, and package');
        return;
      }
      pending = true;
      save.disabled = true;
      const status = $('#dVehicleStatus');
      if (status) status.textContent = 'Applying server-side quote and vehicle change…';
      try {
        const result = await jobAction(j.id, 'vehicle_mutation', {
          vehicleOp: $('#dVehicleOp').value,
          vehicleId: $('#dVehicleId').value || undefined,
          reason,
          expectedBookingVersion: j.bookingVersion,
          vehicle: {
            category: category.value,
            year: $('#dVehicleYear').value,
            make: $('#dVehicleMake').value.trim(),
            model: $('#dVehicleModel').value.trim(),
            tierKey: tier.value,
            packageId: pack.value,
            lengthFt: length.disabled ? 0 : Number(length.value || 0),
          },
        });
        if (result.outstandingCreditCents > 0) {
          toast('Vehicle updated · credit/refund due '+money(result.outstandingCreditCents));
        }
      } catch (error) {
        if (status) status.textContent = error.message === 'version_conflict'
          ? 'Booking changed in another tab. Latest state was loaded; review before retrying.'
          : 'Vehicle change failed: '+error.message;
      } finally {
        pending = false;
        save.disabled = false;
      }
    };
    reset();
  }

  function money(cents){ return '$'+((Math.max(0,Math.round(Number(cents)||0)))/100).toFixed(2); }

  /**
   * Payment method, price adjustments, receipts and the post-service window,
   * each as its own named section. Every control states what the server would
   * allow and, when it would refuse, why — so a greyed-out button is never a
   * mystery.
   */
  function operationalControlsHtml() {
    const c = drawerControls;
    if (!c) return '';
    let h = '<div class="job-detail-grid" style="margin-top:12px">';

    const pm = c.paymentMethod || {};
    h += '<div class="sec full"><h4>Payment method</h4>';
    h += '<p class="hint" style="margin:0 0 8px">'+esc(pm.explanation||'')+'</p>';
    if (pm.canChange) {
      h += '<div class="full"><label>Method for remaining balance</label><select id="dPayMethod">'+
        (pm.supportedMethods||[]).map(m=>'<option value="'+esc(m)+'"'+(pm.currentMethod===m?' selected':'')+'>'+esc(m.replace(/_/g,' '))+'</option>').join('')+
        '</select></div>'+
        '<div class="full"><label>Reason (required)</label><input type="text" id="dPayMethodReason" placeholder="Why is the method changing?"></div>'+
        '<div class="full actions"><button type="button" class="btn ghost sm" id="dSavePayMethod" style="min-height:44px">Change remaining payment method</button></div>';
    } else {
      h += '<div class="full actions"><button type="button" class="btn ghost sm" disabled style="min-height:44px">Change remaining payment method</button></div>';
      if (pm.correctionAvailable) {
        h += '<div class="full"><label>Corrected method</label><select id="dCorrectMethod">'+
          ['cash_on_site','card_on_site','online_after_service','card_on_file']
            .map(m=>'<option value="'+m+'">'+m.replace(/_/g,' ')+'</option>').join('')+
          '</select></div>'+
          '<div class="full"><label>Reason</label><input type="text" id="dCorrectReason"></div>'+
          '<div class="full"><label>Evidence (receipt no., deposit reference, ticket)</label><input type="text" id="dCorrectEvidence"></div>'+
          '<div class="full actions"><button type="button" class="btn warn sm" id="dCorrectMethodBtn" style="min-height:44px">Correct recorded payment method</button></div>'+
          '<p class="hint">The original settlement is left intact — the correction is recorded alongside it.</p>';
      }
    }
    h += '</div>';

    const pa = c.priceAdjustment || {};
    const st = pa.statement || {};
    h += '<div class="sec full"><h4>Price adjustments</h4>';
    h += '<p class="hint" style="margin:0 0 8px">'+esc(pa.explanation||'')+'</p>';
    h += '<div class="hint">Original '+money(st.originalTotalCents)+' · Adjustment '+money(st.adjustmentCents)+
      ' · Revised '+money(st.revisedTotalCents)+' · Paid '+money(st.paidCents)+' · Remaining '+money(st.remainingCents)+'</div>';
    if (st.adjustmentReason) h += '<p class="hint">Reason: '+esc(st.adjustmentReason)+'</p>';
    (st.pendingAdjustments||[]).forEach(a=>{
      h += '<div class="req-box"><p class="hint">Pending '+esc(a.type)+' '+money(a.amountCents)+' — '+esc(a.status)+
        ' ('+esc(a.projectedOutcome||'')+')</p><div class="actions">'+
        ((a.status==='pending_customer'||a.status==='draft')
          ? '<button type="button" class="btn sm adj-decide" data-id="'+esc(a.adjustmentId)+'" data-decision="approve">Record customer approval</button>'+
            '<button type="button" class="btn ghost sm adj-decide" data-id="'+esc(a.adjustmentId)+'" data-decision="decline">Decline</button>'
          : '')+
        (a.status==='approved'
          ? '<button type="button" class="btn sm adj-apply" data-id="'+esc(a.adjustmentId)+'">Apply approved adjustment</button>'
          : '')+
        '</div></div>';
    });
    if (st.refundReview) {
      h += '<p class="hint">Refund/credit review open: '+money(st.refundReview.amountCents)+' — '+esc(st.refundReview.status)+'</p>';
    }
    h += '<div><label>Type</label><select id="dAdjType"><option value="increase">increase</option><option value="decrease">decrease</option></select></div>'+
      '<div><label>Amount (cents)</label><input type="number" id="dAdjAmount" step="1" min="1"></div>'+
      '<div class="full"><label>Reason (required)</label><input type="text" id="dAdjReason"></div>'+
      '<div class="full actions"><button type="button" class="btn ghost sm" id="dAdjPrice" style="min-height:44px">Adjust price</button></div>';
    h += '</div>';

    const r = c.receipts || {};
    h += '<div class="sec"><h4>Receipts</h4><p class="hint" style="margin:0">'+
      'Payment receipt: '+(r.paymentReceiptAvailable?'available':'not yet')+'<br>'+
      'Final receipt: '+(r.finalReceiptAvailable?'available':'not yet')+'</p></div>';

    const ps = c.postService || {};
    const rev = ps.review || {};
    const iss = ps.serviceIssue || {};
    h += '<div class="sec"><h4>Review / service issue</h4><p class="hint" style="margin:0">'+
      'Resolution: '+esc(ps.customerResolutionStatus||'none')+'<br>'+
      'Review: '+(rev.submitted?('submitted · '+(rev.stars||0)+'★'):(rev.available?'available to customer':'not available'))+'<br>'+
      'Service issue: '+(iss.submitted?('reported ('+(iss.count||0)+')'):(iss.windowOpen?('window open · '+(iss.hoursRemaining||0)+'h left'):'window closed'))+
      '</p></div>';

    return h + '</div>';
  }

  async function openDrawer(id) {
    // Strong read + provider reconcile so Admin money matches Customer after Stripe pay.
    ensureJobsTab();
    drawerAddonData = null;
    drawerControls = null;
    try {
      const d = await api('/.netlify/functions/admin-ops-jobs','POST',{action:'get_job',bookingId:id});
      // Capability state is the server's answer to "what is allowed here" —
      // buttons render from it instead of re-deriving rules in the browser.
      drawerControls = (d && d.operationalControls) || null;
      if (d && (d.addonCatalog || d.packageCatalog)) {
        drawerAddonData = {
          catalog: d.addonCatalog || null,
          packageCatalog: d.packageCatalog || null,
          vehicleCatalog: d.vehicleCatalog || null,
          vehicles: d.vehicles || [],
          selected: d.selectedAddonIds || [],
          projection: d.projection || null,
          bookingVersion: d.bookingVersion != null ? d.bookingVersion : (d.job && d.job.bookingVersion),
          quoteVersion: d.quoteVersion != null ? d.quoteVersion : (d.job && d.job.quoteVersion),
        };
      }
      if (d && d.job) {
        d.job._projection = 'admin_full';
        const idx = jobs.findIndex(x => x.id===id);
        if (idx >= 0) jobs[idx] = d.job;
        else jobs.unshift(d.job);
        // Always refresh money surfaces — get_job may overlay Postgres paid
        // state that the lean Blob list still showed as Balance due.
        renderJobs();
        if (typeof renderPayments === 'function') renderPayments();
        if (typeof renderOverview === 'function') renderOverview();
        if (typeof renderCompleted === 'function') renderCompleted();
        if (d.reconciled) {
          toast('Payment reconciled from Stripe');
        }
      }
    } catch (e) { /* fall back to list cache — do not clear jobs */ }
    const j = jobs.find(x => x.id===id);
    if (!j) return;
    activeJob = j;
    expandedJobId = id;
    if (!document.querySelector('#jobsTable tbody tr.job-row[data-id="'+CSS.escape(id)+'"]')) {
      renderJobs();
    }
    placeActiveDetailRow(id);
    markExpandedRow(id);
    $('#dTitle').textContent = cust(j)+' · '+id;
    $('#dBadges').innerHTML = jobBadge(j.jobStatus)+payBadge(j.paymentWorkflowStatus);
    const pendingCRs = pendingChangeRequestsOf(j);
    const pendingCount = pendingRequestCountOf(j);
    const legacyPending = !!(j.cancellationRequestStatus === 'requested' || j.rescheduledByClient || j.addressChangedByClient || j.requestedAddress);
    const defaultPanel = (openDrawerFocusRequests || pendingCRs.length || legacyPending) ? 'requests' : 'resolve';
    openDrawerFocusRequests = false;
    jobDetailDirty = false;
    const invPaidEarly = !!(j.invoicePaid || j.financialPaymentStatus==='paid' || j.paymentWorkflowStatus==='payment_succeeded' || j.paymentWorkflowStatus==='cash_paid' || (Number(j.remainingCents||0)===0 && Number(j.settledCents||0)>0));
    const balDueEarly = invPaidEarly ? 0 : Number(j.remainingCents!=null ? j.remainingCents/100 : (j.amountDueApproved||0));
    const paidAmtEarly = Number(j.amountPaid!=null ? j.amountPaid : ((j.settledCents||0)/100));
    const approvedEarly = Number(j.approvedFinalAmount!=null?j.approvedFinalAmount:(j.approvedCents||0)/100);
    let html = '<div class="appt-workspace appt-readonly" id="apptWorkspace">';
    // Say the workspace is locked, once, before the controls it locks.
    html += '<p class="appt-lock-hint" id="apptLockHint">'
      + '<span aria-hidden="true">🔒</span>'
      + '<span>Fields are locked. Use <strong>Edit</strong> to change this job.</span>'
      + '</p>';
    html += '<div class="appt-sticky-summary"><div class="appt-sticky-grid">'+
      '<div><span>Customer</span><strong>'+esc(cust(j))+'</strong></div>'+
      '<div><span>Reference</span><strong>'+esc(j.id||'')+'</strong></div>'+
      '<div><span>Status</span><strong>'+esc(String(j.jobStatus||'—').replace(/_/g,' '))+'</strong></div>'+
      '<div><span>Date / window</span><strong>'+esc(jobsDateTimeLabel(j))+'</strong></div>'+
      '<div><span>Vehicles</span><strong>'+esc(String(
        (j.vehicleCount != null && Number(j.vehicleCount) > 0)
          ? Number(j.vehicleCount)
          : ((Array.isArray(j.vehicles) && j.vehicles.length) ? j.vehicles.length : (typeof jobVehicles === 'function' ? (jobVehicles(j).length || 1) : 1))
      ))+'</strong></div>'+
      '<div><span>Approved</span><strong>$'+esc(approvedEarly.toFixed(2))+'</strong></div>'+
      '<div><span>Paid / balance</span><strong>$'+esc(paidAmtEarly.toFixed(2))+' / $'+esc(Math.max(0,balDueEarly).toFixed(2))+'</strong></div>'+
      '<div><span>Technician</span><strong>'+esc(j.assignedTechName||'Unassigned')+'</strong></div>'+
      '</div>'+
      '<div class="actions" style="margin-top:10px">'+
      '<button type="button" class="btn ghost sm" id="dEnableEdit" style="min-height:44px">Edit details</button>'+
      (j.jobStatus === 'pending_review' ? '<button type="button" class="btn sm" id="dConfirmHeader" style="min-height:44px">Confirm booking</button>' : '')+
      '</div></div>';
    if (pendingCount > 0) {
      html += '<div class="appt-pending-alert" role="status"><strong>'+pendingCount+' customer request'+(pendingCount===1?'':'s')+' pending</strong>'+
        '<div class="hint" style="margin:0 0 8px">Review to approve or decline. Pending requests stay above payment and history.</div>'+
        '<button type="button" class="btn sm" data-open-requests-panel style="min-height:44px">Review requests</button></div>';
    }
    html += '<div class="appt-panel-tabs" role="tablist" aria-label="Appointment panels">'+
      [['resolve','Resolve'],['services','Services'],['schedule','Schedule'],['payment','Money'],['create','Create'],['notes','Notes'],['more','More']].map(([id,label]) =>
        '<button type="button" class="appt-panel-tab" role="tab" data-workspace-tab="'+id+'" aria-selected="false" aria-controls="appt-panel-'+id+'">'+label+
        (id==='more' && pendingCount ? ' <span class="tab-badge">'+pendingCount+'</span>' : '')+
        '</button>'
      ).join('')+'</div>';
    html += '<div class="appt-panel" data-appt-panel="resolve" id="appt-panel-resolve" role="tabpanel" hidden><div class="job-detail-grid">';
    html += '<div class="sec span-2"><h4>Customer and appointment</h4><div class="op-grid">'+
      '<div><label>First name</label><input type="text" id="dFirst" value="'+esc(j.firstName||'')+'"></div>'+
      '<div><label>Last name</label><input type="text" id="dLast" value="'+esc(j.lastName||'')+'"></div>'+
      '<div><label>Phone</label><input type="tel" id="dPhone" value="'+esc(j.phone||'')+'"></div>'+
      '<div><label>Email</label><input type="email" id="dEmail" value="'+esc(j.email||'')+'"></div>'+
      '<div class="full appt-edit-actions"><button type="button" class="btn ghost sm" id="dSaveCustomer" style="width:100%;min-height:44px">Save customer contact</button></div>'+
      '<div class="full kv"><div><b>Booking ID:</b> '+esc(j.id||'')+'</div>'+
      '<div><b>Date:</b> '+esc(j.confirmedDate||j.preferredDate||'—')+'</div>'+
      '<div><b>Time / window:</b> '+esc(j.confirmedTime||j.confirmedTimeWindow||j.preferredTime||'—')+'</div></div>'+
      '</div></div>';
    html += '<div class="sec"><h4>Service address</h4><div class="op-grid">'+
      '<div class="full"><label>Service address</label><input type="text" id="dAddr" value="'+esc(j.address||'')+'"></div>'+
      '<div><label>ZIP</label><input type="text" id="dZip" value="'+esc(j.zipCode||'')+'"></div>'+
      '<div class="full appt-edit-actions"><button type="button" class="btn ghost sm" id="dSaveAddr" style="width:100%;min-height:44px">Save address</button></div>'+
      '</div></div>';
    html += (typeof SiteAccess !== 'undefined' ? '<div class="sec full">'+SiteAccess.adminSection(j, esc)+'</div>' : '');
    const invPaid = invPaidEarly;
    const balDue = balDueEarly;
    const paidAmt = paidAmtEarly;
    const approvedDisp = approvedEarly;
    const creditedDisp = Number(j.creditedCents != null ? j.creditedCents/100 : (j.amountRefunded || 0));
    html += '<div class="sec"><h4>Financial / status summary</h4><div class="kv">'+
      '<div><b>Approved:</b> $'+esc(String(approvedDisp.toFixed(2)))+'</div>'+
      '<div><b>Paid / settled:</b> $'+esc(String(paidAmt.toFixed(2)))+'</div>'+
      (creditedDisp > 0 ? '<div><b>Refunded / credited:</b> $'+esc(String(creditedDisp.toFixed(2)))+'</div>' : '')+
      '<div><b>Remaining:</b> $'+esc(String(Math.max(0,balDue).toFixed(2)))+'</div>'+
      '<div><b>Payment status:</b> '+payBadge(invPaid?'payment_succeeded':j.paymentWorkflowStatus)+'</div>'+
      '</div></div>';
    // Status & resolve — Admin authority lifecycle (confirm → assign → tech → complete → close)
    html += '<div class="sec span-2"><h4>Status and resolve</h4><div class="kv"><div><b>Tech:</b> '+esc(j.assignedTechName||'Unassigned')+'</div>'+
      '<div><b>Assigned:</b> '+dt(j.assignedAt)+'</div></div>'+
      '<select id="dAssign" style="margin-top:8px">'+techOptions(j.assignedTechId||j.assignedTech)+'</select>'+
      '<div class="actions" style="margin:10px 0">';
    if (j.jobStatus === 'pending_review') html += '<button type="button" class="btn sm" id="dConfirm" style="min-height:44px">Confirm booking</button>';
    html += '<button type="button" class="btn ghost sm" id="dCancel" style="min-height:44px">Cancel job</button>';
    html += '<button type="button" class="btn ghost sm" id="dReopenAppt" style="min-height:44px">Reopen</button>';
    if (j.jobStatus==='completed_pending_admin_review') html += '<button type="button" class="btn sm" id="dApprove" style="min-height:44px">Approve completion</button>';
    html += '</div>'+
      '<h4 style="margin-top:12px">Technician status</h4><div class="actions">'+
      '<button type="button" class="btn ghost sm" id="dTechEnRoute" style="min-height:44px">En Route</button>'+
      '<button type="button" class="btn ghost sm" id="dTechStart" style="min-height:44px">Start</button>'+
      '<button type="button" class="btn ghost sm" id="dTechPause" style="min-height:44px">Pause</button>'+
      '<button type="button" class="btn ghost sm" id="dTechResume" style="min-height:44px">Resume</button>'+
      '<button type="button" class="btn sm" id="dTechComplete" style="min-height:44px">Complete service</button>';
    const closeCap = drawerControls && drawerControls.closeWhenPaid;
    if (closeCap && closeCap.enabled) {
      html += '<button type="button" class="btn sm" id="dCloseWhenPaid" style="min-height:44px" title="'+esc(closeCap.explanation||'')+'">Close job when paid</button>';
    } else if (invPaid && String(j.jobStatus||'') !== 'completed_paid') {
      html += '<button type="button" class="btn ghost sm" id="dCloseWhenPaid" style="min-height:44px">Close job when paid</button>';
    }
    html += '</div>'+
      '<p class="hint" style="margin:8px 0 0">1) Complete service (work done) · 2) Record cash/card under Money · 3) Close job when paid (lifecycle only — does not change the ledger).</p>'+
      '</div>';
    html += '</div></div>'; // end resolve panel

    html += '<div class="appt-panel" data-appt-panel="services" id="appt-panel-services" role="tabpanel" hidden><div class="job-detail-grid">';
    html += renderVehiclesDetailSection(j);
    html += '<div class="sec"><h4>Service overrides</h4><div class="op-grid">'+
      '<div class="full"><label>Primary vehicle label</label><input type="text" id="dVehicle" value="'+esc(j.vehicleLabel||j.vehicle||'')+'"></div>'+
      (function(){
        // Canonical package IDs only — never free-form labels as money input.
        const cat = (drawerAddonData && drawerAddonData.packageCatalog) || null;
        const veh = cat && Array.isArray(cat.vehicles) && cat.vehicles.length
          ? (cat.vehicles.length === 1 ? cat.vehicles[0]
            : (cat.vehicles.find(v => v.vehicleId === (drawerAddonData && drawerAddonData.activePkgVehicleId)) || cat.vehicles[0]))
          : null;
        const opts = veh && Array.isArray(veh.options) ? veh.options : [];
        const currentId = veh && veh.currentPackageId ? veh.currentPackageId : '';
        if (!opts.length) {
          return '<div><label>Package</label><input type="text" id="dPackage" value="'+esc(currentId || j.packageId || j.pkgId || '')+'" disabled title="Canonical catalog unavailable — use Service package section"></div>';
        }
        return '<div><label>Package</label><select id="dPackage">'+
          opts.map(o => '<option value="'+esc(o.id)+'"'+(o.id===currentId?' selected':'')+'>'+esc(o.name)+'</option>').join('')+
          '</select></div>';
      })()+
      '<div class="full appt-edit-actions"><button type="button" class="btn ghost sm" id="dSaveService" style="width:100%;min-height:44px">Recalculate service (server)</button></div>'+
      '</div></div>';
    html += renderAddonSection(j);
    html += renderPackageSection(j);
    html += '</div></div>'; // end vehicles panel

    html += '<div class="appt-panel" data-appt-panel="requests" id="appt-panel-requests" role="tabpanel" hidden><div class="job-detail-grid">';
    html += '<div class="sec full"><h4>Customer requests</h4>';
    let hasReq = false;
    const embCards = renderEmbeddedChangeRequestCards(j);
    if (embCards) { hasReq = true; html += embCards; }
    if (j.cancellationRequestStatus === 'requested') {
      hasReq = true;
      html += '<div class="req-box"><strong>Cancellation requested</strong><div style="font-size:12px;color:var(--mu);margin:6px 0">'+esc(j.cancellationReason||'')+'</div>'+
        '<div class="actions"><button type="button" class="btn danger sm" id="dCancelYes" style="min-height:44px">Approve cancel</button>'+
        '<button type="button" class="btn ghost sm" id="dCancelNo" style="min-height:44px">Deny</button></div></div>';
    }
    if (j.rescheduledByClient) {
      hasReq = true;
      html += '<div class="req-box"><strong>Reschedule requested</strong><div style="font-size:12px;margin:6px 0">'+esc(j.rescheduleRequestedDate||'')+' '+esc(j.rescheduleRequestedTime||'')+'</div>'+
        '<button type="button" class="btn sm" id="dApplyResched" style="min-height:44px">Apply customer date</button></div>';
    }
    if (j.addressChangedByClient || j.requestedAddress) {
      hasReq = true;
      html += '<div class="req-box"><strong>Address change requested</strong><div style="font-size:12px;margin:6px 0">'+esc(j.requestedAddress||'')+'</div>'+
        '<button type="button" class="btn sm" id="dApplyAddr" style="min-height:44px">Apply new address</button></div>';
    }
    if (!hasReq) html += '<p class="hint" style="margin:0">No pending customer requests on this booking.</p>';
    const resolved = (Array.isArray(j.changeRequests) ? j.changeRequests : []).filter((r) => !isOpenChangeRequest(r));
    if (resolved.length) {
      html += '<details style="margin-top:12px"><summary style="cursor:pointer;color:var(--ac);min-height:44px;display:flex;align-items:center">Resolved request history ('+resolved.length+')</summary>'+
        resolved.map((r) => '<div class="ev" style="margin-top:8px"><strong>'+esc(requestTitle(r))+'</strong> · '+esc(r.status||'')+' · '+dt(r.decidedAt||r.createdAt)+'</div>').join('')+
        '</details>';
    }
    html += '</div></div></div>'; // end requests panel

    html += '<div class="appt-panel" data-appt-panel="schedule" id="appt-panel-schedule" role="tabpanel" hidden><div class="job-detail-grid">';
    if (j.scheduleFlexibility || j.preferredArrivalWindow || j.alternatePreferredDate) {
      const flexLabels = {
        exact: 'Exact date only',
        alternate_date: 'Has alternate date',
        within_3_days: 'Flexible within 3 days',
        earliest_after_date: 'First available on or after selected date',
      };
      const arrivalLabels = {
        '08:00-11:00': '8:00 AM – 11:00 AM',
        '09:00-12:00': '9:00 AM – 12:00 PM',
        '10:00-13:00': '10:00 AM – 1:00 PM',
        '11:00-14:00': '11:00 AM – 2:00 PM',
        '12:00-15:00': '12:00 PM – 3:00 PM',
        '13:00-16:00': '1:00 PM – 4:00 PM',
        '14:00-17:00': '2:00 PM – 5:00 PM',
        '15:00-18:00': '3:00 PM – 6:00 PM',
        '16:00-19:00': '4:00 PM – 7:00 PM',
        anytime: 'Any time that day — Best availability',
      };
      html += '<div class="sec full"><div class="sec-title">Schedule preference</div><div class="kv-grid">' +
        '<div class="kv"><span>Preferred date</span><strong>' + esc(j.preferredDate || '—') + '</strong></div>' +
        '<div class="kv"><span>Preferred arrival window</span><strong>' + esc(arrivalLabels[j.preferredArrivalWindow] || j.preferredArrivalWindow || '—') + '</strong></div>' +
        (j.alternatePreferredDate
          ? '<div class="kv"><span>Alternate date</span><strong>' + esc(j.alternatePreferredDate) + '</strong></div>'
          : '') +
        (j.alternateArrivalWindow
          ? '<div class="kv"><span>Alternate arrival window</span><strong>' + esc(arrivalLabels[j.alternateArrivalWindow] || j.alternateArrivalWindow) + '</strong></div>'
          : '') +
        '<div class="kv"><span>Date flexibility</span><strong>' + esc(flexLabels[j.scheduleFlexibility] || j.scheduleFlexibility || 'exact') + '</strong></div>' +
        '<div class="kv"><span>Confirmed date</span><strong>' + esc(j.confirmedDate || '—') + '</strong></div>' +
        '<div class="kv"><span>Confirmed arrival window</span><strong>' + esc(j.confirmedTimeWindow || j.confirmedTime || '—') + '</strong></div>' +
        '<div class="kv"><span>Operational slot</span><strong>' + esc(j.preferredTime || '—') + '</strong></div>' +
        '</div></div>';
    }
    html += '<div class="sec"><h4>Schedule</h4>'+
      '<div class="op-grid">'+
      '<div><label>Reschedule date</label><input type="date" id="dDate" value="'+esc((j.confirmedDate||j.preferredDate||'').slice(0,10))+'"></div>'+
      '<div><label>Time / window</label><input type="text" id="dTime" placeholder="e.g. 10:00 AM or Morning" value="'+esc(j.confirmedTime||j.confirmedTimeWindow||j.preferredTime||'')+'"></div>'+
      '<div class="full appt-edit-actions"><button type="button" class="btn ghost sm" id="dResched" style="width:100%;min-height:44px">Save reschedule</button></div>'+
      '</div>'+
      '<p class="hint">Lifecycle actions (confirm, assign, complete, close) live under Resolve.</p></div>';
    html += '</div></div>'; // end schedule panel

    html += '<div class="appt-panel" data-appt-panel="payment" id="appt-panel-payment" role="tabpanel" hidden><div class="job-detail-grid">';
    html += '<div class="sec span-2"><h4>Offers and payment actions</h4>';
    html += '<div class="sec" style="margin:0 0 12px"><h4>Welcome offer (WELCOME10)</h4>';
    const offer = j.offer || j.welcomeOffer || null;
    if (offer && offer.eligibility_status === 'eligible') {
      html += '<div class="kv">'+
        '<div><b>Status:</b> '+esc(offer.public_name || 'Welcome offer')+'</div>'+
        '<div><b>Eligible subtotal:</b> $'+((offer.eligible_subtotal||0)/100).toFixed(2)+'</div>'+
        '<div><b>Discount:</b> -$'+((offer.discount_amount||0)/100).toFixed(2)+' ('+esc(offer.percent||10)+'%, cap $'+((offer.cap_cents||4000)/100).toFixed(0)+')</div>'+
        '<div><b>Redemption:</b> '+esc(offer.redemption_status||'pending')+'</div>'+
        '<div><b>Reason:</b> '+esc(offer.eligibility_reason||'—')+'</div>'+
        '</div>';
    } else {
      html += '<div class="kv"><div><b>Status:</b> '+(offer?esc(offer.eligibility_status||'ineligible'):'No offer applied')+'</div>'+
        (offer?'<div><b>Reason:</b> '+esc(offer.eligibility_reason||'—')+'</div>':'')+'</div>';
    }
    if (Array.isArray(j.offerAudit) && j.offerAudit.length) {
      html += '<div style="font-size:11px;color:var(--mu);margin-top:8px">Audit: '+j.offerAudit.slice(-3).map(a=>esc(a.action+' · '+a.at)).join(' · ')+'</div>';
    }
    html += '<div class="actions" style="margin-top:10px">'+
      '<button type="button" class="btn sm" id="dOfferApply" style="min-height:44px">Apply welcome offer</button>'+
      '<button type="button" class="btn ghost sm" id="dOfferRemove" style="min-height:44px">Remove offer</button></div></div>';
    html += '<div class="sec" style="margin:0 0 12px"><h4>Job balance</h4><div class="kv">'+
      '<div><b>Customer total:</b> $'+(j.totalPrice!=null?j.totalPrice:'—')+'</div>'+
      '<div><b>Tech payout:</b> $'+(j.techPayoutAmount!=null?j.techPayoutAmount:'—')+'</div>'+
      '<div><b>Platform fee:</b> $'+(j.platformFeeAmount!=null?j.platformFeeAmount:(j.totalPrice!=null&&j.techPayoutAmount!=null?(j.totalPrice-j.techPayoutAmount).toFixed(2):'—'))+'</div>'+
      '</div>'+
      '<div class="op-grid" style="margin-top:8px">'+
      '<div><label>Final amount ($)</label><input type="number" id="dFinalAmt" step="0.01" value="'+(j.finalAmount!=null?j.finalAmount:(j.totalPrice||''))+'"></div>'+
      '<div><label>Tech payout ($)</label><input type="number" id="dTechPay" step="0.01" value="'+(j.techPayoutAmount!=null?j.techPayoutAmount:'')+'"></div>'+
      '<div class="full appt-edit-actions"><button type="button" class="btn ghost sm" id="dSaveBal" style="width:100%;min-height:44px">Save balance</button></div></div></div>';
    const stripeRef = j.stripeCheckoutSessionIdPrefix || j.paymentIntentIdPrefix || '';
    const cashCapPay = drawerControls && drawerControls.recordCash;
    const cardCapPay = drawerControls && drawerControls.recordCardOnSite;
    const expectedCash = cashCapPay ? Number(cashCapPay.expectedAmountCents) || 0 : Math.round(Math.max(0, balDue) * 100);
    html += '<div class="sec" style="margin:0"><h4>Invoice / Payment</h4>'+
      '<div style="margin-bottom:10px">'+payBadge(invPaid?'payment_succeeded':j.paymentWorkflowStatus)+
      (invPaid?' <strong style="color:var(--ok)">· PAID</strong>':' <strong>· Balance due</strong>')+
      (j.payLink && !invPaid?' <a href="'+esc(j.payLink)+'" target="_blank" rel="noopener">Pay link</a>':'')+
      (j.policyChargeStatus?(' · Policy charge: '+esc(j.policyChargeStatus)+(j.policyChargeAmount?' $'+j.policyChargeAmount:'')):'' )+'</div>'+
      '<div class="kv" style="margin-bottom:10px">'+
      '<div><b>Approved total:</b> $'+esc(String(approvedDisp.toFixed(2)))+'</div>'+
      '<div><b>Paid:</b> $'+esc(String(paidAmt.toFixed(2)))+'</div>'+
      '<div><b>Balance:</b> $'+esc(String(Math.max(0,balDue).toFixed(2)))+'</div>'+
      (stripeRef?'<div><b>Stripe:</b> '+esc(stripeRef)+'…</div>':'')+
      '</div>'+
      (invPaid?'<p class="hint">Settlement paid the invoice. Service status remains independent — use Close job when paid under Resolve after work is done.</p>':'')+
      '<div class="op-grid">'+
      '<div class="full"><label>Payment preference</label>'+
      '<p class="hint" style="margin:0">'+esc(String(j.paymentMethodPreference||'not set').replace(/_/g,' '))+
      ' — change it in the Payment method section below.</p></div>'+
      '<div class="full" hidden aria-hidden="true"><label>Legacy hosted Checkout (disabled)</label><input type="url" id="dPayLink" value="'+esc(j.payLink||'')+'" disabled></div>'+
      '<div class="full"><label>Manual external reference (optional)</label><input type="url" id="dManualPayRef" placeholder="https://… external note only" value="'+esc(j.manualPayLink||'')+'"'+(invPaid?' disabled':'')+'></div>'+
      '<div class="full actions">'+
      '<button type="button" class="btn ghost sm" id="dReconcileStripe" style="min-height:44px">Reconcile with Stripe</button>'+
      '<button type="button" class="btn ghost sm" id="dSetPayLink" style="min-height:44px"'+(invPaid?' disabled':'')+'>Save manual reference</button>'+
      '</div>'+
      '<p class="hint">Customers pay with the embedded Payment Element in My Garage. Hosted Checkout and manual policy charges are isolated. Reconcile is exceptional recovery only.</p>'+
      '<div class="full" style="margin-top:8px;padding:10px;border:1px solid var(--line);border-radius:8px">'+
      '<h4 style="margin:0 0 8px">Record cash / card on-site</h4>'+
      (cashCapPay && cashCapPay.blockedByPaymentAttempt
        ? '<p class="hint" style="color:var(--warn)">'+esc(cashCapPay.explanation||'Payment attempt in progress')+'</p>'
        : '')+
      '<div class="op-grid">'+
      '<div><label>Cash amount ($)</label><input type="text" id="dCashAmt" data-edit-enabled="1" inputmode="decimal" placeholder="'+(expectedCash?(expectedCash/100).toFixed(2):'')+'" value="'+(expectedCash?(expectedCash/100).toFixed(2):'')+'"'+(cashCapPay&&!cashCapPay.enabled?' disabled':'')+'></div>'+
      '<div class="full"><label>Cash reason / evidence</label><input type="text" id="dCashReason" data-edit-enabled="1" placeholder="Cash received in person" value="Cash received in person"'+(cashCapPay&&!cashCapPay.enabled?' disabled':'')+'></div>'+
      '<div class="full actions"><button type="button" class="btn sm" id="dMarkCash" style="min-height:44px"'+(cashCapPay&&!cashCapPay.enabled?' disabled':'')+'>Record cash payment</button></div>'+
      '<div class="full"><label>Card terminal reference (no card number)</label><input type="text" id="dCardRef" data-edit-enabled="1" placeholder="Terminal / auth reference"'+(cardCapPay&&!cardCapPay.enabled?' disabled':'')+'></div>'+
      '<div class="full"><label>Card reason / evidence</label><input type="text" id="dCardReason" data-edit-enabled="1" placeholder="Card payment received on site" value="Card payment received on site"'+(cardCapPay&&!cardCapPay.enabled?' disabled':'')+'></div>'+
      '<div class="full actions"><button type="button" class="btn sm" id="dMarkCardSite" style="min-height:44px"'+(cardCapPay&&!cardCapPay.enabled?' disabled':'')+'>Record card on-site</button></div>'+
      '</div>'+
      '<p class="hint">Leave cash amount blank to settle the full remaining balance on the server. Cash/card settle money only — they do not close the job.</p>'+
      '</div>'+
      '<div class="full"><label>Refund note</label><input type="text" id="dRefundNote" placeholder="Reason for refund request"></div>'+
      '<div><label>Refund amount ($)</label><input type="number" id="dRefundAmt" step="0.01"></div>'+
      '<div class="full actions">'+
      '<button type="button" class="btn warn sm" id="dRefund" style="min-height:44px">Issue Stripe refund</button>'+
      '</div>'+
      (j.paymentWorkflowStatus==='refunded'||j.refundStatus==='refunded'?'<p class="hint">Payment status: refunded</p>':'')+
      '<div class="full actions" style="margin-top:8px">'+
      '<button type="button" class="btn ghost sm" id="dApproveAdj" style="min-height:44px">Approve adjustment</button>'+
      '<button type="button" class="btn ghost sm" id="dRejectAdj" style="min-height:44px">Reject adjustment</button>'+
      '</div>'+
      '</div></div></div>';
    html += operationalControlsHtml();
    html += '</div></div>'; // end payment panel

    html += '<div class="appt-panel" data-appt-panel="create" id="appt-panel-create" role="tabpanel" hidden><div class="job-detail-grid">';
    html += '<div class="sec full"><h4>New appointment from this booking</h4>'+
      '<p class="hint">Creates a new booking prefilled with this customer, address, and vehicle package. Does not copy payments or lifecycle status.</p>'+
      '<div class="kv" style="margin:8px 0">'+
      '<div><b>Customer:</b> '+esc(cust(j))+'</div>'+
      '<div><b>Phone:</b> '+esc(j.phone||'—')+'</div>'+
      '<div><b>Email:</b> '+esc(j.email||'—')+'</div>'+
      '<div><b>Address:</b> '+esc(j.address||'—')+' · '+esc(j.zipCode||'')+'</div>'+
      '<div><b>Package:</b> '+esc(j.packageId||j.package||'—')+'</div>'+
      '</div>'+
      '<div class="actions"><button type="button" class="btn sm" id="dCreateFromBooking" style="min-height:44px">Create appointment from this booking</button></div>'+
      '</div></div></div>'; // end create panel

    html += '<div class="appt-panel" data-appt-panel="notes" id="appt-panel-notes" role="tabpanel" hidden><div class="job-detail-grid">';
    html += '<div class="sec full"><h4>Customer notes</h4>'+
      (j.notes || j.customerNote
        ? '<pre style="font-size:12px;white-space:pre-wrap;color:var(--mu);margin:0">'+esc(j.notes || j.customerNote)+'</pre>'
        : '<p class="hint" style="margin:0">No customer notes on this appointment.</p>')+
      '</div>';
    html += '<div class="sec full"><h4>Internal notes</h4>'+
      (j.adminNotes
        ? '<pre style="font-size:12px;white-space:pre-wrap;color:var(--mu);margin:0">'+esc(j.adminNotes)+'</pre>'
        : '<p class="hint" style="margin:0">No internal notes on this appointment.</p>')+
      '</div>';
    html += '</div></div>';
    html += '<div class="appt-panel" data-appt-panel="more" id="appt-panel-more" role="tabpanel" hidden><div class="job-detail-grid">';
    html += '<div class="sec" style="margin:0 0 12px"><h4>Dispatch</h4><div class="actions">'+
      '<button type="button" class="btn sm" id="dPostAuc" style="min-height:44px">Post to auction</button>'+
      '<button type="button" class="btn ghost sm" id="dAssignWin" style="min-height:44px">Assign auction winner</button></div></div>';
    html += '<div class="sec full"><h4>Notes and history</h4>';
    html += '<div class="sec" style="margin:0 0 12px"><h4>Customer requests</h4>'+
      '<p class="hint" style="margin:0 0 8px">Approve or decline change requests for this appointment.</p>'+
      '<button type="button" class="btn ghost sm" data-open-requests-panel style="min-height:44px">Open requests</button></div>';
    if (j.completionSubmitted || j.customerSignature) {
      html += '<div class="sec" style="margin:0 0 12px"><h4>Completion</h4><div class="kv">'+
        '<div><b>Submitted:</b> '+dt(j.completedAt)+'</div>'+
        (j.completionNotes?'<div><b>Notes:</b> '+esc(j.completionNotes)+'</div>':'')+
        (j.issueNotes?'<div><b>Issue:</b> '+esc(j.issueNotes)+'</div>':'')+
        '</div>';
      if ((j.photosBefore||[]).length || (j.photosAfter||[]).length) {
        html += '<div style="margin-top:10px"><h4 style="font-size:11px;color:var(--mu);margin-bottom:6px">JOB PHOTOS</h4>';
        if ((j.photosBefore||[]).length) {
          html += '<div style="font-size:11px;color:var(--mu);margin-bottom:4px">Before</div><div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">'+
            j.photosBefore.map(u=>'<a href="'+esc(u)+'" target="_blank" rel="noopener"><img src="'+esc(u)+'" style="width:72px;height:72px;object-fit:cover;border-radius:8px;border:1px solid var(--line)"></a>').join('')+'</div>';
        }
        if ((j.photosAfter||[]).length) {
          html += '<div style="font-size:11px;color:var(--mu);margin-bottom:4px">After</div><div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">'+
            j.photosAfter.map(u=>'<a href="'+esc(u)+'" target="_blank" rel="noopener"><img src="'+esc(u)+'" style="width:72px;height:72px;object-fit:cover;border-radius:8px;border:1px solid var(--line)"></a>').join('')+'</div>';
        }
        html += '</div>';
      }
      if (j.customerPrintedName) html += '<div style="margin-top:8px"><b>Customer:</b> '+esc(j.customerPrintedName)+
        (j.customerSignature&&j.customerSignature.startsWith('data:')?'<img class="sig" src="'+j.customerSignature+'" alt="Customer signature">':'')+'</div>';
      if (j.technicianPrintedName) html += '<div style="margin-top:8px"><b>Technician:</b> '+esc(j.technicianPrintedName)+
        (j.technicianSignature&&j.technicianSignature.startsWith('data:')?'<img class="sig" src="'+j.technicianSignature+'" alt="Tech signature">':'')+'</div>';
      html += '<div class="actions" style="margin-top:12px">'+
        '<button type="button" class="btn ghost sm" id="dReopen" style="min-height:44px">Reopen job</button>'+
        '<button type="button" class="btn ghost sm" id="dCorrect" style="min-height:44px">Request correction</button></div></div>';
    }
    const evs = (j.eventLog||[]).slice().reverse();
    html += '<details open style="margin:0 0 12px"><summary style="cursor:pointer;min-height:44px;display:flex;align-items:center;color:var(--mu);text-transform:uppercase;letter-spacing:.07em;font-size:11px;font-weight:700">Event log</summary><div class="sec" style="margin:8px 0 0">'+(evs.length?evs.map(e=>'<div class="ev"><time>'+dt(e.at)+'</time><strong>'+esc(e.action||'')+'</strong> '+
      (e.by?'('+esc(e.by)+') ':'')+(e.note?esc(e.note):'')+(e.message?esc(e.message):'')+'</div>').join(''):'<div class="empty">No events</div>')+'</div></details>';
    html += '<details style="margin:0 0 12px"><summary style="cursor:pointer;min-height:44px;display:flex;align-items:center;color:var(--mu);text-transform:uppercase;letter-spacing:.07em;font-size:11px;font-weight:700">Operational audit</summary><div class="sec" id="dAuditSec" style="margin:8px 0 0"><div class="empty">Loading audit…</div></div></details>';
    html += '<div class="appt-danger-zone"><h4 style="margin:0 0 8px">Destructive and archival actions</h4><div class="actions">'+
      '<button type="button" class="btn warn sm" id="dArchive" style="min-height:44px">Archive as test</button></div></div>';
    // Customer access last — Admin-first hub; portal follows Admin.
    html += '<div class="sec" style="margin:16px 0 0"><h4>Customer access</h4><div class="actions">'+
      '<button type="button" class="btn sm" id="dGenCompletion" style="min-height:44px">Generate completion link</button>'+
      '<button type="button" class="btn ghost sm" id="dGenGarage" style="min-height:44px">My Garage link</button>'+
      '<button type="button" class="btn ghost sm" id="dCopyCustomerLink" style="min-height:44px">Copy last link</button></div>'+
      (j.completionLinkUrl?'<p class="hint">Completion: '+esc(j.completionLinkUrl)+'</p>':'')+
      (j.myGarageLinkUrl?'<p class="hint">My Garage: '+esc(j.myGarageLinkUrl)+'</p>':'')+
      (j.notificationDelivery?'<p class="hint">Notifications — admin: '+esc((j.notificationDelivery.adminEmail&&j.notificationDelivery.adminEmail.status)||'—')+
        ' · customer: '+esc((j.notificationDelivery.customerEmail&&j.notificationDelivery.customerEmail.status)||'—')+'</p>':'')+
      '</div>';
    html += '</div></div>'; // end more panel
    html += '</div>'; // end workspace
    $('#dBody').innerHTML = html;
    bindApptWorkspace(j, defaultPanel);
    bindEmbeddedChangeRequestActions(j);
    const dConfirmHeader = $('#dConfirmHeader');
    if (dConfirmHeader) dConfirmHeader.onclick = () => confirmBookingOnce(j.id, [dConfirmHeader, $('#dConfirm'), $('#dStickyConfirm')]);
    $('#dNote').value = '';
    bindAddonSection(j);
    bindPackageSection(j);
    bindVehicleMutationSection(j);
    const da = $('#dAssign');
    if (da) {
      da.onchange = () => onAssign(j.id, da.value);
      const kick = () => { ensureAssignOptionsLoaded(da); };
      da.addEventListener('mousedown', kick);
      da.addEventListener('focus', kick);
      da.addEventListener('touchstart', kick, { passive: true });
    }
    const ap = $('#dApprove'); if(ap) ap.onclick = () => jobAction(j.id,'approve_completion');
    const ro = $('#dReopen');
    if (ro) {
      const canReopen = !drawerControls || (drawerControls.reopen && drawerControls.reopen.enabled);
      if (!canReopen) {
        ro.disabled = true;
        ro.title = (drawerControls.reopen && drawerControls.reopen.explanation) || 'Reopen is not available for this job.';
      } else {
        // A reason is mandatory server-side; an empty prompt is not a reopen.
        ro.onclick = () => {
          const r = prompt('Reopen reason (required):');
          if (!r || !r.trim()) { if (r !== null) toast('A reopen reason is required'); return; }
          jobAction(j.id,'reopen_job', {
            reason: r.trim(),
            expectedBookingVersion: j.bookingVersion,
            notifyCustomer: confirm('Notify the customer that this job has reopened?'),
          });
        };
      }
    }
    const co = $('#dCorrect'); if(co) co.onclick = () => { const m=prompt('Correction message:'); if(m) jobAction(j.id,'request_correction',{message:m}); };
    const dc = $('#dConfirm');
    const dca = $('#dCancel');
    const stickyConfirm = $('#dStickyConfirm');
    if (dc) dc.onclick = () => confirmBookingOnce(j.id, [dc, stickyConfirm]);
    if (dca) dca.onclick = () => { const r=prompt('Cancel reason:'); if(r!==null) jobAction(j.id,'cancel_booking',{reason:r}); };
    bindStickyJobActions(j, { confirmBtn: dc, cancelBtn: dca });
    const da2 = $('#dArchive'); if(da2) da2.onclick = () => { if(confirm('Archive this booking as test?')) jobAction(j.id,'archive_test'); };
    const dr = $('#dResched'); if(dr) dr.onclick = () => jobAction(j.id,'reschedule',{confirmedDate:$('#dDate').value,confirmedTime:$('#dTime').value,confirmedTimeWindow:$('#dTime').value});
    const dsa = $('#dSaveAddr'); if(dsa) dsa.onclick = () => jobAction(j.id,'update_address',{address:$('#dAddr').value,zipCode:$('#dZip').value});
    const dsc = $('#dSaveCustomer'); if(dsc) dsc.onclick = () => jobAction(j.id,'update_customer',{firstName:$('#dFirst').value,lastName:$('#dLast').value,phone:$('#dPhone').value,email:$('#dEmail').value});
    const dss = $('#dSaveService'); if(dss) dss.onclick = () => {
      const packageId = ($('#dPackage') && $('#dPackage').value) || '';
      const data = drawerAddonData || {};
      const expectedBookingVersion = data.bookingVersion != null ? data.bookingVersion : j.bookingVersion;
      const body = { packageId: packageId, vehicleLabel: $('#dVehicle').value };
      if (expectedBookingVersion != null && expectedBookingVersion !== '') body.expectedBookingVersion = expectedBookingVersion;
      const vehEl = $('#dPkgVehicle');
      if (vehEl && vehEl.value) body.vehicleId = vehEl.value;
      jobAction(j.id,'update_service', body);
    };
    const dro = $('#dReopenAppt');
    if (dro) dro.onclick = () => {
      const r = prompt('Reopen reason (required):');
      if (!r || !r.trim()) { if (r !== null) toast('A reopen reason is required'); return; }
      jobAction(j.id,'reopen_appointment', {
        reason: r.trim(),
        expectedBookingVersion: j.bookingVersion,
        notifyCustomer: confirm('Notify the customer that this job has reopened?'),
      });
    };
    const dte = $('#dTechEnRoute'); if(dte) dte.onclick = () => jobAction(j.id,'admin_tech_status',{statusAction:'en_route'});
    const dts = $('#dTechStart'); if(dts) dts.onclick = () => jobAction(j.id,'admin_tech_status',{statusAction:'start'});
    const dtp = $('#dTechPause'); if(dtp) dtp.onclick = () => jobAction(j.id,'admin_tech_status',{statusAction:'pause'});
    const dtr = $('#dTechResume'); if(dtr) dtr.onclick = () => jobAction(j.id,'admin_tech_status',{statusAction:'resume'});
    const dtc = $('#dTechComplete'); if(dtc) dtc.onclick = () => jobAction(j.id,'admin_tech_status',{statusAction:'complete_service'});
    const dcwp = $('#dCloseWhenPaid');
    if (dcwp) {
      dcwp.onclick = () => {
        if (!confirm('Close this job as paid? Money is already settled — this only updates lifecycle status.')) return;
        jobAction(j.id, 'close_job', { expectedBookingVersion: j.bookingVersion });
      };
    }
    const dmc = $('#dMarkCash');
    if (dmc) {
      const cashCap = drawerControls && drawerControls.recordCash;
      if (cashCap && !cashCap.enabled) {
        dmc.disabled = true;
        dmc.title = cashCap.explanation || 'No remaining balance to collect.';
      } else {
        dmc.onclick = () => {
          if (cashCap && cashCap.blockedByPaymentAttempt) {
            toast(cashCap.explanation || 'payment_attempt_in_progress');
            return;
          }
          const expected = cashCap ? Number(cashCap.expectedAmountCents) || 0 : 0;
          const rawAmt = ($('#dCashAmt') && $('#dCashAmt').value) || '';
          const reason = (($('#dCashReason') && $('#dCashReason').value) || '').trim();
          if (!reason) { toast('A reason is required'); return; }
          const payload = {
            reason,
            expectedBookingVersion: j.bookingVersion,
          };
          if (String(rawAmt).trim()) {
            const parsed = parseCashAmountInput(rawAmt);
            if (!parsed.ok) { toast('Enter a valid cash amount (e.g. 175.00) — $ and commas are stripped'); return; }
            if (expected > 0 && parsed.cents !== expected) {
              toast('Cash must equal remaining $' + (expected / 100).toFixed(2) + ' (got $' + parsed.text + ')');
              return;
            }
            // Prefer omit when exact — server settles remainingCents from Postgres.
            if (!(expected > 0 && parsed.cents === expected)) {
              payload.amount = parsed.text;
            }
          }
          // Blank amount → omit amount; server liquidates remainingCents.
          if (!confirm('Record cash against this booking? The customer is emailed a confirmation.')) return;
          jobAction(j.id, 'mark_cash_received', payload);
        };
      }
    }
    const dspm = $('#dSavePayMethod');
    if (dspm) dspm.onclick = () => {
      const reason = ($('#dPayMethodReason') && $('#dPayMethodReason').value || '').trim();
      if (!reason) { toast('A reason is required to change the payment method'); return; }
      jobAction(j.id,'update_payment_preference', {
        paymentMethodPreference: $('#dPayMethod').value,
        reason,
        expectedBookingVersion: j.bookingVersion,
      });
    };
    const dcm = $('#dCorrectMethodBtn');
    if (dcm) dcm.onclick = () => {
      const reason = ($('#dCorrectReason') && $('#dCorrectReason').value || '').trim();
      const evidence = ($('#dCorrectEvidence') && $('#dCorrectEvidence').value || '').trim();
      if (!reason || evidence.length < 10) { toast('A reason and supporting evidence are required'); return; }
      jobAction(j.id,'correct_payment_method', {
        correctedMethod: $('#dCorrectMethod').value,
        reason,
        evidence,
        expectedBookingVersion: j.bookingVersion,
      });
    };
    const dap = $('#dAdjPrice');
    if (dap) dap.onclick = () => {
      const reason = ($('#dAdjReason') && $('#dAdjReason').value || '').trim();
      const amountCents = Number($('#dAdjAmount') && $('#dAdjAmount').value);
      if (!reason) { toast('A reason is required for a price adjustment'); return; }
      if (!(amountCents > 0)) { toast('Enter the adjustment amount in cents'); return; }
      jobAction(j.id,'price_adjustment', {
        op: 'create',
        type: $('#dAdjType').value,
        amountCents,
        reason,
        expectedBookingVersion: j.bookingVersion,
      });
    };
    const dmcs = $('#dMarkCardSite'); if(dmcs) dmcs.onclick = () => {
      const cardCap = drawerControls && drawerControls.recordCardOnSite;
      if (cardCap && cardCap.blockedByPaymentAttempt) {
        toast(cardCap.explanation || 'payment_attempt_in_progress');
        return;
      }
      if (cardCap && !cardCap.enabled) {
        toast(cardCap.explanation || 'No remaining balance to collect.');
        return;
      }
      const ref = (($('#dCardRef') && $('#dCardRef').value) || '').trim();
      if (!ref) { toast('Enter the card terminal reference'); return; }
      const reason = (($('#dCardReason') && $('#dCardReason').value) || '').trim();
      if (!reason) { toast('A reason is required'); return; }
      if (!confirm('Record card on-site for the remaining balance?')) return;
      jobAction(j.id,'mark_card_on_site',{
        reference: ref,
        reason,
        expectedBookingVersion: j.bookingVersion,
      });
    };
    const dcfb = $('#dCreateFromBooking');
    if (dcfb) {
      dcfb.onclick = async () => {
        if (!confirm('Create a new appointment from this booking’s customer and service details?')) return;
        const packageId = j.packageId || j.pkgId || 'interior';
        const vehicles = Array.isArray(j.vehicles) && j.vehicles.length
          ? j.vehicles.map((v) => ({
            cat: v.category || v.cat || j.vehicleCategory || 'cars',
            pkgId: v.packageId || v.pkgId || packageId,
            tierKey: v.tierKey || 'small',
            tierLabel: v.tierLabel || v.tier || j.vehicleTier || 'Small Car',
            year: v.year || '',
            make: v.make || '',
            model: v.model || '',
            lengthFt: v.lengthFt || v.vehicleLengthFt || undefined,
          }))
          : [{
            cat: j.vehicleCategory || 'cars',
            pkgId: packageId,
            tierKey: 'small',
            tierLabel: j.vehicleTier || 'Small Car',
          }];
        try {
          const d = await api('/.netlify/functions/admin-ops-jobs', 'POST', {
            action: 'create_appointment',
            firstName: j.firstName || cust(j).split(' ')[0] || 'Customer',
            lastName: j.lastName || '',
            phone: j.phone || '',
            email: j.email || '',
            address: j.address || '',
            zipCode: j.zipCode || '',
            packageId,
            package: j.package || j.service || '',
            vehicleCategory: j.vehicleCategory || 'cars',
            vehicleTier: j.vehicleTier || vehicles[0].tierLabel,
            vehicleLabel: j.vehicleLabel || j.vehicle || '',
            vehicles,
            reason: 'fork_from_' + (j.id || 'booking'),
          });
          toast('Appointment created: ' + d.bookingId);
          await refreshAll();
          if (d.bookingId) openDrawer(d.bookingId);
        } catch (e) {
          toast('Create failed: ' + formatActionError(e));
        }
      };
    }
    document.querySelectorAll('.adj-decide').forEach((btn) => {
      btn.onclick = () => {
        const decision = btn.dataset.decision;
        if (decision === 'approve' && !confirm('Confirm that the customer approved this adjustment?')) return;
        const reason = decision === 'decline' ? (prompt('Decline reason:') || '').trim() : '';
        if (decision === 'decline' && !reason) { toast('A decline reason is required'); return; }
        jobAction(j.id, 'price_adjustment', {
          op: 'decide',
          adjustmentId: btn.dataset.id,
          decision,
          reason,
          expectedBookingVersion: j.bookingVersion,
        });
      };
    });
    document.querySelectorAll('.adj-apply').forEach((btn) => {
      btn.onclick = () => {
        if (!confirm('Apply this approved adjustment and create a new immutable quote version?')) return;
        jobAction(j.id, 'price_adjustment', {
          op: 'apply',
          adjustmentId: btn.dataset.id,
          expectedBookingVersion: j.bookingVersion,
        });
      };
    });
    const daa2 = $('#dApproveAdj'); if(daa2) daa2.onclick = () => jobAction(j.id,'approve_adjustment',{approvedFinalAmount:$('#dFinalAmt').value});
    const dra = $('#dRejectAdj'); if(dra) dra.onclick = () => { const r=prompt('Rejection reason:'); if(r) jobAction(j.id,'reject_adjustment',{reason:r}); };
    let lastCustomerLink = '';
    const dgc = $('#dGenCompletion'); if(dgc) dgc.onclick = async () => {
      try {
        const d = await jobAction(j.id,'generate_customer_link',{linkType:'completion'});
        lastCustomerLink = d.url||'';
        if (!lastCustomerLink) { toast('Completion link was empty — try again or check token secrets'); return; }
        await navigator.clipboard.writeText(lastCustomerLink).catch(()=>{});
        toast('Completion link copied');
      } catch(e) { toast('Completion link failed: ' + formatActionError(e)); }
    };
    const dgg = $('#dGenGarage'); if(dgg) dgg.onclick = async () => {
      try {
        const d = await jobAction(j.id,'generate_customer_link',{linkType:'my_garage'});
        lastCustomerLink = d.url||'';
        if (!lastCustomerLink) { toast('My Garage link was empty — try again or check site URL / secrets'); return; }
        await navigator.clipboard.writeText(lastCustomerLink).catch(()=>{});
        toast('My Garage link copied');
      } catch(e) { toast('My Garage link failed: ' + formatActionError(e)); }
    };
    const dcl = $('#dCopyCustomerLink'); if(dcl) dcl.onclick = async () => {
      const u = lastCustomerLink || j.completionLinkUrl || j.myGarageLinkUrl || '';
      if(!u){ toast('Generate a link first'); return; }
      await navigator.clipboard.writeText(u).catch(()=>{}); toast('Copied');
    };
    api('/.netlify/functions/admin-ops-jobs','POST',{action:'list_audit',bookingId:j.id}).then(d=>{
      const sec = $('#dAuditSec');
      if(!sec) return;
      const rows = (d.audit||[]).slice().reverse();
      sec.innerHTML = (rows.length?rows.map(a=>'<div class="ev"><time>'+dt(a.timestamp)+'</time><strong>'+esc(a.action)+'</strong> · '+esc(a.actor_type)+' · '+esc(a.reason||'')+'</div>').join(''):'<div class="empty">No audit entries</div>');
    }).catch(()=>{});
    const dcy = $('#dCancelYes'); if(dcy) dcy.onclick = () => jobAction(j.id,'resolve_cancellation',{decision:'approved'});
    const dcn = $('#dCancelNo'); if(dcn) dcn.onclick = () => { const n=prompt('Denial note:'); if(n!==null) jobAction(j.id,'resolve_cancellation',{decision:'denied',note:n}); };
    const dar = $('#dApplyResched'); if(dar) dar.onclick = () => jobAction(j.id,'apply_customer_request',{requestType:'reschedule'});
    const daa = $('#dApplyAddr'); if(daa) daa.onclick = () => jobAction(j.id,'apply_customer_request',{requestType:'address'});
    const dpa = $('#dPostAuc'); if(dpa) dpa.onclick = () => jobAction(j.id,'post_to_auction');
    const daw = $('#dAssignWin'); if(daw) daw.onclick = () => jobAction(j.id,'assign_auction_winner');
    const dspl = $('#dSetPayLink'); if(dspl) dspl.onclick = async () => {
      try {
        const url = ($('#dManualPayRef') && $('#dManualPayRef').value.trim()) || ($('#dPayLink').value||'').trim();
        if(!url){ toast('Paste an external reference URL first'); return; }
        const d = await api('/.netlify/functions/admin-ops-jobs','POST',{action:'set_payment_link',bookingId:j.id,payLink:url});
        toast(d.note || 'Manual reference saved (not authoritative)');
        await refreshAll(); if(activeJob&&activeJob.id===j.id) openDrawer(j.id);
      } catch(e){ toast(e.message); }
    };
    const dgpl = $('#dGenPayLink'); if(dgpl) dgpl.onclick = async () => {
      try {
        if(dgpl.disabled){ toast('Invoice paid or zero balance — link not created.'); return; }
        if(!confirm('Generate Stripe Checkout for the authoritative remaining balance? Amount cannot be overridden.')) return;
        const d = await api('/.netlify/functions/admin-ops-jobs','POST',{action:'generate_stripe_pay_link',bookingId:j.id});
        if(d.reused){ toast('Reusing open Stripe link · $'+(d.amountDueApproved!=null?d.amountDueApproved:(d.remainingCents/100))); }
        if(d.url){ $('#dPayLink').value = d.url; await navigator.clipboard.writeText(d.url).catch(()=>{}); toast((d.reused?'Existing':'Stripe')+' link ready · $'+(d.amountDueApproved!=null?d.amountDueApproved:(d.remainingCents/100))); await refreshAll(); if(activeJob&&activeJob.id===j.id) openDrawer(j.id); }
      } catch(e){ toast(e.message || 'Could not generate pay link'); }
    };
    const drec = $('#dReconcileStripe'); if(drec) drec.onclick = async () => {
      const cap = drawerControls && drawerControls.reconcileStripe;
      if(!cap || !cap.enabled){ toast((cap&&cap.explanation)||'Reconcile is available only for a delayed in-flight payment.'); return; }
      try {
        drec.disabled = true;
        const d = await api('/.netlify/functions/admin-ops-jobs','POST',{
          action:'reconcile_with_stripe',
          bookingId:j.id,
          expectedBookingVersion:j.bookingVersion,
          reason:'delayed_webhook_recovery',
        });
        if(d.ok && d.projection && d.projection.paymentStatus==='paid'){
          toast('Reconciled — invoice paid · remaining $0');
        } else if(d.ok && d.skipped){
          toast('Reconcile skipped: '+(d.reason||'no open payment'));
        } else if(d.ok){
          toast('Reconcile complete · status '+(d.projection&&d.projection.paymentStatus||'updated'));
        } else {
          toast(d.reason || d.error || 'Reconcile failed');
        }
        await refreshAll(); if(activeJob&&activeJob.id===j.id) openDrawer(j.id);
      } catch(e){ toast(e.message || 'Reconcile failed'); }
      finally { drec.disabled = !(cap&&cap.enabled); }
    };
    if(drec){
      const cap=drawerControls&&drawerControls.reconcileStripe;
      drec.disabled=!(cap&&cap.enabled);
      drec.title=(cap&&cap.explanation)||'Reconcile is available only for delayed in-flight payments.';
    }
    const dcpl = $('#dCopyPayLink'); if(dcpl) dcpl.onclick = async () => {
      const u = ($('#dPayLink').value||'').trim();
      if(!u){ toast('No link to copy'); return; }
      try { await navigator.clipboard.writeText(u); toast('Link copied'); } catch(e){ prompt('Copy link:', u); }
    };
    const dcns = $('#dChargeNoShow'); if(dcns) dcns.onclick = async () => {
      if(dcns.disabled){ toast('Policy fee blocked — job completed or cancelled.'); return; }
      if(!confirm('Charge $75 no-show fee to card on file?')) return;
      try { const d = await api('/.netlify/functions/admin-ops-jobs','POST',{action:'charge_policy_fee',bookingId:j.id,feeType:'no_show',amount:75}); toast('Charge '+d.status+' · $'+d.amount); await refreshAll(); if(activeJob&&activeJob.id===j.id) openDrawer(j.id); } catch(e){ toast(e.message); }
    };
    const dclc = $('#dChargeLateCancel'); if(dclc) dclc.onclick = async () => {
      if(dclc.disabled){ toast('Policy fee blocked — job completed or cancelled.'); return; }
      if(!confirm('Charge $50 late-cancellation fee to card on file?')) return;
      try { const d = await api('/.netlify/functions/admin-ops-jobs','POST',{action:'charge_policy_fee',bookingId:j.id,feeType:'late_cancel',amount:50}); toast('Charge '+d.status+' · $'+d.amount); await refreshAll(); if(activeJob&&activeJob.id===j.id) openDrawer(j.id); } catch(e){ toast(e.message); }
    };
    const drf = $('#dRefund'); if(drf) {
      const refundCapability = (drawerControls && drawerControls.refund) || {};
      drf.disabled = refundCapability.enabled === false;
      drf.title = refundCapability.explanation || '';
      drf.onclick = async () => {
        const reason = ($('#dRefundNote') && $('#dRefundNote').value || '').trim();
        const amount = Number($('#dRefundAmt') && $('#dRefundAmt').value);
        if (!reason) { toast('A refund reason is required'); return; }
        if (!(amount > 0)) { toast('Enter a positive refund amount'); return; }
        if (!confirm('Issue a $'+amount.toFixed(2)+' Stripe refund? The ledger will update only after Stripe confirms it.')) return;
        const requestKey = refundRequestKeys[j.id]
          || ((window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('req_'+Date.now()+'_'+Math.random().toString(36).slice(2)));
        refundRequestKeys[j.id] = requestKey;
        try {
          await jobAction(j.id,'record_refund_request',{
            reason,
            amount,
            requestKey,
            expectedBookingVersion:j.bookingVersion,
            expectedQuoteVersion:(drawerAddonData&&drawerAddonData.quoteVersion)||j.quoteVersion,
          });
          delete refundRequestKeys[j.id];
        } catch (error) {
          // Keep the same key only for unknown/network outcomes, where Stripe
          // may already have accepted the refund. A deterministic rejection
          // gets a fresh key after the operator corrects the request.
          if (error && error.retryable === false) delete refundRequestKeys[j.id];
        }
      };
    }
    const dmr = $('#dMarkRefunded'); if(dmr) dmr.onclick = async () => {
      if(!confirm('Mark this invoice as refunded? Payment badge will change from payment_succeeded to refunded.')) return;
      try {
        await api('/.netlify/functions/admin-ops-jobs','POST',{
          action:'mark_refunded',
          bookingId:j.id,
          reason:($('#dRefundNote')&&$('#dRefundNote').value.trim())||'admin_marked_refunded',
          amount:$('#dRefundAmt')&&$('#dRefundAmt').value,
        });
        toast('Marked refunded');
        await refreshAll();
        if(activeJob&&activeJob.id===j.id) openDrawer(j.id);
      } catch(e){ toast(e.message); }
    };
    const dsb = $('#dSaveBal'); if(dsb) dsb.onclick = () => jobAction(j.id,'record_job_balance',{finalAmount:$('#dFinalAmt').value,techPayoutAmount:$('#dTechPay').value});
    const doa = $('#dOfferApply'); if(doa) doa.onclick = () => { const r=prompt('Reason (required for override if ineligible):')||''; jobAction(j.id,'apply_welcome_offer',{reason:r,forceEligible:!!r}); };
    const dor = $('#dOfferRemove'); if(dor) dor.onclick = () => { const r=prompt('Reason for removing offer (required):'); if(r) jobAction(j.id,'remove_welcome_offer',{reason:r}); };
    placeActiveDetailRow(j.id);
    markExpandedRow(j.id);
  }

  // Stage 3 — canonical add-on controls. Catalog rows, prices, and selection all
  // come from the server (get_job); the browser only ever sends add-on IDs +
  // expectedBookingVersion (+ vehicleId when multi-vehicle).
  function renderAddonSection(j) {
    const data = drawerAddonData || {};
    const cat = data.catalog;
    let out = '<div class="sec" id="dAddonSec"><h4>Service add-ons (canonical)</h4>';
    if (!cat || !Array.isArray(cat.addons) || !cat.addons.length) {
      return out + '<p class="hint">Canonical add-on catalog unavailable — reopen the job to reload.</p></div>';
    }
    const proj = data.projection || {};
    // Display-only: server projection fields. Never recompute money locally.
    const approvedC = Number(proj.approvedCents != null ? proj.approvedCents : (j.approvedCents || 0));
    const settledC = Number(proj.settledCents != null ? proj.settledCents : (j.settledCents || 0));
    const remainingC = Number(proj.remainingCents != null ? proj.remainingCents : (j.remainingCents || 0));
    const money = c => '$' + (Number(c || 0) / 100).toFixed(2);
    const vehicles = Array.isArray(data.vehicles) ? data.vehicles : [];
    const multiVehicle = vehicles.length > 1;
    const defaultVehicleId = !multiVehicle && vehicles[0] ? vehicles[0].vehicleId : '';
    const activeVehicle = multiVehicle
      ? (vehicles.find(v => v.vehicleId === (data.activeVehicleId || '')) || vehicles[0] || null)
      : (vehicles[0] || null);
    const activeVehicleId = activeVehicle ? activeVehicle.vehicleId : defaultVehicleId;
    const selected = activeVehicle
      ? (activeVehicle.selectedAddonIds || []).slice()
      : (data.selected || []).slice();
    const vehicleCategory = activeVehicle && activeVehicle.category
      ? activeVehicle.category
      : (cat.category || 'cars');
    const catalogRows = (cat.byCategory && cat.byCategory[vehicleCategory])
      || cat.addons
      || [];
    const byId = {};
    catalogRows.forEach(a => { byId[a.id] = a; });
    out += '<div class="kv" id="dAddonMoney" style="margin-bottom:8px">'+
      '<div><b>Total approved:</b> '+money(approvedC)+'</div>'+
      '<div><b>Amount paid:</b> '+money(settledC)+'</div>'+
      '<div><b>Amount due:</b> '+money(remainingC)+'</div></div>';
    if (multiVehicle) {
      out += '<div style="margin-bottom:8px"><label>Target vehicle</label>'+
        '<select id="dAddonVehicle">'+
        vehicles.map(v => '<option value="'+esc(v.vehicleId)+'"'+(v.vehicleId===activeVehicleId?' selected':'')+'>'+
          esc(v.label || v.vehicleId)+'</option>').join('')+
        '</select></div>';
    } else if (activeVehicleId) {
      out += '<input type="hidden" id="dAddonVehicle" value="'+esc(activeVehicleId)+'">';
    }
    out += '<div id="dAddonSelected" style="margin-bottom:8px">';
    if (!selected.length) {
      out += '<div class="hint" style="margin:0">No add-ons on this booking.</div>';
    }
    selected.forEach(id => {
      const a = byId[id] || { id: id, name: id, priceCents: null };
      out += '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:13px;padding:4px 0;border-bottom:1px solid var(--line)">'+
        '<span>'+esc(a.name || id)+(a.priceCents != null ? ' · '+money(a.priceCents) : '')+'</span>'+
        '<button type="button" class="btn ghost sm addon-remove" data-remove-addon="'+esc(id)+'">Remove</button>'+
        '</div>';
    });
    out += '</div>';
    const included = catalogRows.filter(a => (a.includedInPackageIds || []).indexOf(activeVehicle && activeVehicle.currentPackageId) >= 0);
    const available = catalogRows.filter(a => selected.indexOf(a.id) < 0 && included.indexOf(a) < 0);
    if (included.length) {
      out += '<p class="hint">Already included in this package: '+included.map(a => esc(a.name)).join(', ')+'</p>';
    }
    const canMutate = !multiVehicle || !!activeVehicleId;
    out += '<div class="op-grid">'+
      '<div class="full"><label>Add canonical add-on (price from catalog)</label>'+
      '<select id="dAddonSelect"'+(available.length && canMutate ? '' : ' disabled')+'>'+
      (available.length
        ? available.map(a => '<option value="'+esc(a.id)+'">'+esc(a.name)+' · '+money(a.priceCents)+'</option>').join('')
        : '<option value="">All catalog add-ons already selected</option>')+
      '</select></div>'+
      '<div class="full"><button type="button" class="btn sm" id="dAddonAdd"'+(available.length && canMutate ? '' : ' disabled')+'>Add add-on</button></div>'+
      '</div>'+
      '<p class="hint" id="dAddonStatus" style="margin-top:6px;margin-bottom:0"></p></div>';
    return out;
  }

  function bindAddonSection(j) {
    let addonPending = false;
    const setPending = (on, msg) => {
      addonPending = on;
      document.querySelectorAll('#dAddonSec button, #dAddonSec select').forEach(el => { el.disabled = on; });
      const st = $('#dAddonStatus');
      if (st && msg != null) st.textContent = msg;
    };
    const vehicleSelect = $('#dAddonVehicle');
    if (vehicleSelect && vehicleSelect.tagName === 'SELECT') {
      vehicleSelect.onchange = () => {
        if (!drawerAddonData) return;
        drawerAddonData.activeVehicleId = vehicleSelect.value;
        const sec = $('#dAddonSec');
        if (!sec) return;
        sec.outerHTML = renderAddonSection(j);
        bindAddonSection(j);
      };
    }
    async function runAddonMutation(payload) {
      if (addonPending) return; // double-click → one effective mutation
      const data = drawerAddonData || {};
      const expectedBookingVersion = data.bookingVersion != null
        ? data.bookingVersion
        : j.bookingVersion;
      if (expectedBookingVersion == null || expectedBookingVersion === '') {
        const st = $('#dAddonStatus');
        if (st) st.textContent = 'Missing booking version — reopen the job.';
        return;
      }
      const vehEl = $('#dAddonVehicle');
      const vehicleId = vehEl && vehEl.value ? vehEl.value : '';
      const vehicles = Array.isArray(data.vehicles) ? data.vehicles : [];
      if (vehicles.length > 1 && !vehicleId) {
        const st = $('#dAddonStatus');
        if (st) st.textContent = 'Select a target vehicle before changing add-ons.';
        return;
      }
      const reason = (prompt('Reason for this add-on change (required):') || '').trim();
      if (!reason) {
        const st = $('#dAddonStatus');
        if (st) st.textContent = 'A reason is required.';
        return;
      }
      setPending(true, 'Applying add-on change…');
      try {
        const body = Object.assign({
          action: 'addon_mutation',
          bookingId: j.id,
          expectedBookingVersion: expectedBookingVersion,
          reason: reason,
        }, payload);
        if (vehicleId) body.vehicleId = vehicleId;
        const d = await api('/.netlify/functions/admin-ops-jobs','POST', body);
        toast(d.noop
          ? 'No change — '+(d.reason || 'already applied').replace(/_/g,' ')
          : 'Add-ons updated · due '+(d.projection ? '$'+(Number(d.projection.remainingCents||0)/100).toFixed(2) : 'updated'));
        await refreshAll();
        // Rerender from the server FinancialProjection — never from local math.
        if (activeJob && activeJob.id === j.id) await openDrawer(j.id);
      } catch(e) {
        const err = String(e.message || '');
        if (err === 'version_conflict') {
          toast('Booking changed — reloading job…');
          // Reload authoritative state; do not silently replay the mutation.
          if (activeJob && activeJob.id === j.id) await openDrawer(j.id);
          return;
        }
        // Preserve the open drawer on validation/server errors.
        setPending(false, 'Add-on change failed: '+err);
        toast('Add-on change failed: '+err);
      }
    }
    const dAdd = $('#dAddonAdd');
    if (dAdd) dAdd.onclick = () => {
      const sel = $('#dAddonSelect');
      const id = sel && sel.value;
      if (!id) return;
      runAddonMutation({ addOnIdsToAdd: [id] });
    };
    document.querySelectorAll('#dAddonSec .addon-remove').forEach(b => b.onclick = () => {
      if (!confirm('Remove this add-on? The canonical quote will be repriced by the server.')) return;
      runAddonMutation({ addOnIdsToRemove: [b.dataset.removeAddon] });
    });
  }

  // PR3 — canonical package change controls. Package options and prices all
  // come from the server (get_job packageCatalog); the browser only ever sends
  // packageId + expectedBookingVersion (+ vehicleId when multi-vehicle).
  function renderPackageSection(j) {
    const data = drawerAddonData || {};
    const cat = data.packageCatalog;
    let out = '<div class="sec" id="dPkgSec"><h4>Service package (canonical)</h4>';
    if (!cat || !Array.isArray(cat.vehicles) || !cat.vehicles.length) {
      return out + '<p class="hint">Canonical package catalog unavailable — reopen the job to reload.</p></div>';
    }
    const proj = data.projection || {};
    const settledC = Number(proj.settledCents != null ? proj.settledCents : (j.settledCents || 0));
    const money = c => '$' + (Number(c || 0) / 100).toFixed(2);
    const vehicles = cat.vehicles;
    const multiVehicle = vehicles.length > 1;
    const activeVehicle = multiVehicle
      ? (vehicles.find(v => v.vehicleId === (data.activePkgVehicleId || '')) || vehicles[0] || null)
      : (vehicles[0] || null);
    const activeVehicleId = activeVehicle ? activeVehicle.vehicleId : '';
    const options = activeVehicle && Array.isArray(activeVehicle.options) ? activeVehicle.options : [];
    const current = options.find(o => o.current) || null;
    if (multiVehicle) {
      out += '<div style="margin-bottom:8px"><label>Target vehicle</label>'+
        '<select id="dPkgVehicle">'+
        vehicles.map(v => '<option value="'+esc(v.vehicleId)+'"'+(v.vehicleId===activeVehicleId?' selected':'')+'>'+
          esc(v.label || v.vehicleId)+'</option>').join('')+
        '</select></div>';
    } else if (activeVehicleId) {
      out += '<input type="hidden" id="dPkgVehicle" value="'+esc(activeVehicleId)+'">';
    }
    out += '<div class="kv" style="margin-bottom:8px"><div><b>Current package:</b> '+
      (current
        ? esc(current.name)+' · '+money(current.priceCents)
        : esc((activeVehicle && activeVehicle.currentPackageId) || 'Unknown'))+
      '</div></div>';
    const choices = options.filter(o => !o.current);
    const canMutate = choices.length > 0 && !!activeVehicleId;
    out += '<div class="op-grid">'+
      '<div class="full"><label>Change package (price from catalog)</label>'+
      '<select id="dPkgSelect"'+(canMutate ? '' : ' disabled')+'>'+
      (choices.length
        ? choices.map(o => '<option value="'+esc(o.id)+'">'+esc(o.name)+' · '+money(o.priceCents)+'</option>').join('')
        : '<option value="">No alternative packages available</option>')+
      '</select></div>'+
      '<div class="full"><button type="button" class="btn sm" id="dPkgApply"'+(canMutate ? '' : ' disabled')+'>Change package</button></div>'+
      '</div>'+
      '<p class="hint" id="dPkgStatus" style="margin-top:6px;margin-bottom:0"></p></div>';
    return out;
  }

  function bindPackageSection(j) {
    let pkgPending = false;
    const setPending = (on, msg) => {
      pkgPending = on;
      document.querySelectorAll('#dPkgSec button, #dPkgSec select').forEach(el => { el.disabled = on; });
      const st = $('#dPkgStatus');
      if (st && msg != null) st.textContent = msg;
    };
    const vehicleSelect = $('#dPkgVehicle');
    if (vehicleSelect && vehicleSelect.tagName === 'SELECT') {
      vehicleSelect.onchange = () => {
        if (!drawerAddonData) return;
        drawerAddonData.activePkgVehicleId = vehicleSelect.value;
        const sec = $('#dPkgSec');
        if (!sec) return;
        sec.outerHTML = renderPackageSection(j);
        bindPackageSection(j);
      };
    }
    const dApply = $('#dPkgApply');
    if (dApply) dApply.onclick = async () => {
      if (pkgPending) return; // double-click → one effective mutation
      const sel = $('#dPkgSelect');
      const packageId = sel && sel.value;
      if (!packageId) return;
      const data = drawerAddonData || {};
      const expectedBookingVersion = data.bookingVersion != null
        ? data.bookingVersion
        : j.bookingVersion;
      if (expectedBookingVersion == null || expectedBookingVersion === '') {
        const st = $('#dPkgStatus');
        if (st) st.textContent = 'Missing booking version — reopen the job.';
        return;
      }
      const vehEl = $('#dPkgVehicle');
      const vehicleId = vehEl && vehEl.value ? vehEl.value : '';
      const cat = data.packageCatalog || {};
      if (Array.isArray(cat.vehicles) && cat.vehicles.length > 1 && !vehicleId) {
        const st = $('#dPkgStatus');
        if (st) st.textContent = 'Select a target vehicle before changing the package.';
        return;
      }
      const label = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : packageId;
      if (!confirm('Change the service package to "'+label+'"? The canonical quote will be repriced by the server.')) return;
      const reason = (prompt('Reason for this package change (required):') || '').trim();
      if (!reason) {
        const st = $('#dPkgStatus');
        if (st) st.textContent = 'A reason is required.';
        return;
      }
      setPending(true, 'Applying package change…');
      try {
        const body = {
          action: 'change_package',
          bookingId: j.id,
          expectedBookingVersion: expectedBookingVersion,
          packageId: packageId,
          reason: reason,
        };
        if (vehicleId) body.vehicleId = vehicleId;
        const d = await api('/.netlify/functions/admin-ops-jobs','POST', body);
        toast(d.noop
          ? 'No change — '+(d.reason || 'already applied').replace(/_/g,' ')
          : 'Package updated · total $'+Number(d.totalPrice || 0).toFixed(2));
        await refreshAll();
        // Rerender from the server projection — never from local math.
        if (activeJob && activeJob.id === j.id) await openDrawer(j.id);
      } catch(e) {
        const err = String(e.message || '');
        if (err === 'version_conflict') {
          toast('Booking changed — reloading job…');
          // Reload authoritative state; do not silently replay the mutation.
          if (activeJob && activeJob.id === j.id) await openDrawer(j.id);
          return;
        }
        // Preserve the open drawer on validation/server errors.
        setPending(false, 'Package change failed: '+err);
        toast('Package change failed: '+err);
      }
    };
  }

  function closeDrawer() { collapseJobDetail(); }

  // Admin Lite: secondary navigation stays collapsed until opened. Opening the
  // disclosure only reveals the buttons; each secondary tab still loads its own
  // data lazily on click, so More costs nothing until it is actually used.
  const tabsMoreToggle = $('#tabsMoreToggle');
  const tabsMore = $('#tabsMore');
  if (tabsMoreToggle && tabsMore) {
    tabsMoreToggle.addEventListener('click', () => {
      const open = tabsMoreToggle.getAttribute('aria-expanded') === 'true';
      tabsMoreToggle.setAttribute('aria-expanded', open ? 'false' : 'true');
      tabsMore.hidden = open;
    });
  }

  ['#paymentsSearch', '#paymentsStatus'].forEach((sel) => {
    const el = $(sel);
    if (el) el.oninput = el.onchange = () => renderPayments();
  });
  if ($('#paymentsClear')) {
    $('#paymentsClear').onclick = () => {
      if ($('#paymentsSearch')) $('#paymentsSearch').value = '';
      if ($('#paymentsStatus')) $('#paymentsStatus').value = '';
      renderPayments();
    };
  }
  if ($('#paymentsTable')) {
    $('#paymentsTable').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-payment-open]');
      if (!btn) return;
      const id = btn.getAttribute('data-payment-open');
      const jobsTab = [...document.querySelectorAll('#tabs .tab')].find((t) => t.dataset && t.dataset.tab === 'jobs');
      if (jobsTab) jobsTab.click();
      expandedJobId = id;
      openDrawer(id).catch(() => {});
    });
  }

  // Tabs
  $('#tabs').onclick = e => {
    const b = e.target.closest('.tab'); if(!b) return;
    document.querySelectorAll('.tab').forEach(t => {
      t.classList.remove('on');
      t.setAttribute('aria-selected', 'false');
    });
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('on'));
    b.classList.add('on');
    b.setAttribute('aria-selected', 'true');
    $('#p-'+b.dataset.tab).classList.add('on');
    if (b.dataset.tab === 'payments') renderPayments();
    if (b.dataset.tab === 'auctions') refreshAuctionsTab();
    if (b.dataset.tab === 'subscriptions') refreshSubsTab();
    if (b.dataset.tab === 'settings') loadSettings().then(renderSettingsForm).catch(()=>{});
    if (b.dataset.tab === 'requests') refreshRequestsTab();
    if (b.dataset.tab === 'revops') refreshRevopsTab();
    if (b.dataset.tab === 'techs') {
      ensureTechsForManagement()
        .then(() => { renderTechs(); renderOverview(); })
        .catch(() => { renderTechs(); });
    }
    if (b.dataset.tab === 'assign') {
      ensureTechsForAssign()
        .then(() => { renderAssign(); refreshAssignSelectsInDom(); })
        .catch(() => { renderAssign(); });
    }
  };
  document.querySelectorAll('#requestsFilters [data-req-filter]').forEach((btn) => {
    btn.onclick = async () => {
      requestsStatusFilter = btn.dataset.reqFilter || 'pending';
      requestsSyncVersion = '';
      document.querySelectorAll('#requestsFilters [data-req-filter]').forEach((b) => {
        b.setAttribute('aria-pressed', b.dataset.reqFilter === requestsStatusFilter ? 'true' : 'false');
      });
      await refreshRequestsTab();
    };
  });

  // Status filter options
  $('#jobsStatus').innerHTML = '<option value="">All statuses</option>'+JOB_STATUSES.map(s=>'<option value="'+s+'">'+s.replace(/_/g,' ')+'</option>').join('');

  let searchT;
  $('#jobsSearch').oninput = () => { clearTimeout(searchT); searchT=setTimeout(renderJobs,250); };
  $('#jobsStatus').onchange = renderJobs;
  // Clear filters operates only on in-memory jobs — no network reload.
  $('#jobsClear').onclick = () => {
    const cleared = SS && SS.clearedJobFilters ? SS.clearedJobFilters() : { search:'', status:'', queueFilter:'all' };
    $('#jobsSearch').value = cleared.search;
    $('#jobsStatus').value = cleared.status;
    queueFilter = cleared.queueFilter;
    renderJobs();
  };
  $('#jobsShowTest').onchange = async e => { showTest = e.target.checked; await refreshAll(); };
  $('#evSearch').oninput = renderEvents;
  $('#btnPreviewTests').onclick = async () => {
    try {
      const d = await api('/.netlify/functions/admin-ops-jobs','POST',{action:'preview_test_cleanup'});
      const lines = (d.matches||[]).map(m => '• '+m.id+' — '+m.customer+(m.email?' · '+m.email:''));
      $('#testPreview').textContent = d.count ? (d.count+' match(es):\n\n'+lines.join('\n')) : 'No likely-test bookings found in cloud.';
    } catch(e) { toast('Preview failed: '+e.message); }
  };
  $('#btnArchiveTests').onclick = async () => {
    if (!confirm('Archive ALL likely-test bookings in the cloud?\n\nThey will be hidden from the default board (not deleted).')) return;
    try {
      const d = await api('/.netlify/functions/admin-ops-jobs','POST',{action:'bulk_archive_tests'});
      toast('Archived '+d.archived+' test booking(s)');
      $('#testPreview').textContent = 'Archived: '+d.archived+' · Skipped: '+d.skipped;
      await refreshAll();
    } catch(e) { toast('Archive failed: '+e.message); }
  };
  $('#completedRefresh').onclick = async () => { await loadJobs({jobStatus:'completed_pending_admin_review'}); await loadJobs(); renderCompleted(); };
  $('#btnRefresh').onclick = () => opsRefresh
    ? opsRefresh.refresh('manual', { supersede: true })
    : refreshAll('manual');
  $('#btnLogout').onclick = () => { if (confirm('Sign out of Admin Ops?')) adminLogout(); };
  $('#dClose').onclick = closeDrawer;
  $('#tdClose').onclick = closeTechDrawer;
  $('#techDrawerBg').onclick = closeTechDrawer;
  $('#tdSave').onclick = saveTechProfile;
  $('#tdSetPass').onclick = setTechPassword;
  $('#tdCopyInv').onclick = copyInviteForTech;
  $('#tdResetInv').onclick = resetInviteForTech;
  $('#tdToggle').onclick = toggleTechFromDrawer;
  $('#dSaveNote').onclick = async () => {
    if (!activeJob) return;
    const note = $('#dNote').value.trim();
    if (!note) return toast('Enter a note');
    try { await jobAction(activeJob.id,'admin_note',{note}); } catch(e) { toast(e.message); }
  };

  $('#btnSaveSettings').onclick = async () => {
    try {
      const ov = $('#setBidOverride').value.trim();
      await api('/.netlify/functions/ops-settings', 'POST', {
        autoConfirmAppointments: $('#setAutoConfirm').checked,
        autoPostToAuctionOnConfirm: $('#setAutoAuction').checked,
        dispatchMode: $('#setDispatch').value,
        bidMaxPercent: Number($('#setBidPct').value),
        bidMaxOverride: ov ? Number(ov) : null,
        bidWindowMinutes: Number($('#setBidWin').value),
        bidWindowMinutesBoatRv: Number($('#setBidWinRv').value),
        minTechRatingToBid: Number($('#setMinRating').value),
        requireCompoundExperience: $('#setCompound').checked,
      });
      toast('Settings saved');
      await loadSettings();
      renderSettingsForm();
    } catch(e) { toast('Save failed: '+e.message); }
  };

  $('#btnSaveAvailability').onclick = async () => {
    try {
      const data = await api('/.netlify/functions/ops-settings', 'POST', {
        action: 'update_availability',
        businessTimezone: $('#avTimezone').value.trim() || 'America/New_York',
        weekendMode: $('#avWeekendMode').value,
        supervisedEffectiveDate: $('#avEffectiveDate').value || null,
        expectedUpdatedAt: (platformAvailability && platformAvailability.updatedAt) || null,
      });
      platformAvailability = data.availability || platformAvailability;
      toast('Availability mode saved');
      renderAvailabilityForm();
    } catch (e) { toast('Availability save failed: ' + e.message); }
  };

  $('#btnUpsertOverride').onclick = async () => {
    try {
      const date = $('#avOverrideDate').value;
      if (!date) return toast('Choose a date');
      const data = await api('/.netlify/functions/ops-settings', 'POST', {
        action: 'upsert_date_override',
        date,
        expectedUpdatedAt: (platformAvailability && platformAvailability.updatedAt) || null,
        override: {
          enabled: $('#avOverrideEnabled').value === 'true',
          capacity: Number($('#avOverrideCapacity').value) || 1,
          arrivalWindows: resolveOverrideWindows(),
          note: $('#avOverrideNote').value.trim(),
        },
      });
      platformAvailability = data.availability || platformAvailability;
      toast('Date override saved');
      renderAvailabilityForm();
    } catch (e) { toast('Override save failed: ' + e.message); }
  };

  $('#btnRemoveOverride').onclick = async () => {
    try {
      const date = $('#avOverrideDate').value;
      if (!date) return toast('Choose a date to remove');
      const data = await api('/.netlify/functions/ops-settings', 'POST', {
        action: 'remove_date_override',
        date,
      });
      platformAvailability = data.availability || platformAvailability;
      toast('Override removed');
      renderAvailabilityForm();
    } catch (e) { toast('Remove failed: ' + e.message); }
  };

  $('#btnSyncRoster').onclick = async () => {
    try { const d = await api('/.netlify/functions/ops-settings','POST',{action:'sync_tech_roster'}); toast('Synced '+d.count+' tech(s)'); } catch(e){ toast(e.message); }
  };
  $('#btnReloadAuctions').onclick = refreshAuctionsTab;
  $('#btnReloadSubs').onclick = refreshSubsTab;
  $('#btnNewSub').onclick = async () => {
    const email = prompt('Customer email:'); if(!email) return;
    const name = prompt('Customer name:') || '';
    const plan = prompt('Plan (monthly / quarterly / annual):','monthly') || 'monthly';
    const map = { monthly:1, quarterly:3, biannual:6, annual:12 };
    const interval = map[plan.toLowerCase()] || 1;
    const price = Number(prompt('Monthly or per-visit price ($):','79')) || 79;
    try {
      await api('/.netlify/functions/subscriptions-ops','POST',{
        action:'create', email, customerName:name, planName:plan, intervalMonths:interval, price,
        nextVisitDate: new Date().toISOString().slice(0,10),
      });
      toast('Subscription created'); refreshSubsTab();
    } catch(e) { toast(e.message); }
  };

  $('#techForm').onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const caps = (fd.get('capabilities')||'').split(',').map(s=>s.trim()).filter(Boolean);
    try {
      const d = await api('/.netlify/functions/tech-accounts','POST',{
        action:'create', fullName:fd.get('fullName'), email:fd.get('email'),
        phone:fd.get('phone'), serviceArea:fd.get('serviceArea'), capabilities:caps,
        smsConsent:fd.get('smsConsent') === 'yes'
      });
      if (d.inviteToken && d.technician) inviteCache[d.technician.techId] = d.inviteToken;
      const email = fd.get('email');
      if (d.inviteToken && email) {
        try {
          const link = await copyInviteLink(email, d.inviteToken);
          toast('Technician created — invite link copied');
          alert('Invite link (copied to clipboard):\n\n'+link);
        } catch(_) {
          toast('Technician created — copy invite from technician drawer');
        }
      } else {
        toast('Technician created');
      }
      e.target.reset();
      invalidateTechsSessionCache();
      await ensureTechsForManagement(); renderTechs(); renderOverview(); refreshAssignSelectsInDom();
    } catch(err) { toast('Create failed: '+err.message); }
  };

  $('#jobsCreate').onclick = async () => {
    const firstName = prompt('Customer first name:');
    if (!firstName) return;
    const phone = prompt('Phone (10 digits):');
    if (!phone) return;
    const email = prompt('Email (optional):') || '';
    const zipCode = prompt('ZIP code:');
    if (!zipCode) return;
    const packageId = prompt('Package ID (interior, full, exterior, maintenance):', 'interior') || 'interior';
    try {
      const d = await api('/.netlify/functions/admin-ops-jobs','POST',{
        action:'create_appointment',
        firstName, phone, email, zipCode,
        packageId,
        package: packageId === 'full' ? 'Premium Full Detail' : 'Interior Detail',
        vehicleCategory:'cars',
        vehicleTier:'Small Car',
        vehicles:[{cat:'cars',pkgId:packageId,tierKey:'small',tierLabel:'Small Car'}],
      });
      toast('Appointment created: '+d.bookingId);
      await refreshAll();
      if (d.bookingId) openDrawer(d.bookingId);
    } catch(e) { toast('Create failed: '+e.message); }
  };

  function renderAdminSyncState(info) {
    const el = $('#lastUpdated');
    if (!el || !info) return;
    if (info.state === 'updating') el.textContent = 'Updating…';
    else if (info.state === 'current') {
      el.textContent = info.lastUpdated ? 'Last updated '+info.lastUpdated.toLocaleTimeString() : 'Up to date';
    } else if (info.state === 'retrying') {
      el.textContent = info.status === 429 ? 'Rate limited · retrying…' : 'Refresh delayed · retrying…';
    } else if (info.state === 'offline') el.textContent = 'Offline · showing last update';
    else if (info.state === 'unauthorized') el.textContent = 'Session expired';
    else if (info.state === 'paused') el.textContent = 'Updates paused';
  }

  if (window.CD1OperationalRefresh) {
    opsRefresh = window.CD1OperationalRefresh.createRefreshController({
      controllerKey: 'admin-ops',
      activePollMs: 2500,
      stablePollMs: 15000,
      maxBackoffMs: 60000,
      onRefresh: refreshAll,
      onStateChange: renderAdminSyncState,
      isPending: adminSyncPending,
      shouldPoll: () => document.visibilityState !== 'hidden',
    });
    opsRefresh.bindLifecycle();
  }

  ensureAdminSession().then(ok => {
    if (!ok) return;
    if (opsRefresh) opsRefresh.refresh('initial').catch(e => toast('Load error: '+e.message));
    else refreshAll('initial').catch(e => toast('Load error: '+e.message));
  });

  let revopsInflight = null;

  function setRevopsLoading(on) {
    const el = $('#revopsLoading');
    const content = $('#revopsContent');
    if (el) el.hidden = !on;
    if (content) content.hidden = !!on;
  }

  function setRevopsError(msg) {
    const err = $('#revopsError');
    const msgEl = $('#revopsErrorMsg');
    const retry = $('#revopsRetry');
    if (msg) {
      if (err) err.hidden = false;
      if (msgEl) msgEl.textContent = msg;
      if (retry) retry.hidden = false;
    } else {
      if (err) err.hidden = true;
      if (retry) retry.hidden = true;
    }
  }

  function renderRevopsDashboard(data) {
    const s = data.summary || {};
    const ec = s.eventCounts || data.eventCounts || {};
    $('#revopsStats').innerHTML = [
      ['Sessions', s.sessions || ec.page_view || 0],
      ['Booking starts', s.bookingStarts || ec.booking_started || 0],
      ['Garage Plan requests', s.garagePlanRequests || 0],
      ['Pipeline value', '$' + (s.estimatedPipelineValue || data.estimatedPipelineValue || 0)],
      ['Contact captures', s.contactCaptures || 0],
      ['Payment step reaches', s.paymentStepReaches || 0],
      ['Submissions', s.bookingSubmissions || 0],
      ['Avg ticket', '$' + (s.averageEstimatedTicket || 0)],
    ].map(function (row) {
      return '<div class="card"><h3>' + row[0] + '</h3><div class="stat">' + row[1] + '</div></div>';
    }).join('');

    const pri = data.priorityQueue || [];
    $('#revopsPriority').innerHTML = pri.length ? (
      '<table class="tbl"><thead><tr><th>Reason</th><th>Segment</th><th>Vehicles</th><th>Intent</th><th>Priority</th><th>Next action</th></tr></thead><tbody>' +
      pri.map(function (o) {
        return '<tr><td>' + esc(o.attentionReason || '—') + '</td><td>' + esc(o.segment) + '</td><td>' + esc(o.vehicleCountBand) + '</td><td>' + esc(o.intentScore) + '</td><td>' + esc(o.commercialPriority) + '</td><td>' + esc(o.nextAction || '—') + '</td></tr>';
      }).join('') + '</tbody></table>'
    ) : '<div class="empty">No items need attention right now.</div>';

    const garage = data.garagePlanOpportunities || [];
    $('#revopsGarage').innerHTML = garage.length ? (
      '<table class="tbl"><thead><tr><th>Ref</th><th>Customer</th><th>Contact</th><th>ZIP</th><th>Vehicles</th><th>Categories</th><th>Same visit</th><th>Maint.</th><th>Status</th><th>Notify</th><th>Source</th><th>Created</th><th>Next</th></tr></thead><tbody>' +
      garage.map(function (o) {
        var phone = o.customerPhone ? ('<a href="tel:' + esc(String(o.customerPhone).replace(/\D/g,'')) + '">' + esc(o.customerPhone) + '</a>') : '—';
        var email = o.customerEmail ? (' <a href="mailto:' + esc(o.customerEmail) + '">email</a>') : '';
        return '<tr>' +
          '<td><code>' + esc(o.gpReference || (o.opportunityId || '').slice(-10)) + '</code></td>' +
          '<td>' + esc(o.customerName || '—') + '</td>' +
          '<td>' + phone + email + '</td>' +
          '<td>' + esc(o.zip || '—') + '</td>' +
          '<td>' + esc(o.vehicleCount || o.vehicleCountBand || '—') + '</td>' +
          '<td>' + esc((o.assetCategories || []).join(', ') || '—') + '</td>' +
          '<td>' + (o.sameLocationSameVisit ? 'Yes' : '—') + '</td>' +
          '<td>' + esc(o.maintenanceFrequency || '—') + '</td>' +
          '<td>' + esc(o.garagePlanStatus || 'new') + '</td>' +
          '<td>' + esc(o.notificationStatus || '—') + '</td>' +
          '<td>' + esc(o.source || '—') + '</td>' +
          '<td>' + esc((o.createdAt || '').slice(0, 10) || '—') + '</td>' +
          '<td>' + esc(o.nextAction || '—') + '</td>' +
          '</tr>';
      }).join('') + '</tbody></table>'
    ) : '<div class="empty">No Garage Plan opportunities in queue.</div>';

    const pf = $('#revopsPriorityFilter').value;
    let items = data.opportunities || [];
    if (pf) items = items.filter(function (o) { return o.commercialPriority === pf; });
    $('#revopsOpps').innerHTML = items.length ? (
      '<table class="tbl"><thead><tr><th>Stage</th><th>Segment</th><th>Value</th><th>Temperature</th><th>Source</th></tr></thead><tbody>' +
      items.map(function (o) {
        return '<tr><td>' + esc(o.stage) + '</td><td>' + esc(o.segment) + '</td><td>$' + esc(o.estimatedValue || 0) + '</td><td>' + esc(o.leadTemperature || '—') + '</td><td>' + esc(o.source || '—') + '</td></tr>';
      }).join('') + '</tbody></table>'
    ) : '<div class="empty">No opportunities recorded yet.</div>';

    if (data.warnings && data.warnings.length) {
      toast('RevOps loaded with warnings: ' + data.warnings.slice(0, 2).join(', '));
    }
  }

  async function refreshRevopsTab() {
    if (revopsInflight) return revopsInflight;
    setRevopsError('');
    setRevopsLoading(true);
    revopsInflight = (async function () {
      try {
        const pf = $('#revopsPriorityFilter').value;
        const q = '/.netlify/functions/revenue-admin?view=dashboard&limit=50' + (pf ? '&priority=' + encodeURIComponent(pf) : '');
        const data = await api(q);
        renderRevopsDashboard(data);
        const lu = $('#revopsLastUpdated');
        if (lu) lu.textContent = 'Last updated ' + new Date().toLocaleTimeString();
      } catch (e) {
        setRevopsError('RevOps load failed: ' + (e.message || 'unknown error'));
        $('#revopsPriority').innerHTML = '<div class="empty">Could not load priority queue.</div>';
        $('#revopsGarage').innerHTML = '<div class="empty">Could not load Garage Plan opportunities.</div>';
        $('#revopsOpps').innerHTML = '<div class="empty">Could not load opportunities.</div>';
      } finally {
        setRevopsLoading(false);
        revopsInflight = null;
      }
    })();
    return revopsInflight;
  }
  $('#revopsRefresh').onclick = refreshRevopsTab;
  $('#revopsRetry').onclick = refreshRevopsTab;
  $('#revopsPriorityFilter').onchange = refreshRevopsTab;

  function revopsTabActive() {
    const tab = document.querySelector('#tabs .tab.on');
    return !!(tab && tab.dataset.tab === 'revops' && document.visibilityState !== 'hidden');
  }

  document.addEventListener('visibilitychange', () => {
    if (revopsTabActive()) refreshRevopsTab();
  });
  window.addEventListener('focus', () => {
    if (revopsTabActive()) refreshRevopsTab();
  });
})();
