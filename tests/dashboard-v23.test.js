const test=require('node:test'); const assert=require('node:assert/strict');
const {buildBtcChartValues}=require('../lib/dashboard-telemetry');
test('BTC chart accepts only BTC/USD values, never Kalshi 0-1 prices',()=>{
 const v=buildBtcChartValues({btcPriceUsd:74382,targetPriceUsd:74410,yesPrice:.63,noPrice:.37});
 assert.deepEqual(v,{btcPriceUsd:74382,targetPriceUsd:74410,warming:false}); assert.ok(v.btcPriceUsd>70000&&v.targetPriceUsd>70000);
 assert.equal(buildBtcChartValues({btcPriceUsd:.63,targetPriceUsd:.37}).warming,true);
});

test('telemetry state emits price and market updates independently of strategy cycles',()=>{
 const BotState=require('../bot/state'); const st=new BotState(); let price=null, markets=null;
 st.once('price:binance',x=>price=x); st.once('markets',x=>markets=x);
 st.updateBinancePrice(74381,74383); st.updateMarkets([{ticker:'KXBTC15M-T',closeTime:Date.now()+500000,yesAsk:.63,noAsk:.37}]);
 assert.equal(price.mid,74382); assert.equal(markets[0].ticker,'KXBTC15M-T');
});
