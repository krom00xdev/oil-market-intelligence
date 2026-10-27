
const { createClient } = require('@supabase/supabase-js');
const Parser = require('rss-parser');

// Initialize Supabase Client using GitHub Secrets environment variables
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing Supabase environment variables!");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const parser = new Parser();

// RSS Feeds covering all required oil market categories
const FEEDS = [
  {
    category: 'Financial & Commodity',
    name: 'OilPrice.com',
    url: 'https://oilprice.com/rss/main'
  },
  {
    category: 'Financial & Commodity',
    name: 'CNBC Energy',
    url: 'https://search.cnbc.com/rs/search/combinednews/rss?partnerId=wrnt&keywords=oil'
  },
  {
    category: 'OPEC & Production',
    name: 'OPEC News',
    url: 'https://www.opec.org/opec_web/en/press_room/28.rss'
  },
  {
    category: 'Geopolitical & Politics',
    name: 'Reuters World News',
    url: 'https://www.reutersagency.com/feed/?best-topics=world-news&post_type=best'
  },
  {
    category: 'Technology & Transition',
    name: 'CleanTechnica',
    url: 'https://cleantechnica.com/feed/'
  }
];

// Keywords to filter general feeds for oil/energy relevancy
const KEYWORDS = [
  'oil', 'crude', 'brent', 'wti', 'opec', 'petroleum', 'gasoline', 
  'energy', 'barrel', 'sanctions', 'refinery', 'drill', 'saudi', 
  'middle east', 'suez', 'strait of hormuz', 'pipeline', 'ev', 'renewables'
];

function isRelevant(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return KEYWORDS.some(kw => lower.includes(kw));
}

async function collectNews() {
  console.log(`[${new Date().toISOString()}] Starting Oil News Collection...`);
  let totalSaved = 0;

  for (const feedConfig of FEEDS) {
    try {
      console.log(`Fetching: ${feedConfig.name} (${feedConfig.category})...`);
      const feed = await parser.parseURL(feedConfig.url);
      const articlesToInsert = [];

      for (const item of feed.items) {
        const title = item.title || '';
        const description = item.contentSnippet || item.content || '';
        const link = item.link;

        if (feedConfig.category === 'Financial & Commodity' || isRelevant(`${title} ${description}`)) {
          articlesToInsert.push({
            title: title.trim(),
            description: description.trim().substring(0, 500),
            source: feedConfig.name,
            url: link,
            category: feedConfig.category,
            published_at: item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString()
          });
        }
      }

      if (articlesToInsert.length > 0) {
        const { error } = await supabase
          .from('oil_news')
          .upsert(articlesToInsert, { onConflict: 'url', ignoreDuplicates: true });

        if (error) {
          console.error(`Error saving ${feedConfig.name}:`, error.message);
        } else {
          console.log(`Saved/Updated ${articlesToInsert.length} articles from ${feedConfig.name}`);
          totalSaved += articlesToInsert.length;
        }
      }
    } catch (err) {
      console.error(`Failed to fetch feed ${feedConfig.name}:`, err.message);
    }
  }

  console.log(`[${new Date().toISOString()}] Scraping completed. Processed ${totalSaved} relevant items.`);
}

collectNews();
