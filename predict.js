const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function generateForecasts() {
  console.log('Running advanced predictive modeling pipeline...');

  for (const symbol of ['WTI', 'BRENT']) {
    // Fetch last 30 recorded prices
    const { data: history } = await supabase
      .from('oil_prices')
      .select('price, recorded_at')
      .eq('symbol', symbol)
      .order('recorded_at', { ascending: false })
      .limit(30);

    if (!history || history.length < 10) {
      console.log(`Not enough historical data to forecast ${symbol}`);
      continue;
    }

    // Fetch recent average news sentiment to weight the prediction
    const { data: news } = await supabase
      .from('oil_news')
      .select('sentiment_score')
      .not('sentiment_score', 'is', null)
      .order('published_at', { ascending: false })
      .limit(20);

    let avgSentiment = 0.0;
    if (news && news.length > 0) {
      avgSentiment = news.reduce((acc, curr) => acc + curr.sentiment_score, 0) / news.length;
    }

    // Calculate baseline trend using recent prices (Simple Moving Average & Momentum)
    const prices = history.reverse().map(h => Number(h.price));
    const currentPrice = prices[prices.length - 1];
    const dailyChanges = [];
    for (let i = 1; i < prices.length; i++) {
      dailyChanges.push(prices[i] - prices[i - 1]);
    }
    const avgDailyChange = dailyChanges.reduce((a, b) => a + b, 0) / dailyChanges.length;

    // Sentiment multiplier: positive sentiment nudges price up, negative down
    const sentimentBias = avgSentiment * 0.35; 

    console.log(`Generating 5-day forecast for ${symbol} (Current: $${currentPrice}, Sentiment Bias: ${sentimentBias.toFixed(2)})`);

    const forecastsToInsert = [];
    let rollingPrice = currentPrice;

    for (let day = 1; day <= 5; day++) {
      // Combine historical momentum + sentiment adjustment with slight dampening
      rollingPrice += avgDailyChange * 0.5 + sentimentBias;
      
      const targetDate = new Date();
      targetDate.setDate(targetDate.getDate() + day);

      forecastsToInsert.push({
        symbol: symbol,
        target_date: targetDate.toISOString().split('T')[0],
        predicted_price: parseFloat(rollingPrice.toFixed(2)),
        lower_bound: parseFloat((rollingPrice * 0.98).toFixed(2)),
        upper_bound: parseFloat((rollingPrice * 1.02).toFixed(2))
      });
    }

    // Save predictions
    const { error } = await supabase.from('price_forecasts').insert(forecastsToInsert);
    if (error) {
      console.error(`Error saving ${symbol} forecasts:`, error.message);
    } else {
      console.log(`Successfully generated and stored 5-day forecast for ${symbol}`);
    }
  }
}

generateForecasts();
