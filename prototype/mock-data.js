/**
 * Cardetail1 Portal UI Prototype — mock data only (no API / no production).
 */
(function (global) {
  const TODAY = new Date('2026-08-28T12:00:00');

  function addDays(d, n) {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  }

  function fmtDate(d) {
    return d.toISOString().slice(0, 10);
  }

  function fmtDisplay(d) {
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'numeric', day: 'numeric', year: '2-digit' });
  }

  const TECHS = [
    { id: 'tech-magno', name: 'Magno Oliveira', initials: 'MO' },
    { id: 'tech-alex', name: 'Alex Rivera', initials: 'AR' },
    { id: 'tech-sam', name: 'Sam Chen', initials: 'SC' },
  ];

  const PACKAGES = [
    { id: 'premium', name: 'Premium Detail', price: 239 },
    { id: 'full', name: 'Full Detail', price: 189 },
    { id: 'maintenance', name: 'Maintenance Wash', price: 99 },
  ];

  const JOBS = [
    {
      id: 'M2VW3',
      customerFirst: 'Brody',
      customerLast: 'F.',
      phone: '(914) 555-0182',
      email: 'brody.f@example.com',
      date: fmtDate(TODAY),
      timeStart: '10:00 AM',
      timeEnd: '1:00 PM',
      eta: '12:00 PM',
      status: 'confirmed',
      paymentStatus: 'payment_succeeded',
      packageId: 'premium',
      packageName: 'Premium Detail',
      serviceTotal: 239,
      travelFee: 72,
      amountPaid: 167,
      amountDue: 72,
      vehicle: 'Jeep Grand Cherokee 2018 Summit',
      address: 'Harrison, NY 10528',
      city: 'Harrison',
      state: 'NY',
      zip: '10528',
      lat: 40.969,
      lng: -73.712,
      assignedTechId: 'tech-magno',
      customerAccountId: 'cust-brody',
    },
    {
      id: 'K8PL1',
      customerFirst: 'Maria',
      customerLast: 'Santos',
      phone: '(203) 555-0441',
      email: 'maria.s@example.com',
      date: fmtDate(TODAY),
      timeStart: '2:00 PM',
      timeEnd: '4:30 PM',
      eta: '2:15 PM',
      status: 'pending_review',
      paymentStatus: 'pending_admin_review',
      packageId: 'full',
      packageName: 'Full Detail',
      serviceTotal: 189,
      travelFee: 45,
      amountPaid: 0,
      amountDue: 234,
      vehicle: 'BMW X5 2021',
      address: 'White Plains, NY 10601',
      city: 'White Plains',
      state: 'NY',
      zip: '10601',
      lat: 41.034,
      lng: -73.763,
      assignedTechId: null,
      customerAccountId: 'cust-maria',
    },
    {
      id: 'R4TN9',
      customerFirst: 'James',
      customerLast: 'Wu',
      phone: '(201) 555-0922',
      email: 'james.w@example.com',
      date: fmtDate(addDays(TODAY, 1)),
      timeStart: '9:00 AM',
      timeEnd: '11:30 AM',
      eta: '9:30 AM',
      status: 'assigned',
      paymentStatus: 'payment_succeeded',
      packageId: 'maintenance',
      packageName: 'Maintenance Wash',
      serviceTotal: 99,
      travelFee: 35,
      amountPaid: 134,
      amountDue: 0,
      vehicle: 'Tesla Model Y 2023',
      address: 'Fort Lee, NJ 07024',
      city: 'Fort Lee',
      state: 'NJ',
      zip: '07024',
      lat: 40.85,
      lng: -73.97,
      assignedTechId: 'tech-alex',
      customerAccountId: 'cust-james',
    },
    {
      id: 'H7QC2',
      customerFirst: 'Elena',
      customerLast: 'Petrov',
      phone: '(475) 555-3310',
      email: 'elena.p@example.com',
      date: fmtDate(addDays(TODAY, 3)),
      timeStart: '11:00 AM',
      timeEnd: '2:00 PM',
      eta: '11:30 AM',
      status: 'confirmed',
      paymentStatus: 'awaiting_customer_payment',
      packageId: 'premium',
      packageName: 'Premium Detail',
      serviceTotal: 239,
      travelFee: 55,
      amountPaid: 100,
      amountDue: 194,
      vehicle: 'Mercedes GLE 2020',
      address: 'Greenwich, CT 06830',
      city: 'Greenwich',
      state: 'CT',
      zip: '06830',
      lat: 41.026,
      lng: -73.628,
      assignedTechId: 'tech-sam',
      customerAccountId: 'cust-elena',
    },
    {
      id: 'P1XD5',
      customerFirst: 'Brody',
      customerLast: 'F.',
      phone: '(914) 555-0182',
      email: 'brody.f@example.com',
      date: fmtDate(addDays(TODAY, -14)),
      timeStart: '10:00 AM',
      timeEnd: '1:00 PM',
      eta: '10:30 AM',
      status: 'completed_paid',
      paymentStatus: 'payment_succeeded',
      packageId: 'full',
      packageName: 'Full Detail',
      serviceTotal: 189,
      travelFee: 0,
      amountPaid: 189,
      amountDue: 0,
      vehicle: 'Jeep Grand Cherokee 2018 Summit',
      address: 'Harrison, NY 10528',
      city: 'Harrison',
      state: 'NY',
      zip: '10528',
      lat: 40.969,
      lng: -73.712,
      assignedTechId: 'tech-magno',
      customerAccountId: 'cust-brody',
    },
  ];

  const STATUS_LABELS = {
    pending_review: 'Pending Review',
    confirmed: 'Confirmed',
    assigned: 'Assigned',
    accepted: 'Accepted',
    en_route: 'En Route',
    arrived: 'Arrived',
    in_progress: 'In Progress',
    issue_reported: 'Issue',
    completed_pending_admin_review: 'Pending Review',
    completed_pending_payment: 'Pending Payment',
    completed_paid: 'Completed',
    cancelled: 'Cancelled',
  };

  const CUSTOMER_TIMELINE = [
    { key: 'booked', label: 'Booked' },
    { key: 'confirmed', label: 'Confirmed' },
    { key: 'en_route', label: 'Tech En Route' },
    { key: 'in_progress', label: 'In Progress' },
    { key: 'completed_paid', label: 'Complete' },
  ];

  function jobsForDate(dateStr) {
    return JOBS.filter((j) => j.date === dateStr && j.status !== 'cancelled');
  }

  function jobCountByDate(dateStr) {
    return jobsForDate(dateStr).length;
  }

  function weekDays(anchor) {
    const start = new Date(anchor);
    const day = start.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    start.setDate(start.getDate() + diff);
    return Array.from({ length: 7 }, (_, i) => {
      const d = addDays(start, i);
      return {
        date: fmtDate(d),
        dayName: d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase(),
        dayNum: d.getDate(),
        month: d.toLocaleDateString('en-US', { month: 'short' }),
        isToday: fmtDate(d) === fmtDate(TODAY),
        jobCount: jobCountByDate(fmtDate(d)),
      };
    });
  }

  function jobsForTech(techId) {
    return JOBS.filter((j) => j.assignedTechId === techId && !['cancelled', 'completed_paid'].includes(j.status));
  }

  function jobsForCustomer(accountId) {
    return JOBS.filter((j) => j.customerAccountId === accountId);
  }

  function techName(id) {
    const t = TECHS.find((x) => x.id === id);
    return t ? t.name : 'Unassigned';
  }

  function money(n) {
    return '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
  }

  /** Customer portal: only contracted service total — no fee breakdown. */
  function customerServiceTotal(job) {
    return job.serviceTotal;
  }

  global.CD1Proto = {
    TODAY,
    TECHS,
    PACKAGES,
    JOBS,
    STATUS_LABELS,
    CUSTOMER_TIMELINE,
    fmtDate,
    fmtDisplay,
    addDays,
    jobsForDate,
    jobCountByDate,
    weekDays,
    jobsForTech,
    jobsForCustomer,
    techName,
    money,
    customerServiceTotal,
  };
})(window);
