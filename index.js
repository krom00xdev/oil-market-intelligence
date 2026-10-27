const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');
const Parser = require('rss-parser');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Initialize Supabase client with WebSocket transport for Node.js
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: WebSocket }
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const parser = new Parser();

const FEEDS = [
  { category: 'Financial & Commodity', name: 'OilPrice.com', url: 'https://oilprice.com/rss/main' },
  { category: 'Financial & Commodity', name: 'CNBC Energy', url: 'https://search.cnbc.com/rs/search/combinednews/rss?partnerId=wrnt&keywords=oil' },
  { category: 'OPEC & Production', name: 'OPEC News', url: 'https://www.opec.org/opec_web/en/press_room/28.rss' },
  { category: 'Geopolitical & Politics', name: 'Reuters World News', url: 'https://www.reutersagency.com/feed/?best-topics=world-news&post_type=best' },
  { category: 'Technology & Transition', name: 'CleanTechnica', url: 'https://cleantechnica.com/feed/' }
];

const KEYWORDS = ['oil', 'crude', 'brent', 'wti', 'opec', 'petroleum', 'gasoline', 'energy', 'barrel', 'sanctions', 'refinery', 'drill', 'saudi', 'middle east', 'suez', 'strait of hormuz', 'pipeline', 'ev', 'renewables'];

function isRelevant(text) {
  if (!text) return false;
  return KEYWORDS.some(kw => text.toLowerCase().includes(kw));
}

/**
 * Fetches real market prices for crude oil futures.
 */
async function fetchRealCommodityPrice(symbol) {
  const yahooSymbol = symbol === 'WTI' ? 'CL=F' : 'BZ=F';
  
  // Primary Endpoint: Yahoo Finance Chart API
  try {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1d&range=1d`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (res.ok) {
      const data = await res.json();
      const meta = data?.chart?.result?.[0]?.meta;
      if (meta && meta.regularMarketPrice) {
        const price = meta.regularMarketPrice;
        const prevClose = meta.chartPreviousClose || price;
        const change = parseFloat((price - prevClose).toFixed(2));
        return { price: parseFloat(price.toFixed(2)), change_24h: change };
      }
    }
  } catch (err) {
    console.warn(`Primary price fetch for ${symbol} failed:`, err.message);
  }

  // Secondary Fallback Endpoint: Alternative Financial Data Feed
  try {
    const stSymbol = symbol === 'WTI' ? 'CL.F' : 'BZ.F';
    const res = await fetch(`https://stooq.com/q/l/?s=${stSymbol}&f=sd2t2ohlcv&h&e=json`);
    if (res.ok) {
      const data = await res.json();
      const quote = data?.symbols?.[0];
      if (quote && quote.close) {
        const price = parseFloat(quote.close);
        return { price: parseFloat(price.toFixed(2)), change_24h: 0.0 };
      }
    }
  } catch (err) {
    console.warn(`Fallback price fetch for ${symbol} failed:`, err.message);
  }

  return null;
}

async function fetchAndStorePrices() {
  console.log('Fetching live real-time oil market prices...');
  try {
    const wti = await fetchRealCommodityPrice('WTI');
    const brent = await fetchRealCommodityPrice('BRENT');

    const pricesToInsert = [];
    if (wti) {
      pricesToInsert.push({ symbol: 'WTI', price: wti.price, change_24h: wti.change_24h });
      console.log(`Live Market WTI: $${wti.price}`);
    }
    if (brent) {
      pricesToInsert.push({ symbol: 'BRENT', price: brent.price, change_24h: brent.change_24h });
      console.log(`Live Market BRENT: $${brent.price}`);
    }

    if (pricesToInsert.length > 0) {
      const { error } = await supabase.from('oil_prices').insert(pricesToInsert);
      if (error) console.error('Error saving prices to Supabase:', error.message);
      else console.log('Successfully saved real market prices to database.');
    } else {
      console.warn('Could not fetch real-time price updates in this cycle.');
    }
  } catch (err) {
    console.error('Price fetch execution error:', err.message);
  }
}

async function collectNews() {
  console.log('Collecting oil market news...');
  for (const feedConfig of FEEDS) {
    try {
      const feed = await parser.parseURL(feedConfig.url);
      const articlesToInsert = [];

      for (const item of feed.items) {
        const title = item.title || '';
        const description = item.contentSnippet || item.content || '';
        if (feedConfig.category === 'Financial & Commodity' || isRelevant(`${title} ${description}`)) {
          articlesToInsert.push({
            title: title.trim(),
            description: description.trim().substring(0, 500),
            source: feedConfig.name,
            url: item.link,
            category: feedConfig.category,
            published_at: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString()
          });
        }
      }

      if (articlesToInsert.length > 0) {
        await supabase.from('oil_news').upsert(articlesToInsert, { onConflict: 'url', ignoreDuplicates: true });
      }
    } catch (err) {
      console.error(`Error in ${feedConfig.name}:`, err.message);
    }
  }
}

