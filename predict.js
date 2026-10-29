const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: WebSocket }
});

async function generateForecasts() {
  console.log('Running 5-day sequential forward predictive engine...');

  try {
    for (const symbol of ['WTI', 'BRENT']) {
      // 1. Fetch latest live price from Supabase
      const { data: latestPrice } = await supabase
        .from('oil_prices')
        .select('price')
        .eq('symbol', symbol)
        .order('recorded_at', { ascending: false })
        .limit(1);

      if (!latestPrice || latestPrice.length === 0) continue;

      const baselinePrice = Number(latestPrice[0].price);

      // 2. Fetch news sentiment
      const { data: news } = await supabase
        .from('oil_news')
        .select('sentiment_score')
        .not('sentiment_score', 'is', null)
        .order('published_at', { ascending: false })
        .limit(15);

      let avgSentiment = 0.0;
      if (news && news.length > 0) {
        avgSentiment = news.reduce((acc, curr) => acc + Number(curr.sentiment_score), 0) / news.length;
      }

      const momentumFactor = avgSentiment * 0.85;
      const forecastsToInsert = [];
      let rollingPrice = baselinePrice;

      // 3. Generate 5 distinct future days (Day +1 to Day +5)
      for (let day = 1; day <= 5; day++) {
        rollingPrice += momentumFactor + (Math.sin(day * 0.8) * 0.35);
        
        const targetDate = new Date();
        targetDate.setDate(targetDate.getDate() + day); // Explicitly increments target date by +1..+5 days
        const formattedDate = targetDate.toISOString().split('T')[0];

        forecastsToInsert.push({
          symbol: symbol,
          target_date: formattedDate,
          predicted_price: parseFloat(rollingPrice.toFixed(2)),
          lower_bound: parseFloat((rollingPrice * 0.982).toFixed(2)),
          upper_bound: parseFloat((rollingPrice * 1.018).toFixed(2))
        });
      }

      // 4. Purge old rows for symbol and save new projection horizon
      await supabase.from('price_forecasts').delete().eq('symbol', symbol);
      await supabase.from('price_forecasts').insert(forecastsToInsert);
      console.log(`Successfully published 5-day trajectory for ${symbol}`);
    }
  } catch (err) {
    console.error('Predictive engine error:', err);
  } finally {
    process.exit(0);
  }
}

generateForecasts();
