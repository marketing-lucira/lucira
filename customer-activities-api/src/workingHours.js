// Working hours rule per spec section 11 (exact, do not change):
//   Working:     10:00:00 AM – 8:59:59 PM   (hour 10-20 inclusive)
//   Non-working: 9:00:00 PM  – 9:59:59 AM   (hour 21-23 and 0-9)
// Zoho India-DC timestamps already come back as IST wall-clock ISO strings
// (e.g. 2026-08-22T10:35:22+05:30) — the hour is read directly off the
// string, no timezone conversion needed (matches the house convention
// documented for the other Lucira dashboards).
function hourOf(isoLike) {
  if (!isoLike) return null;
  const s = String(isoLike);
  const h = parseInt(s.slice(11, 13), 10);
  return Number.isNaN(h) ? null : h;
}

function isWorkingHour(isoLike) {
  const h = hourOf(isoLike);
  if (h == null) return null;
  return h >= 10 && h < 21;
}

module.exports = { hourOf, isWorkingHour };
