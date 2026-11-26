import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';
import Parser from 'rss-parser';

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
const parser = new Parser({
  timeout: 10000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; OilMarketIntelligence/1.0)'
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FEEDS = [
  { category: 'Financial & Commodity', name: 'OilPrice.com', url: 'https://oilprice.com/rss/main' },
  { category: 'Financial & Commodity', name: 'CNBC Energy', url: 'https://search.cnbc.com/rs/search/combinednews/rss?partnerId=wrnt&keywords=oil' },
  { category: 'OPEC & Production', name: 'OPEC News', url: 'https://www.opec.org/opec_web/en/press_room/28.rss' },
  { category: 'Geopolitical & Politics', name: 'Reuters World News', url: 'https://www.reutersagency.com/feed/?best-topics=world-news&post_type=best' },
  { category: 'Technology & Transition', name: 'CleanTechnica', url: 'https://cleantechnica.com/feed/' },
  { category: 'Financial & Commodity', name: 'FXStreet News', url: 'https://xml.fxstreet.com/news/forex-news/index.xml' },
  { category: 'Financial & Commodity', name: 'ForexLive Investing', url: 'https://investinglive.com/rss/' },
  { category: 'Financial & Commodity', name: 'World Monitor', url: 'https://www.worldmonitor.app/rss' },
  { category: 'Geopolitical & Politics', name: 'Geopolitical Futures', url: 'https://geopoliticalfutures.com/feed/' },
  { category: 'Geopolitical & Politics', name: 'Council on Foreign Relations', url: 'https://www.cfr.org/feed' },
  { category: 'Geopolitical & Politics', name: 'Chatham House', url: 'https://www.chathamhouse.org/path/news-releases.xml' },
  { category: 'Financial & Commodity', name: 'S&P Global Energy & Commodities', url: 'https://www.spglobal.com/en/enterprise/insights/rss/energy-news.rss' },
  { category: 'Financial & Commodity', name: 'Argus Media', url: 'https://www.argusmedia.com/en/news-and-insights/rss' },
  { category: 'Financial & Commodity', name: 'Reuters Energy', url: 'https://www.reutersagency.com/feed/?best-topics=commodities-energy' }
];

function clampScore(num) {
  if (typeof num !== 'number' || Number.isNaN(num)) return 0.0;
  return Math.max(-1.0, Math.min(1.0, Number(num.toFixed(2))));
}

function heuristicOilScore(title = '') {
  const t = title.toLowerCase();
  const bullishTerms = ['surge', 'rises', 'rally', 'attack', 'strike', 'disruption', 'shortage', 'cut', 'opec+', 'sanction', 'tight', 'buying spree', 'draw', 'geopolitical'];
  const bearishTerms = ['slide', 'slump', 'drops', 'falls', 'glut', 'oversupply', 'surplus', 'ceasefire', 'deal', 'slowdown', 'weak demand', 'build'];

  let score = 0;
  for (const term of bullishTerms) {
    if (t.includes(term)) score += 0.25;
  }
  for (const term of bearishTerms) {
    if (t.includes(term)) score -= 0.25;
  }
  return clampScore(score);
}

async function scoreBatchWithGemini(items, maxRetries = 3) {
  if (!items || items.length === 0) return [];

  const numberedList = items
    .map((item, idx) => `${idx + 1}. [${item.source || item.category || 'Energy'}] ${item.title}`)
    .join('\n');

  const prompt = `
You are a crude oil (WTI & Brent) market sentiment analyst.
For each numbered headline below, return a sentiment score from -1.00 (strongly bearish for crude prices) to +1.00 (strongly bullish for crude prices).
Use 0.00 only when the headline has no meaningful supply, demand, geopolitical, or macro oil impact.
Return ONLY a valid JSON array of numbers in the exact same order, e.g. [0.45, -0.35, 0.00].

Headlines:
${numberedList}
`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
      });

      const raw = (response?.text || '').trim();
      const cleaned = raw.replace(/```json|```/g, '').trim();
      const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const arr = JSON.parse(jsonMatch[0]);
        if (Array.isArray(arr) && arr.length === items.length) {
          return items.map((item, i) => {
            const parsed = clampScore(Number(arr[i]));
            return parsed !== 0 ? parsed : heuristicOilScore(item.title);
          });
        }
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

      if (isTransient && attempt < maxRetries) {
        await sleep(1500 * Math.pow(2, attempt - 1));
        continue;
      }
      console.warn('Gemini batch sentiment warning:', msg);
    }
  }

  return items.map(item => heuristicOilScore(item.title));
}

