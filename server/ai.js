const Anthropic = require('@anthropic-ai/sdk');

let client = null;

function getClient() {
  if (!client && process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'your_anthropic_api_key_here') {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

/**
 * Analyze a news headline using Claude API.
 * Returns structured impact data with detailed reasoning for each industry.
 */
async function analyzeHeadline(headline, availableIndustries, stockContext = []) {
  const anthropic = getClient();

  if (!anthropic) {
    console.warn('Claude API key not configured — using fallback analysis');
    return fallbackAnalysis(headline, availableIndustries);
  }

  // Build stock context string for the prompt
  let stockInfo = '';
  if (stockContext.length > 0) {
    stockInfo = '\n\nStocks in the simulation:\n' + stockContext.map(s =>
      `- ${s.ticker} (${s.name}) — Industry: ${s.industry}${s.description ? ` — ${s.description}` : ''}`
    ).join('\n');
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `You are an expert financial analyst advising on a stock market simulation. Analyze this news headline and determine its impact on stock market industries.

Available industries in this simulation: ${availableIndustries.join(', ')}${stockInfo}

News headline: "${headline}"

Respond ONLY with valid JSON in this exact format, no other text:
{
  "impacts": [
    {
      "industry": "IndustryName",
      "sentiment": "positive|negative|neutral",
      "strength": "mild|moderate|strong",
      "reasoning": "A detailed 2-4 sentence explanation of WHY this industry is affected. Explain the real-world market logic, the causal chain from the news to the price movement, and what a smart investor would likely do in response. Example: 'Rising energy subsidies typically reduce operating costs for renewable firms, increasing their profit margins. Investors would likely rotate into this sector anticipating earnings growth, driving demand and price upward.'"
    }
  ],
  "summary": "Brief 1-sentence overall market impact summary",
  "smartInvestorAction": "A 2-3 sentence explanation of what action (buy/sell/hold/switch sector) a smart investor would take in response to this news and why. Be specific about which industries to buy into, sell out of, or hold."
}

Rules:
- Only include industries from the available list that are genuinely affected
- Be realistic about which industries would be impacted
- Consider the company descriptions when determining impact relevance
- If no industries are clearly affected, return an empty impacts array
- strength should reflect how significantly the news would move stock prices
- The reasoning for each industry MUST explain the causal mechanism and investor behavior
- smartInvestorAction should be actionable and educational`
      }]
    });

    const text = response.content[0].text.trim();
    // Extract JSON from the response (handle potential markdown wrapping)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    throw new Error('No valid JSON in response');
  } catch (error) {
    console.error('Claude API error:', error.message);
    return fallbackAnalysis(headline, availableIndustries);
  }
}

/**
 * Fallback keyword-based analysis when Claude API is unavailable.
 */
