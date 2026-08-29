/**
 * Live API layer for prototype on Netlify Preview (same-origin functions).
 */
(function (global) {
  const CFG = () => global.CD1PreviewConfig;

  function parseTimeWindow(t) {
    const s = String(t || '').trim();
    if (!s) return { start: 'TBD', end: '' };
    const parts = s.split(/\s*[–-]\s*/);
    if (parts.length >= 2) return { start: parts[0].trim(), end: parts[1].trim() };
    return { start: s, end: '' };
  }

  function normalizeAdminJob(j) {
    if (!j) return null;
    const tw = parseTimeWindow(j.confirmedTimeWindow || j.preferredTime);
    const date = j.confirmedDate || j.preferredDate || '';
    const svc = Number(j.approvedFinalAmount != null ? j.approvedFinalAmount : (j.approvedCents ? j.approvedCents / 100 : 0));
    const due = Number(j.amountDueApproved != null ? j.amountDueApproved : (j.remainingCents ? j.remainingCents / 100 : 0));
    const paid = Number(j.amountPaid != null ? j.amountPaid : (j.settledCents ? j.settledCents / 100 : 0));
    return {
      id: j.id || j.bookingId,
      bookingId: j.bookingId || j.id,
      bookingVersion: j.bookingVersion,
      customerFirst: j.firstName || '',
      customerLast: j.lastName || '',
      phone: j.phone || '',
      email: j.email || '',
      date,
      timeStart: tw.start,
      timeEnd: tw.end || tw.start,
      eta: j.confirmedTime || j.preferredTime || tw.start,
      status: j.jobStatus || 'pending_review',
      paymentStatus: j.paymentWorkflowStatus || '',
      packageId: j.packageId || '',
      packageName: j.package || '',
      serviceTotal: svc,
      travelFee: Math.max(0, Number(j.travelFeeAmount || j.zoneSurcharge || 0)),
      amountPaid: paid,
      amountDue: due,
      vehicle: j.vehicleLabel || j.vehicle || '',
      address: j.address || j.requestedAddress || [j.city, j.state, j.zipCode].filter(Boolean).join(', '),
      city: j.city || '',
      state: j.state || '',
      zip: j.zipCode || j.zip || '',
      assignedTechId: j.assignedTechId || j.assignedTech || null,
      assignedTechName: j.assignedTechName || '',
      customerAccountId: j.customerAccountId || '',
      _raw: j,
      _source: 'live',
    };
  }

  function normalizeTechJob(j) {
    const tw = parseTimeWindow(j.confirmedTimeWindow || j.preferredTime);
    const date = j.confirmedDate || j.preferredDate || '';
    const svc = Number(j.approvedAmount != null ? j.approvedAmount : j.finalAmount || 0);
    const names = String(j.customerName || '').split(' ');
    return {
      id: j.id,
      customerFirst: names[0] || 'Customer',
      customerLast: names.slice(1).join(' ') || '',
      date,
      timeStart: tw.start,
      timeEnd: tw.end || tw.start,
      eta: j.confirmedTime || j.preferredTime || tw.start,
      status: j.jobStatus || 'assigned',
      packageName: j.package || '',
      serviceTotal: svc,
      travelFee: 0,
      vehicle: j.vehicle || (j.vehicles && j.vehicles[0] && j.vehicles[0].vehicleLabel) || '',
      address: j.address || '',
      assignedTechId: j.assignedTechId,
      _raw: j,
      _source: 'live',
    };
  }

  function normalizeCustomerBooking(b) {
    if (!b) return null;
    const tw = parseTimeWindow(b.confirmedTimeWindow || b.preferredArrivalWindow || b.preferredTime);
    const date = b.confirmedDate || b.preferredDate || '';
    const total = Number(b.approvedFinalAmount != null ? b.approvedFinalAmount : b.totalPrice || 0);
  const due = Number(b.amountDueApproved || 0);
    const veh = b.vehicleLabel || b.vehicle
      || (b.vehicles && b.vehicles[0] && (b.vehicles[0].vehicleLabel || b.vehicles[0].vehicle)) || '';
    return {
      id: b.id || b.bookingId,
      customerFirst: b.firstName || 'You',
      customerLast: b.lastName || '',
      date,
      timeStart: tw.start,
      timeEnd: tw.end || tw.start,
      eta: b.confirmedTime || b.preferredTime || tw.start,
      status: b.jobStatus || 'confirmed',
      packageName: b.package || b.service || '',
      serviceTotal: total,
      amountDue: due,
      vehicle: veh,
      address: b.address || '',
      customerAccountId: b.customerAccountId || 'live-customer',
      _raw: b,
      _source: 'live',
    };
  }

  async function adminToken() {
    if (global.CD1AdminSession && global.CD1AdminSession.getToken) {
      return global.CD1AdminSession.getToken() || '';
    }
    return '';
  }

  async function adminSessionOk() {
    const t = await adminToken();
    const headers = { 'Content-Type': 'application/json' };
    if (t) headers['x-admin-key'] = t;
    const payload = { action: 'validate' };
    if (t) payload.token = t;
    try {
      const res = await fetch('/.netlify/functions/admin-auth', {
        method: 'POST',
        credentials: 'same-origin',
        headers,
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      return !!(data && data.ok);
    } catch {
      return false;
    }
  }

  async function adminFetchJobs() {
    const t = await adminToken();
    const headers = {};
    if (t) headers['x-admin-key'] = t;
    const res = await fetch('/.netlify/functions/admin-ops-jobs', {
      credentials: 'same-origin',
      headers,
    });
    const data = await res.json();
    if (!res.ok || !data || !Array.isArray(data.jobs)) {
      throw new Error((data && data.error) || 'failed_to_load_jobs');
    }
    return data.jobs
      .filter((j) => j && !j.archived && j.jobStatus !== 'archived_test' && j.jobStatus !== 'cancelled')
      .map(normalizeAdminJob)
      .filter(Boolean);
  }

  async function adminGetJob(id) {
    const t = await adminToken();
    const headers = { 'Content-Type': 'application/json' };
    if (t) headers['x-admin-key'] = t;
    const res = await fetch('/.netlify/functions/admin-ops-jobs', {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: JSON.stringify({ action: 'get_job', bookingId: id }),
    });
    const data = await res.json();
    if (!res.ok || !data || !data.job) throw new Error((data && data.error) || 'get_job_failed');
    return normalizeAdminJob(data.job);
  }

  async function adminPost(body) {
    const t = await adminToken();
    const headers = { 'Content-Type': 'application/json' };
    if (t) headers['x-admin-key'] = t;
    const res = await fetch('/.netlify/functions/admin-ops-jobs', {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok || !data || data.ok === false) {
      throw new Error((data && data.error) || 'mutation_failed');
    }
    return data;
  }

  async function adminAssign(bookingId, techId) {
    const t = await adminToken();
    const headers = { 'Content-Type': 'application/json' };
    if (t) headers['x-admin-key'] = t;
    const res = await fetch('/.netlify/functions/tech-assignment', {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: JSON.stringify({ action: 'assign', bookingId, techId }),
    });
    const data = await res.json();
    if (!res.ok || !data || !data.ok) throw new Error((data && data.error) || 'assign_failed');
    return data;
  }

  async function adminFetchTechs() {
    const t = await adminToken();
    const headers = { 'Content-Type': 'application/json' };
    if (t) headers['x-admin-key'] = t;
    const res = await fetch('/.netlify/functions/tech-accounts', {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: JSON.stringify({ action: 'list', mode: 'assign_options' }),
    });
    const data = await res.json();
    if (!res.ok || !data || !Array.isArray(data.techs)) return [];
    return data.techs.map((tech) => ({
      id: tech.techId || tech.id,
      name: tech.fullName || tech.name,
      initials: (tech.fullName || tech.name || '?').split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase(),
    }));
  }

  function techToken() {
    try { return sessionStorage.getItem('cd1_tech_token') || ''; } catch { return ''; }
  }

  async function techFetchJobs() {
    const token = techToken();
    if (!token) throw new Error('not_authenticated');
    const res = await fetch('/.netlify/functions/tech-jobs', {
      headers: { 'x-tech-token': token },
    });
    const data = await res.json();
    if (!res.ok || !data || !Array.isArray(data.jobs)) throw new Error((data && data.error) || 'failed');
    return data.jobs.map(normalizeTechJob);
  }

  async function techUpdateStatus(bookingId, status) {
    const token = techToken();
    const res = await fetch('/.netlify/functions/tech-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tech-token': token },
      body: JSON.stringify({ bookingId, status }),
    });
    const data = await res.json();
    if (!res.ok || !data || !data.ok) throw new Error((data && data.error) || 'status_failed');
    return data;
  }

  async function customerSessionOk() {
    try {
      const res = await fetch('/.netlify/functions/customer-portal-auth', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'session' }),
      });
      const data = await res.json();
      return !!(data && data.ok && data.authenticated);
    } catch {
      return false;
    }
  }

  async function customerFetchBookings() {
    const res = await fetch('/.netlify/functions/customer-portal-data', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'account' }),
    });
    const data = await res.json();
    if (!res.ok || !data || !data.ok) throw new Error((data && data.error) || 'portal_data_failed');
    const list = Array.isArray(data.bookings) ? data.bookings : (data.booking ? [data.booking] : []);
    return list.map(normalizeCustomerBooking).filter(Boolean);
  }

  async function initPortal(portal) {
    const cfg = CFG();
    const liveAllowed = cfg.canUseLive();
    const logins = cfg.loginUrls();
    const result = { mode: 'mock', portal, jobs: [], techs: [], authOk: false, loginUrl: logins[portal] || '/' };

    if (!liveAllowed) return result;

    try {
      if (portal === 'admin') {
        result.authOk = await adminSessionOk();
        if (!result.authOk) return result;
        result.jobs = await adminFetchJobs();
        result.techs = await adminFetchTechs();
        result.mode = 'live';
        return result;
      }
      if (portal === 'technician') {
        result.authOk = !!techToken();
        if (!result.authOk) return result;
        result.jobs = await techFetchJobs();
        result.mode = 'live';
        return result;
      }
      if (portal === 'customer') {
        result.authOk = await customerSessionOk();
        if (!result.authOk) return result;
        result.jobs = await customerFetchBookings();
        result.mode = 'live';
        return result;
      }
    } catch (e) {
      result.error = e.message || 'load_failed';
      result.mode = 'mock';
    }
    return result;
  }

  function renderModeBanner(el, runtime) {
    if (!el) return;
    const cfg = CFG();
    const login = runtime.loginUrl || '/';
    if (runtime.mode === 'live') {
      el.innerHTML = '🟢 <strong>LIVE PREVIEW</strong> — dados reais · ' + runtime.jobs.length + ' registro(s)';
      el.style.background = 'rgba(34,197,94,.12)';
      el.style.borderColor = 'rgba(34,197,94,.35)';
      el.style.color = '#86efac';
      return;
    }
    if (cfg.canUseLive() && !runtime.authOk) {
      el.innerHTML = '🟡 <strong>MOCK</strong> — <a href="' + login + '" style="color:#fcd34d">Faça login</a> e recarregue para dados reais';
      return;
    }
    if (cfg.isMockForced()) {
      el.innerHTML = '🟡 <strong>MOCK FORÇADO</strong> — <code>?mode=live</code> para API';
      return;
    }
    el.innerHTML = '🟡 <strong>MOCK</strong> — protótipo · sem produção · <a href="index.html" style="color:#fcd34d">Hub</a>';
  }

  global.CD1PreviewApi = {
    initPortal,
    renderModeBanner,
    normalizeAdminJob,
    adminGetJob,
    adminPost,
    adminAssign,
    adminFetchJobs,
    techFetchJobs,
    techUpdateStatus,
    customerFetchBookings,
    adminSessionOk,
    customerSessionOk,
    techToken,
  };
})(window);
