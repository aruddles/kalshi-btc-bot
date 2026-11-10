'use strict';
// Authoritative standard normal CDF: Phi(x) = 0.5 * (1 + erf(x / sqrt(2))),
// erf via Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7).
// v3.1 fix: earlier copies applied the 7.1.26 erf coefficients to x (not x/sqrt2)
// with the normal pdf factor, giving Phi(0) = 0.80 and a jump to 0.20 just below 0.
function normalCdf(x) {
  if (Number.isNaN(x)) return NaN;
  if (x < -8) return 0;
  if (x > 8) return 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + (x < 0 ? -erf : erf));
}
module.exports = { normalCdf };