function fallbackAnalysis(headline, availableIndustries) {
  const lower = headline.toLowerCase();
  const impacts = [];

  const keywordMap = {
    'Energy': {
      positive: ['renewable', 'solar', 'wind', 'subsid', 'green energy', 'clean energy', 'oil price rise', 'energy boom', 'power grid', 'energy deal'],
      negative: ['oil spill', 'pipeline leak', 'energy crisis', 'fossil fuel ban', 'carbon tax', 'energy crash', 'blackout', 'power outage'],
      posReasoning: 'Positive energy news typically signals increased investment and government support for the sector. Higher revenue expectations drive investor confidence and stock demand upward.',
      negReasoning: 'Negative energy events create regulatory risk and operational disruption. Investors typically sell positions to avoid exposure to potential losses and liability.'
    },
    'Technology': {
      positive: ['ai', 'artificial intelligence', 'tech boom', 'innovation', 'digital', 'cloud', 'semiconductor', 'chip', '5g', 'quantum', 'software'],
      negative: ['data breach', 'hack', 'tech crash', 'regulation', 'antitrust', 'privacy scandal', 'tech layoff', 'cybersecurity'],
      posReasoning: 'Technology advances create new market opportunities and revenue streams. Growth investors typically increase positions anticipating higher future earnings and market expansion.',
      negReasoning: 'Technology sector setbacks raise concerns about security, regulatory compliance costs, and growth sustainability. Risk-averse investors rotate out to safer sectors.'
    },
    'Healthcare': {
      positive: ['vaccine', 'drug approval', 'medical breakthrough', 'healthcare funding', 'biotech', 'cure', 'health initiative'],
      negative: ['pandemic', 'drug recall', 'healthcare cut', 'patent expire', 'clinical trial fail', 'health scare', 'outbreak'],
      posReasoning: 'Healthcare breakthroughs signal new revenue pipelines for pharmaceutical and biotech firms. Smart investors position early in anticipation of FDA approvals and market exclusivity.',
      negReasoning: 'Healthcare setbacks erode market confidence in drug pipelines and regulatory approval odds. Investors typically reduce exposure until clarity emerges on the impact scope.'
    },
    'Finance': {
      positive: ['interest rate cut', 'bank profit', 'economic growth', 'gdp rise', 'financial boom', 'credit expansion', 'ipo', 'hedge fund', 'investment', 'bull market', 'equity', 'fund raise', 'market rally', 'buyback', 'dividend', 'asset management', 'venture capital', 'fintech', 'demat', 'mutual fund'],
      negative: ['bank fail', 'recession', 'interest rate hike', 'inflation', 'debt crisis', 'default', 'financial crash', 'npa', 'scam', 'fraud', 'bear market', 'margin call', 'liquidity crisis', 'insolvency', 'bailout', 'ponzi', 'money laundering', 'tax evasion', 'sebi penalty', 'rbi action'],
      posReasoning: 'Favorable financial conditions expand lending margins and credit availability. Financial sector stocks benefit from increased transaction volumes and higher net interest margins.',
      negReasoning: 'Financial stress events create systemic risk fears and potential credit losses. Investors de-risk portfolios by reducing bank and financial services exposure.'
    },
    'Consumer Goods': {
      positive: ['consumer spend', 'retail boom', 'holiday sale', 'consumer confidence', 'demand surge', 'brand launch', 'fmcg'],
      negative: ['recall', 'supply chain', 'consumer boycott', 'inflation hit', 'retail decline', 'counterfeit'],
      posReasoning: 'Rising consumer spending directly improves revenue for consumer goods companies. Higher demand leads to better pricing power and margin expansion.',
      negReasoning: 'Consumer sector disruptions reduce sales volumes and damage brand value. Cost-conscious investors shift to defensive positions in staples over discretionary goods.'
    },
    'Manufacturing': {
      positive: ['factory', 'production increase', 'manufacturing boom', 'industrial growth', 'infrastructure', 'make in india', 'assembly'],
      negative: ['supply disruption', 'factory close', 'manufacturing decline', 'trade war', 'tariff', 'industrial accident'],
      posReasoning: 'Industrial expansion increases order books and production utilization rates. Manufacturing stocks benefit from economies of scale and infrastructure development spending.',
      negReasoning: 'Manufacturing disruptions reduce output capacity and increase per-unit costs. Supply chain uncertainty leads investors to lower earnings estimates for the sector.'
    },
    'Real Estate': {
      positive: ['housing boom', 'property value', 'real estate surge', 'construction boom', 'mortgage rate drop', 'realty', 'smart city'],
      negative: ['housing crash', 'property decline', 'mortgage crisis', 'eviction', 'housing bubble', 'stalled project'],
      posReasoning: 'Real estate appreciation improves developer margins and asset valuations. Lower borrowing costs stimulate demand, benefiting the entire property ecosystem.',
      negReasoning: 'Real estate downturns reduce property values and increase default risks on developer loans. Investors hedge by reducing exposure to leveraged real estate companies.'
    },
    'Telecommunications': {
      positive: ['5g rollout', 'spectrum', 'telecom expansion', 'broadband', 'fiber optic', 'subscriber growth', 'network upgrade', 'telecom merger'],
      negative: ['network outage', 'telecom fine', 'spectrum auction fail', 'call drop', 'telecom debt', 'service disruption', 'tower collapse'],
      posReasoning: 'Telecom infrastructure investment expands subscriber base and average revenue per user. Network upgrades position telecoms for future data consumption growth.',
      negReasoning: 'Service disruptions erode customer trust and increase churn rates. Regulatory penalties reduce free cash flow available for dividends and growth investment.'
    },
    'Automotive': {
      positive: ['electric vehicle', 'ev launch', 'auto sales', 'car demand', 'electric car', 'autonomous driving', 'auto expo', 'vehicle production'],
      negative: ['vehicle recall', 'auto crash', 'emission scandal', 'chip shortage', 'auto strike', 'car accident', 'safety defect'],
      posReasoning: 'Strong automotive demand, especially in EVs, signals a secular growth trend. Investors value the transition to electric mobility as a long-term value creator for early movers.',
      negReasoning: 'Automotive recalls and production issues increase warranty costs and damage brand reputation. Supply chain shortages reduce production forecasts and dealer inventory levels.'
    },
    'Aviation': {
      positive: ['airline profit', 'new route', 'aviation growth', 'flight demand', 'airport expansion', 'air travel surge', 'fleet expansion'],
      negative: ['airline loss', 'flight cancel', 'aviation crash', 'jet fuel price', 'turbulence', 'grounding', 'pilot strike', 'airspace ban'],
      posReasoning: 'Growing air travel demand improves load factors and yield pricing. Route expansion and fleet investment signal airline confidence in sustained passenger volume growth.',
      negReasoning: 'Aviation disruptions reduce passenger revenue and increase operational costs. Safety incidents trigger regulatory scrutiny and temporary grounding that impacts quarterly earnings.'
    },
    'Agriculture': {
      positive: ['bumper crop', 'agri subsidy', 'farm reform', 'monsoon normal', 'food export', 'harvest', 'crop yield', 'agritech', 'fertilizer'],
      negative: ['drought', 'crop failure', 'pest attack', 'flood damage', 'farm distress', 'locust', 'poor monsoon', 'food shortage'],
      posReasoning: 'Favorable agricultural conditions improve crop yields and farm income, boosting demand for agri-inputs and rural consumer goods. This has cascading positive effects on the rural economy.',
      negReasoning: 'Agricultural stress reduces farm output and increases food prices, squeezing margins for food processors and reducing rural spending power. Investors avoid agri-dependent stocks during uncertainty.'
    },
    'Pharmaceuticals': {
      positive: ['drug approval', 'fda', 'clinical trial success', 'pharma deal', 'generic drug', 'patent', 'biotech', 'vaccine rollout', 'drug discovery', 'pharma merger'],
      negative: ['drug recall', 'side effect', 'clinical trial fail', 'pharma scandal', 'patent expiry', 'price cap', 'drug ban', 'adverse reaction'],
      posReasoning: 'New drug approvals and successful clinical trials expand revenue pipelines. Investors position early expecting blockbuster drug sales and market exclusivity.',
      negReasoning: 'Drug failures and recalls destroy years of R&D investment. Pharmaceutical stocks face sharp selloffs as investors reassess the drug pipeline value.'
    },
    'Defense & Aerospace': {
      positive: ['defense contract', 'military spend', 'arms deal', 'space launch', 'defense budget', 'missile', 'fighter jet', 'satellite', 'isro', 'drdo'],
      negative: ['defense cut', 'arms embargo', 'satellite fail', 'launch failure', 'peace deal', 'disarmament', 'defense scam'],
      posReasoning: 'Increased defense spending guarantees long-term government contracts. Aerospace firms benefit from technological sovereignty initiatives and export orders.',
      negReasoning: 'Defense budget cuts and failed programs reduce order visibility. Investors reduce positions on lower revenue certainty and program cancellation risks.'
    },
    'Mining & Metals': {
      positive: ['gold price', 'metal rally', 'mining boom', 'iron ore', 'steel demand', 'copper', 'lithium', 'rare earth', 'commodity surge'],
      negative: ['mine collapse', 'metal crash', 'commodity slump', 'mining ban', 'environmental fine', 'ore shortage', 'steel dumping'],
      posReasoning: 'Rising commodity prices directly improve mining company margins. Increasing industrial demand for metals drives volume growth and pricing power.',
      negReasoning: 'Falling commodity prices squeeze mining margins and reduce project viability. Environmental incidents create regulatory and legal liability risks.'
    },
    'Logistics & Transport': {
      positive: ['logistics boom', 'shipping surge', 'port expansion', 'railway', 'freight demand', 'supply chain improve', 'warehouse', 'last mile'],
      negative: ['port strike', 'shipping delay', 'fuel cost', 'truck strike', 'logistics disruption', 'rail accident', 'container shortage'],
      posReasoning: 'Growing trade volumes and infrastructure investment boost logistics revenue. E-commerce growth drives last-mile delivery demand and warehouse expansion.',
      negReasoning: 'Transport disruptions increase delivery costs and reduce service reliability. Rising fuel costs compress margins across the logistics value chain.'
    },
    'E-Commerce & Retail': {
      positive: ['online sale', 'e-commerce boom', 'digital payment', 'shopping festival', 'retail growth', 'marketplace', 'quick commerce', 'subscription'],
      negative: ['e-commerce ban', 'fake product', 'delivery fail', 'retail shutdown', 'return fraud', 'platform outage', 'data leak'],
      posReasoning: 'Strong e-commerce growth expands gross merchandise value and customer acquisition. Digital payment adoption reduces transaction costs and improves unit economics.',
      negReasoning: 'E-commerce setbacks erode consumer trust and increase customer acquisition costs. Platform failures result in lost sales and brand damage.'
    },
    'Media & Entertainment': {
      positive: ['box office', 'streaming growth', 'content deal', 'media merger', 'ad revenue', 'ott platform', 'viral', 'blockbuster'],
      negative: ['piracy', 'censorship', 'content ban', 'ad boycott', 'viewership drop', 'media scandal', 'copyright'],
      posReasoning: 'Content hits and streaming subscriber growth drive recurring revenue. Media mergers create synergies in content production and distribution.',
      negReasoning: 'Content controversies and piracy reduce monetization potential. Advertiser pullbacks directly impact the primary revenue stream for media companies.'
    },
  };

  // General sentiment keywords
  const positiveWords = ['surge', 'boom', 'rise', 'grow', 'profit', 'gain', 'up', 'rally', 'soar', 'record high', 'breakthrough', 'approve', 'subsid', 'boost', 'expand'];
  const negativeWords = ['crash', 'fall', 'drop', 'decline', 'loss', 'crisis', 'fail', 'scandal', 'ban', 'penalty', 'fine', 'layoff', 'cut', 'slash', 'plunge', 'tank'];

  for (const industry of availableIndustries) {
    const keywords = keywordMap[industry];
    if (!keywords) continue;

    let matched = false;
    let sentiment = 'neutral';
    let reasoning = '';

    for (const word of keywords.positive) {
      if (lower.includes(word)) {
        matched = true;
        sentiment = 'positive';
        reasoning = keywords.posReasoning;
        break;
      }
    }

    if (!matched) {
      for (const word of keywords.negative) {
        if (lower.includes(word)) {
          matched = true;
          sentiment = 'negative';
          reasoning = keywords.negReasoning;
          break;
        }
      }
    }

    if (matched) {
      let matchCount = 0;
      const allWords = [...keywords.positive, ...keywords.negative];
      for (const w of allWords) {
        if (lower.includes(w)) matchCount++;
      }

      let strength = 'mild';
      if (matchCount >= 3) strength = 'strong';
      else if (matchCount >= 2) strength = 'moderate';

      impacts.push({ industry, sentiment, strength, reasoning });
    }
  }

  // If no specific industry matched, check general sentiment
  if (impacts.length === 0) {
    let generalSentiment = 'neutral';
    for (const w of positiveWords) {
      if (lower.includes(w)) { generalSentiment = 'positive'; break; }
    }
    if (generalSentiment === 'neutral') {
      for (const w of negativeWords) {
        if (lower.includes(w)) { generalSentiment = 'negative'; break; }
      }
    }

    if (generalSentiment !== 'neutral' && availableIndustries.length > 0) {
      const affected = availableIndustries.slice(0, 2);
      affected.forEach(ind => {
        impacts.push({
          industry: ind,
          sentiment: generalSentiment,
          strength: 'mild',
          reasoning: `General market sentiment suggests a ${generalSentiment} impact on this sector based on broad economic signals in the headline.`
        });
      });
    }
  }

  const smartAction = impacts.length > 0
    ? `Based on this news, a smart investor would ${impacts.some(i => i.sentiment === 'positive') ? 'increase positions in ' + impacts.filter(i => i.sentiment === 'positive').map(i => i.industry).join(', ') : ''}${impacts.some(i => i.sentiment === 'negative') ? (impacts.some(i => i.sentiment === 'positive') ? ' and ' : '') + 'reduce exposure to ' + impacts.filter(i => i.sentiment === 'negative').map(i => i.industry).join(', ') : ''}. This is a ${impacts[0].strength} impact event — position sizing should be calibrated accordingly.`
    : 'No significant action needed — this headline does not clearly impact any specific industry in the simulation.';

  return {
    impacts,
    summary: impacts.length > 0
      ? `Fallback analysis: ${impacts.map(i => `${i.industry} (${i.sentiment}/${i.strength})`).join(', ')}`
      : 'No significant industry impact detected from this headline.',
    smartInvestorAction: smartAction
  };
}

