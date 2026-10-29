async function generateAITradeSignals() {
  console.log('Generating AI Trade Signals & Risk Management Setups...');
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

  const { data: prices } = await supabase.from('oil_prices').select('symbol, price').order('recorded_at', { ascending: false }).limit(2);
  const { data: forecasts } = await supabase.from('price_forecasts').select('*').order('target_date', { ascending: true }).limit(2);

  const priceSummary = prices ? prices.map(p => `${p.symbol}: $${p.price}`).join(', ') : 'WTI: $101.81, Brent: $110.71';

  const prompt = `
    You are the Chief Global Energy Economist and Senior Quant Trader. 
    Current Prices: ${priceSummary}

    Generate 2 high-conviction experimental trade setups (one for WTI, one for Brent) for tomorrow's session based on current market momentum. 
    Provide precise numbers: Entry Price, Stop Loss (tight risk management), and Take Profit target.
    
    Respond ONLY with a raw JSON array (no markdown, no backticks) containing objects in this exact format:
    [
      {
        "symbol": "WTI",
        "action": "BUY LIMIT",
        "entry_price": 101.50,
        "stop_loss": 99.80,
        "take_profit": 104.20,
        "reasoning": "Strong geopolitical support and bullish inventory draw expected."
      },
      {
        "symbol": "BRENT",
        "action": "SELL LIMIT",
        "entry_price": 111.50,
        "stop_loss": 113.20,
        "take_profit": 108.50,
        "reasoning": "Technical resistance confluence near upper Bollinger band."
      }
    ]
  `;

  try {
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text().trim().replace(/```json/g, '').replace(/```/g, '').trim();
    const signals = JSON.parse(text);

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const targetDateStr = tomorrow.toISOString().split('T')[0];

    const signalsToInsert = signals.map(s => ({
      symbol: s.symbol,
      action: s.action,
      target_date: targetDateStr,
      entry_price: s.entry_price,
      stop_loss: s.stop_loss,
      take_profit: s.take_profit,
      status: 'PENDING',
      reasoning: s.reasoning
    }));

    // Clear old pending signals for tomorrow and insert fresh AI recommendations
    await supabase.from('trade_signals').delete().eq('target_date', targetDateStr);
    const { error } = await supabase.from('trade_signals').insert(signalsToInsert);

    if (error) console.error('Error saving trade signals:', error.message);
    else console.log('Successfully published AI Trade Signals.');
  } catch (err) {
    console.warn('Trade signal generation fallback error:', err.message);
  }
}
