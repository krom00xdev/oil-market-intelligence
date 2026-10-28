const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: WebSocket }
});

async function generateForecasts() {
  console.log('Running 5-day forward predictive engine...');

  try {
    for (const symbol of ['WTI', 'BRENT']) {
      // Fetch the absolute latest live market price from Supabase
      const { data: latestPrice } = await supabase
        .from('oil_prices')
        .select('price')
        .eq('symbol', symbol)
        .order('recorded_at', { ascending: false })
        .limit(1);

      if (!latestPrice || latestPrice.length === 0) {
        console.log(`No active price record found for ${symbol}.`);
        continue;
      }

      const currentPrice = Number(latestPrice[0].price);

      // Fetch recent weighted news sentiment to drive predictive momentum
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

      const directionalBias = avgSentiment * 0.75;

      console.log(`Generating true 5-day outlook for ${symbol} starting from baseline: $${currentPrice}`);

      const forecastsToInsert = [];
      let rollingPrice = currentPrice;

      for (let day = 1; day <= 5; day++) {
        // Compound momentum across sequential future days
        rollingPrice += directionalBias + (Math.sin(day) * 0.25);
        
        // Correctly calculate future dates (Day +1, Day +2, etc.)
        const targetDate = new Date();
        targetDate.setDate(targetDate.getDate() + day);

        forecastsToInsert.push({
          symbol: symbol,
          target_date: targetDate.toISOString().split('T')[0],
          predicted_price: parseFloat(rollingPrice.toFixed(2)),
          lower_bound: parseFloat((rollingPrice * 0.985).toFixed(2)),
          upper_bound: parseFloat((rollingPrice * 1.015).toFixed(2))
        });
      }

      // Clear old projections and insert fresh 5-day horizon
      await supabase.from('price_forecasts').delete().eq('symbol', symbol);
      const { error } = await supabase.from('price_forecasts').insert(forecastsToInsert);
      
      if (error) {
        console.error(`Error saving ${symbol} forecasts:`, error.message);
      } else {
        console.log(`Successfully published 5-day forward trajectory for ${symbol}`);
      }
    }
  } catch (err) {
    console.error('Predictive engine fatal error:', err);
  } finally {
    process.exit(0);
  }
}

generateForecasts();
