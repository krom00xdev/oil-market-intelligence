import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const START_CAPITAL = 1000.0;
const TARGET_CAPITAL = 1100.0;
const RISK_PER_TRADE = 0.02; // 2% risk ($20 on $1,000)

async function generateWeeklyChallengeSignals() {
  // 1. Get latest WTI & Brent prices
  const { data: prices } = await supabase
    .from('oil_prices')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(10);

  const wti = prices?.find(p => ['WTI', 'CL=F', 'USOIL'].includes(String(p.symbol).trim()));
  const brent = prices?.find(p => ['BRENT', 'BZ=F', 'UKOIL'].includes(String(p.symbol).trim()));
  const wtiPrice = wti ? Number(wti.price) : 89.62;
  const brentPrice = brent ? Number(brent.price) : 95.72;

  // 2. Get latest 25 analyzed news headlines & rolling sentiment
  const { data: news } = await supabase
    .from('oil_news')
    .select('title, source, sentiment_score')
    .order('published_at', { ascending: false })
    .limit(25);

  const avgSentiment = news?.length
    ? news.reduce((sum, n) => sum + Number(n.sentiment_score || 0), 0) / news.length
    : 0;

  const headlinesSummary = (news || [])
    .slice(0, 10)
    .map(n => `[${Number(n.sentiment_score).toFixed(2)}] ${n.title} (${n.source})`)
    .join('\n');

  // 3. Calculate current challenge equity from past closed signals in the last 7 days
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const todayStr = new Date().toISOString().split('T')[0];

  const { data: pastSignals } = await supabase
    .from('trade_signals')
    .select('*')
    .gte('target_date', sevenDaysAgo)
    .lt('target_date', todayStr)
    .order('target_date', { ascending: true });

  let currentEquity = START_CAPITAL;
  for (const sig of pastSignals || []) {
    const riskDollars = currentEquity * RISK_PER_TRADE;
    const slDist = Math.abs(Number(sig.entry_price) - Number(sig.stop_loss)) || 0.45;
    const tpDist = Math.abs(Number(sig.take_profit) - Number(sig.entry_price)) || 1.05;
    const rr = tpDist / slDist;

    if (sig.status === 'SUCCESSFUL') {
      currentEquity += riskDollars * rr;
    } else if (sig.status === 'UNSUCCESSFUL') {
      currentEquity -= riskDollars;
    }
  }

  const remainingToGoal = Math.max(0, TARGET_CAPITAL - currentEquity);

  // 4. Ask Gemini for high-conviction setups tailored to the remaining weekly target
  const prompt = `
You are an aggressive crude oil quantitative desk running a 7-day $1,000 to $1,100 (+10%) live capital challenge.
Current Equity: $${currentEquity.toFixed(2)} | Remaining to $1,100 Goal: $${remainingToGoal.toFixed(2)}
WTI Spot: $${wtiPrice.toFixed(2)} | Brent Spot: $${brentPrice.toFixed(2)}
Rolling 25-Article Sentiment Score: ${avgSentiment.toFixed(2)} (-1.0 bearish to +1.0 bullish)

Latest Geopolitical & Energy Headlines:
${headlinesSummary}

Generate 2 high-conviction intraday setups (1 WTI, 1 BRENT) for ${todayStr}.
Strict Rules:
1. Commit to the strongest directional catalyst from the headlines and sentiment score (no neutral hedging).
2. Entry must be within $0.05 to $0.20 of current spot so orders fill cleanly on momentum.
3. Set stop_loss strictly $0.40 to $0.50 away from entry_price.
4. Set take_profit $1.00 to $1.25 away from entry_price (minimum 1:2.2 Risk-to-Reward so 2-3 wins clear the +10% weekly target).
5. Return ONLY valid JSON:
[{"symbol": "WTI", "action": "BUY" | "SELL", "entry_price": number, "stop_loss": number, "take_profit": number, "reasoning": "1-sentence catalyst"}]
`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
  });

  const cleanJson = response.text.replace(/```json|```/g, '').trim();
  const generatedSignals = JSON.parse(cleanJson);

  for (const sig of generatedSignals) {
    const riskDollars = currentEquity * RISK_PER_TRADE;
    const slDist = Math.abs(Number(sig.entry_price) - Number(sig.stop_loss));
    const barrels = Math.max(1, Math.round(riskDollars / slDist));
    const mt5Lots = (barrels / 1000).toFixed(2); // 1 standard oil lot = 1,000 barrels

    await supabase.from('trade_signals').insert({
      target_date: todayStr,
      symbol: sig.symbol,
      action: sig.action,
      entry_price: Number(sig.entry_price.toFixed(2)),
      stop_loss: Number(sig.stop_loss.toFixed(2)),
      take_profit: Number(sig.take_profit.toFixed(2)),
      status: 'ACTIVE',
      reasoning: `[Size: ${barrels} bbl / ${mt5Lots} lots | Risk: $${riskDollars.toFixed(2)}] ${sig.reasoning}`
    });
  }

  console.log(`Generated ${generatedSignals.length} challenge signals. Current Equity: $${currentEquity.toFixed(2)}`);
}

generateWeeklyChallengeSignals();
