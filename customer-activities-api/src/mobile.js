// Mobile cleaning per spec section 4: strip everything non-numeric, drop a
// leading country code / trunk 0, keep the last 10 digits, and only accept
// it if the result looks like a real Indian mobile number (starts 6-9).
function cleanMobile(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;

  if (digits.length > 10) digits = digits.slice(-10);
  if (digits.length !== 10) return null;
  if (!/^[6-9]\d{9}$/.test(digits)) return null;
  return digits;
}

module.exports = { cleanMobile };
