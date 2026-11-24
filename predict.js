import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;
const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing SUPABASE_URL or Supabase key (SUPABASE_ANON_KEY / SUPABASE_KEY / SUPABASE_SERVICE_ROLE_KEY).');
  process.exit(1);
}

if (!geminiKey) {
  console.error('Missing GEMINI_API_KEY (or GOOGLE_API_KEY).');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const ai = new GoogleGenAI({ apiKey: geminiKey });

const START_CAPITAL = 1000.0;
const TARGET_CAPITAL = 1100.0;
const RISK_PER_TRADE = 0.02; // 2% risk per trade ($20 on $1,000)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function generateWithRetry(prompt, models = ['gemini-3.8-flash'], maxRetriesPerModel = 3) {
  for (const model of models) {
    for (let attempt = 1; attempt <= maxRetriesPerModel; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: prompt,
        });
        if (response && response.text) {
          return response.text;
        }
      } catch (err) {
        const msg = String(err?.message || err || '');
        const isTransient =
          err?.status === 503 ||
          err?.status === 429 ||
          msg.includes('503') ||
          msg.includes('429') ||
          msg.includes('UNAVAILABLE') ||
          msg.includes('high demand');

        console.warn(`[${model}] Attempt ${attempt}/${maxRetriesPerModel} failed: ${msg}`);

        if (isTransient && attempt < maxRetriesPerModel) {
          const backoffMs = 1500 * Math.pow(2, attempt - 1); // 1.5s, 3s, 6s
          console.log(`Waiting ${backoffMs}ms before retrying ${model}...`);
          await sleep(backoffMs);
          continue;
        }
        break;
      }
    }
  }
  return null;
}

function buildFallbackSignals(wtiPrice, brentPrice, avgSentiment) {
  const isBullish = avgSentiment >= 0;
  const wtiAction = isBullish ? 'BUY' : 'SELL';
  const brentAction = isBullish ? 'BUY' : 'SELL';

  const wtiEntry = Number((wtiPrice + (isBullish ? 0.12 : -0.12)).toFixed(2));
  const wtiSl = Number((wtiEntry + (isBullish ? -0.45 : 0.45)).toFixed(2));
  const wtiTp = Number((wtiEntry + (isBullish ? 1.10 : -1.10)).toFixed(2));

  const brentEntry = Number((brentPrice + (isBullish ? 0.15 : -0.15)).toFixed(2));
  const brentSl = Number((brentEntry + (isBullish ? -0.45 : 0.45)).toFixed(2));
  const brentTp = Number((brentEntry + (isBullish ? 1.15 : -1.15)).toFixed(2));

  return [
    {
      symbol: 'WTI',
      action: wtiAction,
      entry_price: wtiEntry,
      stop_loss: wtiSl,
      take_profit: wtiTp,
      reasoning: `Fallback momentum setup aligned with rolling sentiment (${avgSentiment.toFixed(2)}).`
    },
    {
      symbol: 'BRENT',
      action: brentAction,
      entry_price: brentEntry,
      stop_loss: brentSl,
      take_profit: brentTp,
      reasoning: `Fallback Brent breakout setup aligned with rolling sentiment (${avgSentiment.toFixed(2)}).`
    }
  ];
}

