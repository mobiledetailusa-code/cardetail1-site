'use strict';

/**
 * The appointment "job sheet" both QuickOps pages render: admin (/ops/q) and
 * technician (/ops/t). One projection, so the office and the technician see the
 * same vehicles, packages, add-ons, schedule and instructions.
 *
 * This projection NEVER carries money: no package price, add-on price, line
 * total, subtotal, customer total, deposit or payment state. The admin page
 * shows money from its own `money` block; the technician only sees their pay.
 */

const lineItems = require('../../assets/booking-line-items.js');

const NOTE_MAX = 1000;
const ACCESS_NOTE_MAX = 500;

function clean(value, max) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function priceFreeAddons(list) {
  return lineItems.normalizeAddons(list).map((addon) => ({
    name: clean(addon.name, 80),
    qty: addon.qty > 1 ? addon.qty : 1,
  })).filter((addon) => addon.name);
}

function yesNoLabel(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (!raw) return '';
  if (['yes', 'true', 'y', '1', 'available'].includes(raw)) return 'Yes';
  if (['no', 'false', 'n', '0', 'unavailable', 'not_available'].includes(raw)) return 'No';
  return clean(value, 40).replace(/_/g, ' ');
}

function scheduleDays(booking) {
  const schedule = booking && booking.appointmentSchedule;
  const days = schedule && Array.isArray(schedule.days) ? schedule.days : [];
  return days
    .map((day) => clean(day && (day.date || day.dateIso), 10))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date));
}

function ceramicPrep(booking) {
  if (!booking || booking.serviceFamily !== 'ceramic_coating' || !booking.ceramic) return null;
  const c = booking.ceramic;
  const curing = Array.isArray(c.curingInstructions) ? c.curingInstructions : [];
  return {
    packageName: clean(c.packageName, 80),
    sizeLabel: clean(c.packages && c.packages[0] && c.packages[0].sizeLabel, 40),
    durationMonths: Number(c.durationMonths) > 0 ? Number(c.durationMonths) : null,
    companionInterior: !!(c.companionInterior || booking.companionInterior),
    sequencingNote: clean(c.sequencingNote || booking.opsSequencingNote, 300),
    curingInstructions: curing.map((line) => clean(line, 200)).filter(Boolean).slice(0, 10),
  };
}

function projectJobSheet(booking) {
  const b = booking || {};
  const projected = lineItems.projectBooking(b);
  const vehicles = projected.items.map((item) => ({
    label: clean(item.label, 80) || 'Vehicle',
    category: clean(item.category, 40),
    tier: clean(item.tierLabel, 40),
    packageName: clean(item.packageName, 80),
    addons: priceFreeAddons(item.addons),
  }));
  // Booking-level add-ons only exist on legacy rows that also carry vehicles[]
  // without per-vehicle add-ons; show them once so nothing the customer chose
  // is dropped.
  const vehicleAddonCount = vehicles.reduce((n, v) => n + v.addons.length, 0);
  const appointmentAddons = Array.isArray(b.vehicles) && b.vehicles.length && !vehicleAddonCount
    ? priceFreeAddons(b.addons)
    : [];
  const duration = Number(b.appointmentDurationMinutes);
  return {
    vehicles,
    vehicleCount: vehicles.length,
    appointmentAddons,
    durationMinutes: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
    scheduleDays: scheduleDays(b),
    customerNote: clean(b.notes || b.customerNote || b.specialInstructions, NOTE_MAX),
    accessNotes: clean(b.accessNotes, ACCESS_NOTE_MAX),
    serviceLocation: clean(b.serviceLocation, 80).replace(/_/g, ' '),
    water: yesNoLabel(b.waterAvailable),
    electricity: yesNoLabel(b.electricityAvailable),
    ceramicPrep: ceramicPrep(b),
  };
}

module.exports = {
  projectJobSheet,
  NOTE_MAX,
};
