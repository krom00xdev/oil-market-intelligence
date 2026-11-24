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

// Comprehensive OSINT, Think Tank, Financial, and Energy Intelligence Feeds
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

async function analyzeSentiment(text, category = 'Energy') {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `Analyze the ${category} / geopolitical / economic impact of this headline on global crude oil prices (WTI/Brent). Return ONLY a floating point sentiment score between -1.0 (extremely bearish) and +1.0 (extremely bullish), with no extra text: "${text}"`,
    });
    const raw = (response.text || '').trim();
    const score = parseFloat(raw);
    return Number.isNaN(score) ? 0.0 : Math.max(-1.0, Math.min(1.0, score));
  } catch (err) {
    console.error('Gemini sentiment analysis error:', err.message || err);
    return 0.0;
  }
}

async function runPipeline() {
  console.log('Starting Oil Market Intelligence Ingestion Pipeline...');

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
          console.log(`[${feedConfig.name}] Analyzing sentiment for: "${title}"`);
          const sentiment_score = await analyzeSentiment(title, feedConfig.category);

          const { error: insertError } = await supabase.from('oil_news').insert({
            title,
            url,
            source: feedConfig.name,
            published_at,
            sentiment_score
          });

          if (insertError) {
            console.error(`Failed inserting news item from ${feedConfig.name}:`, insertError.message);
          }
        }
      }
    } catch (err) {
      console.error(`Error processing feed ${feedConfig.name}:`, err.message || err);
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