async function generateWeeklyChallengeSignals() {
  try {
    // 1. Fetch latest WTI & Brent prices
    const { data: prices, error: pricesError } = await supabase
      .from('oil_prices')
      .select('*')
      .limit(20);

    if (pricesError) {
      console.warn('Warning fetching oil_prices:', pricesError.message);
    }

    const wti = prices?.find(p => ['WTI', 'wti', 'CL=F', 'USOIL'].includes(String(p.symbol || '').trim()));
    const brent = prices?.find(p => ['BRENT', 'brent', 'BZ=F', 'UKOIL'].includes(String(p.symbol || '').trim()));
    const wtiPrice = wti ? Number(wti.price) : 89.62;
    const brentPrice = brent ? Number(brent.price) : 95.72;

    // 2. Fetch latest 25 analyzed news headlines & rolling sentiment
    const { data: news, error: newsError } = await supabase
      .from('oil_news')
      .select('title, source, sentiment_score')
      .order('published_at', { ascending: false })
      .limit(25);

    if (newsError) {
      console.warn('Warning fetching oil_news:', newsError.message);
    }

    const avgSentiment = news?.length
      ? news.reduce((sum, n) => sum + Number(n.sentiment_score || 0), 0) / news.length
      : 0;

    const headlinesSummary = (news || [])
      .slice(0, 10)
      .map(n => `[${Number(n.sentiment_score || 0).toFixed(2)}] ${n.title} (${n.source})`)
      .join('\n');

    // 3. Calculate current challenge equity from closed signals over the last 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const todayStr = new Date().toISOString().split('T')[0];

    const { data: pastSignals, error: signalsError } = await supabase
      .from('trade_signals')
      .select('*')
      .gte('target_date', sevenDaysAgo)
      .lt('target_date', todayStr)
      .order('target_date', { ascending: true });

    if (signalsError) {
      console.warn('Warning fetching past trade_signals:', signalsError.message);
    }

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

    // 4. Generate aggressive signals with Gemini (with retry + fallback)
    const prompt = `
You are an aggressive intraday crude oil momentum trader (WTI & Brent) running a 7-day $1,000 to $1,100 (+10%) capital challenge.
Current Equity: $${currentEquity.toFixed(2)} | Remaining to $1,100 Goal: $${remainingToGoal.toFixed(2)}
WTI Spot: $${wtiPrice.toFixed(2)} | Brent Spot: $${brentPrice.toFixed(2)}
Rolling 25-Article Sentiment Score: ${avgSentiment.toFixed(2)} (-1.0 bearish to +1.0 bullish)

Latest Geopolitical & Energy Headlines:
${headlinesSummary || 'No recent headlines available.'}

Generate 2 aggressive, high-conviction trade signals (1 for WTI, 1 for BRENT) for ${todayStr}.
Rules:
1. Commit strongly to the momentum and sentiment trend instead of alternating randomly.
2. Set entry_price within $0.05 to $0.20 of current spot so momentum fills the trade.
3. Set stop_loss $0.40 to $0.50 away from entry_price.
4. Set take_profit $1.00 to $1.25 away from entry_price (minimum 1:2.2 R:R).
5. Return ONLY a valid JSON array with no markdown:
[{"symbol": "WTI", "action": "BUY" | "SELL", "entry_price": number, "stop_loss": number, "take_profit": number, "reasoning": "concise 1-sentence catalyst"}]
`;

    let generatedSignals = [];
    const rawText = await generateWithRetry(prompt, ['gemini-3.8-flash'], 3);

    if (rawText) {
      try {
        const cleanJson = rawText.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(cleanJson);
        if (Array.isArray(parsed) && parsed.length > 0) {
          generatedSignals = parsed;
        }
      } catch (parseErr) {
        console.warn('Could not parse Gemini JSON, using momentum fallback:', parseErr.message);
      }
    }

    if (generatedSignals.length === 0) {
      console.warn('Gemini unavailable after retries; generating fallback momentum signals.');
      generatedSignals = buildFallbackSignals(wtiPrice, brentPrice, avgSentiment);
    }

    for (const sig of generatedSignals) {
      const symbol = String(sig.symbol || 'WTI').toUpperCase().includes('BRENT') ? 'BRENT' : 'WTI';
      const action = String(sig.action || 'BUY').toUpperCase().includes('SELL') ? 'SELL' : 'BUY';
      const entryPrice = Number(sig.entry_price);
      const stopLoss = Number(sig.stop_loss);
      const takeProfit = Number(sig.take_profit);

      if ([entryPrice, stopLoss, takeProfit].some(n => Number.isNaN(n))) {
        console.warn('Skipping invalid numeric signal values:', sig);
        continue;
      }

      const riskDollars = currentEquity * RISK_PER_TRADE;
      const slDist = Math.abs(entryPrice - stopLoss) || 0.45;
      const barrels = Math.max(1, Math.round(riskDollars / slDist));
      const mt5Lots = (barrels / 1000).toFixed(2);

      const { error: insertError } = await supabase.from('trade_signals').insert({
        target_date: todayStr,
        symbol,
        action,
        entry_price: Number(entryPrice.toFixed(2)),
        stop_loss: Number(stopLoss.toFixed(2)),
        take_profit: Number(takeProfit.toFixed(2)),
        status: 'ACTIVE',
        reasoning: `[Size: ${barrels} bbl / ${mt5Lots} lots | Risk: $${riskDollars.toFixed(2)}] ${sig.reasoning || ''}`
      });

      if (insertError) {
        console.error(`Failed inserting ${symbol} signal:`, insertError.message);
      } else {
        console.log(`Inserted ${symbol} ${action} signal for ${todayStr} @ $${entryPrice.toFixed(2)}`);
      }
    }

    console.log(`Predictive step complete. Current Equity: $${currentEquity.toFixed(2)}`);
  } catch (err) {
    console.error('Predictive model error:', err);
    process.exit(1);
  }
}

generateWeeklyChallengeSignals();
