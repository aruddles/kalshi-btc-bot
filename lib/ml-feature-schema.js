'use strict';
const FEATURE_NAMES=Object.freeze(['spot_move','abs_move','move_dir','time_remaining','time_elapsed','volatility','high_vol','edge','model_prob','price','contracts','yes_spread','no_spread','combined_ask','dual_margin','is_directional','is_poly_arb','is_dual_side','is_buy_yes','trend_aligned','trend_counter','trend_strength','trend_roc','recent_wr','recent_pnl','streak','balance']);
const HISTORICAL_UNAVAILABLE_FEATURES=Object.freeze(['edge','model_prob','contracts','is_directional','is_poly_arb','is_dual_side','is_buy_yes','trend_aligned','trend_counter','recent_wr','recent_pnl','streak','balance']);
const FULL_FEATURE_SCHEMA=Object.freeze(FEATURE_NAMES.map((name,index)=>({index,name})));
const MARKET_ONLY_FEATURE_SCHEMA=Object.freeze(FULL_FEATURE_SCHEMA.filter(x=>!HISTORICAL_UNAVAILABLE_FEATURES.includes(x.name)));
const MARKET_ONLY_FEATURE_INDEXES=Object.freeze(MARKET_ONLY_FEATURE_SCHEMA.map(x=>x.index));
const MARKET_ONLY_FEATURE_NAMES=Object.freeze(MARKET_ONLY_FEATURE_SCHEMA.map(x=>x.name));
module.exports={FEATURE_NAMES,HISTORICAL_UNAVAILABLE_FEATURES,FULL_FEATURE_SCHEMA,MARKET_ONLY_FEATURE_SCHEMA,MARKET_ONLY_FEATURE_INDEXES,MARKET_ONLY_FEATURE_NAMES};