async function runPipeline() {
  console.log('Starting Oil Market Intelligence Ingestion Pipeline...');
  const newArticles = [];

  for (const feedConfig of FEEDS) {
    try {
      console.log(`Fetching feed [${feedConfig.category}]: ${feedConfig.name}`);
      let feed;
      try {
        feed = await parser.parseURL(feedConfig.url);
      } catch (feedErr) {
        console.warn(`Could not reach RSS endpoint for ${feedConfig.name}: ${feedErr.message || feedErr}`);
        continue;
      }

      for (const item of (feed.items || []).slice(0, 5)) {
        const title = item.title?.trim();
        const url = item.link?.trim();
        const published_at = item.isoDate || item.pubDate || new Date().toISOString();

        if (!title || !url) continue;

        const { data: existing, error: lookupError } = await supabase
          .from('oil_news')
          .select('id')
          .eq('url', url)
          .maybeSingle();

        if (lookupError) {
          console.warn(`Supabase lookup warning for ${url}:`, lookupError.message);
          continue;
        }

        if (!existing) {
          newArticles.push({
            title,
            url,
            source: feedConfig.name,
            category: feedConfig.category,
            published_at
          });
        }
      }
    } catch (err) {
      console.error(`Error processing feed ${feedConfig.name}:`, err.message || err);
    }
  }

  // Score new articles in batches of 10
  for (let i = 0; i < newArticles.length; i += 10) {
    const batch = newArticles.slice(i, i + 10);
    const scores = await scoreBatchWithGemini(batch);

    for (let j = 0; j < batch.length; j++) {
      const art = batch[j];
      const sentiment_score = scores[j] ?? 0.0;
      const { error: insertError } = await supabase.from('oil_news').insert({
        title: art.title,
        url: art.url,
        source: art.source,
        published_at: art.published_at,
        sentiment_score
      });

      if (insertError) {
        console.error(`Failed inserting news item from ${art.source}:`, insertError.message);
      } else {
        console.log(`[${art.source}] (${sentiment_score >= 0 ? '+' : ''}${sentiment_score.toFixed(2)}) ${art.title}`);
      }
    }
  }

  // Re-score up to 15 existing 0.00 rows so older headlines also update
  const { data: zeroRows, error: zeroError } = await supabase
    .from('oil_news')
    .select('id, title, source')
    .eq('sentiment_score', 0)
    .order('published_at', { ascending: false })
    .limit(15);

  if (!zeroError && zeroRows && zeroRows.length > 0) {
    const rescored = await scoreBatchWithGemini(zeroRows);
    for (let i = 0; i < zeroRows.length; i++) {
      const nextScore = rescored[i];
      if (nextScore !== 0) {
        await supabase
          .from('oil_news')
          .update({ sentiment_score: nextScore })
          .eq('id', zeroRows[i].id);
      }
    }
  }

  const { data: recentNews, error: recentError } = await supabase
    .from('oil_news')
    .select('sentiment_score')
    .order('published_at', { ascending: false })
    .limit(30);

  if (!recentError && recentNews && recentNews.length > 0) {
    const avgSentiment =
      recentNews.reduce((acc, curr) => acc + Number(curr.sentiment_score || 0), 0) / recentNews.length;
    console.log(`Calculated Rolling Market Sentiment Average: ${avgSentiment.toFixed(2)}`);
  }

  console.log('Main ingestion pipeline complete.');
}

runPipeline().catch(err => {
  console.error('Fatal ingestion error:', err);
  process.exit(1);
});