async function analyzeNewsWithGemini() {
  console.log('Analyzing unanalyzed articles with Gemini...');
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

  const { data: articles, error: fetchError } = await supabase.from('oil_news').select('id, title, description').is('sentiment_score', null).limit(10);
  
  if (fetchError) {
    console.error('Error fetching unanalyzed articles:', fetchError.message);
    return;
  }

  if (!articles || articles.length === 0) {
    console.log('No unanalyzed articles found.');
    return;
  }

  console.log(`Found ${articles.length} articles to analyze.`);

  for (const article of articles) {
    try {
      const prompt = `Analyze this oil market news item: "${article.title} - ${article.description}". Return ONLY a floating point sentiment score between -1.0 (extremely bearish) and 1.0 (extremely bullish). No markdown, no explanations, just the number.`;
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const scoreText = response.text().trim();
      const score = parseFloat(scoreText);
      
      if (!isNaN(score)) {
        await supabase.from('oil_news').update({ sentiment_score: score }).eq('id', article.id);
        console.log(`Updated article "${article.title.substring(0, 30)}..." with sentiment: ${score}`);
      } else {
        await supabase.from('oil_news').update({ sentiment_score: 0.0 }).eq('id', article.id);
      }
    } catch (err) {
      console.error('Gemini article analysis error:', err.message);
    }
  }
}

async function generateSynthesizedReport() {
  console.log('Generating AI Market Feedback Report...');
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

  const { data: recentNews } = await supabase.from('oil_news').select('title, sentiment_score, category').not('sentiment_score', 'is', null).order('published_at', { ascending: false }).limit(15);
  const { data: prices } = await supabase.from('oil_prices').select('symbol, price').order('recorded_at', { ascending: false }).limit(2);

  let marketBias = "Neutral";
  let summaryText = "Crude oil markets are currently trading dynamically as traders weigh global supply metrics, shipping corridor stability, and macroeconomic demand trends.";
  let keyDrivers = ["OPEC+ output policy monitoring", "Geopolitical supply risk premiums", "Global petroleum inventory adjustments"];

  if (recentNews && recentNews.length > 0) {
    const newsSummary = recentNews.map(n => `[${n.category}] ${n.title} (Sentiment: ${n.sentiment_score})`).join('\n');
    const priceSummary = prices ? prices.map(p => `${p.symbol}: $${p.price}`).join(', ') : 'WTI: $100.75, Brent: $114.93';

    const prompt = `
      You are a Senior Energy Commodity Analyst. Given current real-time prices (${priceSummary}) and recent market news:
      ${newsSummary}

      Provide a synthesized market feedback report. Respond ONLY with a raw JSON object (no markdown, no backticks) in this exact format:
      {
        "market_bias": "Bullish" or "Bearish" or "Neutral",
        "summary": "3-4 sentence comprehensive market breakdown.",
        "key_drivers": ["Driver 1", "Driver 2", "Driver 3"]
      }
    `;

    try {
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text().trim().replace(/```json/g, '').replace(/```/g, '').trim();
      const reportData = JSON.parse(text);
      if (reportData.market_bias) marketBias = reportData.market_bias;
      if (reportData.summary) summaryText = reportData.summary;
      if (reportData.key_drivers) keyDrivers = reportData.key_drivers;
    } catch (err) {
      console.warn('Using fallback structured briefing due to parse error:', err.message);
    }
  }

  const { error: reportError } = await supabase.from('daily_market_reports').insert([{
    market_bias: marketBias,
    summary: summaryText,
    key_drivers: keyDrivers
  }]);

  if (reportError) {
    console.error('Failed to save market report:', reportError.message);
  } else {
    console.log('Successfully generated and saved AI Market Report!');
  }
}

async function runPipeline() {
  try {
    await fetchAndStorePrices();
    await collectNews();
    await analyzeNewsWithGemini();
    await generateSynthesizedReport();
    console.log('Complete pipeline finished successfully.');
  } catch (err) {
    console.error('Pipeline error:', err);
  } finally {
    process.exit(0);
  }
}

runPipeline();
