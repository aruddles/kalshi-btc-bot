'use strict';
function validBtcUsd(v) { return Number.isFinite(Number(v)) && Number(v) >= 1000 && Number(v) <= 1000000; }
function buildBtcChartValues({ btcPriceUsd, targetPriceUsd, yesPrice, noPrice } = {}) {
  const btc = validBtcUsd(btcPriceUsd) ? Number(btcPriceUsd) : null;
  const target = validBtcUsd(targetPriceUsd) ? Number(targetPriceUsd) : null;
  return { btcPriceUsd: btc, targetPriceUsd: target, warming: btc === null };
}
module.exports = { validBtcUsd, buildBtcChartValues };
