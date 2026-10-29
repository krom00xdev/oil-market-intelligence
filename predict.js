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
        const validNews = news.filter(n => n.sentiment_score !== null && !isNaN(Number(n.sentiment_score)));
        if (validNews.length > 0) {
          avgSentiment = validNews.reduce((acc, curr) => acc + Number(curr.sentiment_score), 0) / validNews.length;
        }
      }

      const momentumFactor = avgSentiment * 0.85;
      const forecastsToInsert = [];
      let rollingPrice = baselinePrice;

      // 3. Generate 5 strictly unique future calendar dates (Day +1 to Day +5)
      const baseDate = new Date();
      
      for (let day = 1; day <= 5; day++) {
        rollingPrice += momentumFactor + (Math.sin(day * 0.8) * 0.35);
        
        const targetDate = new Date(baseDate);
        targetDate.setDate(baseDate.getDate() + day);
        
        // Format strictly as YYYY-MM-DD string to prevent grouping collisions
        const yyyy = targetDate.getFullYear();
        const mm = String(targetDate.getMonth() + 1).padStart(2, '0');
        const dd = String(targetDate.getDate()).padStart(2, '0');
        const formattedDate = `${yyyy}-${mm}-${dd}`;

        forecastsToInsert.push({
          symbol: symbol,
          target_date: formattedDate,
          predicted_price: parseFloat(rollingPrice.toFixed(2)),
          lower_bound: parseFloat((rollingPrice * 0.982).toFixed(2)),
          upper_bound: parseFloat((rollingPrice * 1.018).toFixed(2))
        });
      }

      // 4. Purge old rows for symbol and insert fresh 5-day horizon
      await supabase.from('price_forecasts').delete().eq('symbol', symbol);
      const { error } = await supabase.from('price_forecasts').insert(forecastsToInsert);
      
      if (error) {
        console.error(`Error saving ${symbol} forecasts:`, error.message);
      } else {
        console.log(`Successfully published 5-day trajectory for ${symbol}:`, forecastsToInsert.map(f => f.target_date));
      }
    }
  } catch (err) {
    console.error('Predictive engine error:', err);
  } finally {
    process.exit(0);
  }
}

generateForecasts();