/**
 * Generate news headline suggestions based on selected stocks and desired impact.
 */
async function generateNewsSuggestions(stocks, sentiment, strength) {
  const anthropic = getClient();

  const stockInfo = stocks.map(s =>
    `${s.ticker} (${s.name}) — ${s.industry}${s.description ? ': ' + s.description : ''}`
  ).join('\n');

  if (anthropic) {
    try {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{
          role: 'user',
          content: `Generate 5 realistic news headlines that would cause a ${sentiment} ${strength} impact on these stocks:

${stockInfo}

Rules:
- Headlines must be realistic and could appear in a financial newspaper
- Each headline should clearly affect the listed companies/industries
- Impact should be ${strength} (${strength === 'mild' ? '1-3%' : strength === 'moderate' ? '3-6%' : '7-12%'} price movement)
- Sentiment: ${sentiment}
- Vary the types: government policy, market event, company-specific, global event, regulatory

Respond ONLY with JSON: {"headlines": ["headline1", "headline2", ...]}` 
        }]
      });
      const text = response.content[0].text.trim();
      const match = text.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
    } catch (e) {
      console.error('Claude suggestion error:', e.message);
    }
  }

  // Fallback: generate from templates
  return fallbackSuggestions(stocks, sentiment, strength);
}

function fallbackSuggestions(stocks, sentiment, strength) {
  const templates = {
    positive: {
      mild: [
        '{industry} sector shows steady growth as quarterly reports exceed expectations',
        'Government announces minor tax incentives for {industry} companies',
        '{company} ({ticker}) reports modest increase in market share',
        'Analysts upgrade {industry} sector outlook from neutral to cautiously optimistic',
        'New trade agreement expected to mildly benefit {industry} exporters'
      ],
      moderate: [
        'Major infrastructure investment plan to boost {industry} sector significantly',
        '{company} ({ticker}) secures landmark deal worth billions in new contracts',
        'Regulatory reforms create favorable conditions for {industry} expansion',
        'Foreign institutional investors increase stakes in {industry} stocks',
        'Government announces subsidy package targeting {industry} growth'
      ],
      strong: [
        'Breakthrough innovation in {industry} set to disrupt global markets',
        '{company} ({ticker}) announces game-changing merger with industry giant',
        'Government unveils massive stimulus package with {industry} as primary beneficiary',
        'Global demand for {industry} products surges to record highs',
        'Central bank policy shift creates unprecedented tailwinds for {industry}'
      ]
    },
    negative: {
      mild: [
        'Minor regulatory changes create short-term uncertainty for {industry}',
        '{company} ({ticker}) faces temporary supply chain disruptions',
        'Slight increase in input costs may pressure {industry} margins',
        'Industry analysts express caution over {industry} valuation levels',
        'Global slowdown concerns weigh modestly on {industry} outlook'
      ],
      moderate: [
        'New regulations impose significant compliance costs on {industry} firms',
        '{company} ({ticker}) faces investigation over business practices',
        'Trade tensions escalate with direct impact on {industry} supply chains',
        'Key {industry} raw material prices spike on supply shortage',
        'Government announces policy reversal affecting {industry} subsidies'
      ],
      strong: [
        'Major scandal rocks {industry} sector as fraud allegations emerge',
        '{company} ({ticker}) faces massive regulatory penalty and license review',
        'Government imposes emergency restrictions on {industry} operations',
        'Global crisis creates existential threat to {industry} business model',
        'Central bank intervention triggers severe liquidity crunch in {industry}'
      ]
    }
  };

  const pool = templates[sentiment]?.[strength] || templates.positive.moderate;
  const headlines = pool.map(t => {
    const stock = stocks[Math.floor(Math.random() * stocks.length)];
    return t
      .replace('{industry}', stock.industry)
      .replace('{company}', stock.name)
      .replace('{ticker}', stock.ticker);
  });

  return { headlines };
}

module.exports = { analyzeHeadline, generateNewsSuggestions };
