const { GoogleGenerativeAI } = require('@google/generative-ai');

// ============================================================
// AI Provider Setup — Gemini (primary) → Claude (fallback) → Keywords (final)
// ============================================================

let geminiClient = null;
let anthropicClient = null;

function getGeminiClient() {
  if (!geminiClient && process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'your_gemini_api_key_here') {
    geminiClient = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }
  return geminiClient;
}

function getAnthropicClient() {
  if (!anthropicClient && process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'your_anthropic_api_key_here') {
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    } catch (e) {
      // @anthropic-ai/sdk not installed — skip
    }
  }
  return anthropicClient;
}

// ============================================================
// Custom Financial Analyst System Prompt
// This is the "Custom GPT" personality and rules
// ============================================================

const SYSTEM_PROMPT = `You are the **Stock Market Simulator — Custom Financial Analyst AI**.

You are an elite-level financial analyst embedded inside a real-time stock market simulation platform used by university students to learn investing. Your job is to analyze news headlines and determine their realistic impact on the stocks and industries currently active in the simulation.

## YOUR CORE RULES

### 1. CAUSAL LOGIC IS MANDATORY
You must trace a clear, realistic economic chain of events from the news headline to the price impact. Never guess randomly. Think like a real Wall Street analyst:
- "Rising oil prices" → increases input costs for airlines → negative for Aviation
- "Government announces solar subsidies" → reduces costs for solar companies → positive for Energy
- "Data breach at major tech firm" → erodes consumer trust → negative for Technology

### 2. USE STOCK DESCRIPTIONS
Each stock has a description explaining what the company does. USE IT. If a headline says "New agricultural drone regulations", and one of the stocks is described as "Agricultural drone manufacturer", that stock should be strongly affected — not just the generic "Agriculture" industry.

### 3. STRENGTH CALIBRATION
- "mild" = routine news, 1–3% price movement. Example: quarterly earnings slightly beat expectations
- "moderate" = significant event, 3–6% price movement. Example: new government policy affecting the sector
- "strong" = major event, 7–12% price movement. Example: massive scandal, breakthrough innovation, emergency regulation

### 4. BE SELECTIVE
Only include industries and stocks that are genuinely affected. If a headline is vague or doesn't clearly impact any specific industry, return an EMPTY impacts array. Never force impacts where none logically exist.

### 5. SMART INVESTOR ACTION
Your "smartInvestorAction" must be specific and educational. Tell the student exactly which industries to buy, sell, or hold — and WHY. This is a teaching tool.

### 6. OUTPUT FORMAT
You MUST respond with ONLY valid JSON — no markdown, no explanation, no code fences. Just the raw JSON object.`;

// ============================================================
// Build the user prompt with full stock context
// ============================================================

function buildAnalysisPrompt(headline, availableIndustries, stockContext) {
  let stockInfo = '';
  if (stockContext && stockContext.length > 0) {
    stockInfo = '\n\n=== STOCKS IN THIS SIMULATION ===\n' + stockContext.map(s =>
      `• ${s.ticker} (${s.name}) — Industry: ${s.industry}${s.description ? `\n  Description: ${s.description}` : ''}`
    ).join('\n');
  }

  return `Analyze this news headline and determine its impact on the stock market simulation.

=== AVAILABLE INDUSTRIES ===
${availableIndustries.join(', ')}
${stockInfo}

=== NEWS HEADLINE ===
"${headline}"

Respond with ONLY this JSON structure:
{
  "impacts": [
    {
      "industry": "IndustryName",
      "sentiment": "positive|negative|neutral",
      "strength": "mild|moderate|strong",
      "reasoning": "2-4 sentences explaining the causal chain from news to price impact. Explain real-world market logic and what a smart investor would notice."
    }
  ],
  "summary": "One sentence summarizing the overall market impact",
  "smartInvestorAction": "2-3 sentences of specific, actionable advice: which industries to buy, sell, or hold and why"
}`;
}

function buildSuggestionPrompt(stocks, sentiment, strength) {
  const stockInfo = stocks.map(s =>
    `• ${s.ticker} (${s.name}) — ${s.industry}${s.description ? ': ' + s.description : ''}`
  ).join('\n');

  return `Generate 5 realistic financial news headlines that would cause a ${sentiment} ${strength} impact on these stocks:

${stockInfo}

Rules:
- Headlines must be realistic and could appear in a financial newspaper like The Economic Times or Bloomberg
- Each headline should clearly affect the listed companies/industries
- Impact should be ${strength} (${strength === 'mild' ? '1-3%' : strength === 'moderate' ? '3-6%' : '7-12%'} price movement)
- Sentiment: ${sentiment}
- Vary the types: government policy, market event, company-specific, global event, regulatory action
- Make headlines specific and detailed, not generic

Respond with ONLY this JSON: {"headlines": ["headline1", "headline2", "headline3", "headline4", "headline5"]}`;
}

// ============================================================
// Gemini API Calls
// ============================================================

async function geminiAnalyze(headline, availableIndustries, stockContext) {
  const genAI = getGeminiClient();
  if (!genAI) return null;

  try {
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: SYSTEM_PROMPT,
      generationConfig: {
        temperature: 0.3,        // Low temperature for consistent, structured output
        maxOutputTokens: 2000,
        responseMimeType: 'application/json'  // Force JSON output
      }
    });

    const prompt = buildAnalysisPrompt(headline, availableIndustries, stockContext);
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();

    // Parse the JSON response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      console.log('✅ Gemini analysis complete:', parsed.summary);
      return parsed;
    }
    throw new Error('No valid JSON in Gemini response');
  } catch (error) {
    console.error('❌ Gemini analysis error:', error.message);
    return null;
  }
}

async function geminiSuggest(stocks, sentiment, strength) {
  const genAI = getGeminiClient();
  if (!genAI) return null;

  try {
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: SYSTEM_PROMPT,
      generationConfig: {
        temperature: 0.8,        // Higher temperature for creative headline generation
        maxOutputTokens: 1500,
        responseMimeType: 'application/json'
      }
    });

    const prompt = buildSuggestionPrompt(stocks, sentiment, strength);
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      console.log('✅ Gemini generated', parsed.headlines?.length || 0, 'headline suggestions');
      return parsed;
    }
    throw new Error('No valid JSON in Gemini suggestion response');
  } catch (error) {
    console.error('❌ Gemini suggestion error:', error.message);
    return null;
  }
}

// ============================================================
// Claude API Calls (Fallback)
// ============================================================

async function claudeAnalyze(headline, availableIndustries, stockContext) {
  const anthropic = getAnthropicClient();
  if (!anthropic) return null;

  let stockInfo = '';
  if (stockContext && stockContext.length > 0) {
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
        content: `${SYSTEM_PROMPT}\n\n${buildAnalysisPrompt(headline, availableIndustries, stockContext)}`
      }]
    });

    const text = response.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      console.log('✅ Claude analysis complete:', parsed.summary);
      return parsed;
    }
    throw new Error('No valid JSON in Claude response');
  } catch (error) {
    console.error('❌ Claude analysis error:', error.message);
    return null;
  }
}

async function claudeSuggest(stocks, sentiment, strength) {
  const anthropic = getAnthropicClient();
  if (!anthropic) return null;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: buildSuggestionPrompt(stocks, sentiment, strength)
      }]
    });
    const text = response.content[0].text.trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch (e) {
    console.error('❌ Claude suggestion error:', e.message);
  }
  return null;
}

// ============================================================
// Main Entry Points — Cascading: Gemini → Claude → Keywords
// ============================================================

/**
 * Analyze a news headline. Tries Gemini first, then Claude, then keyword fallback.
 */
async function analyzeHeadline(headline, availableIndustries, stockContext = []) {
  // 1. Try Gemini (primary)
  const geminiResult = await geminiAnalyze(headline, availableIndustries, stockContext);
  if (geminiResult) return geminiResult;

  // 2. Try Claude (secondary)
  const claudeResult = await claudeAnalyze(headline, availableIndustries, stockContext);
  if (claudeResult) return claudeResult;

  // 3. Keyword fallback (always available)
  console.warn('⚠️  No AI API keys configured — using keyword fallback analysis');
  return fallbackAnalysis(headline, availableIndustries);
}

/**
 * Generate news headline suggestions. Tries Gemini first, then Claude, then templates.
 */
async function generateNewsSuggestions(stocks, sentiment, strength) {
  // 1. Try Gemini
  const geminiResult = await geminiSuggest(stocks, sentiment, strength);
  if (geminiResult) return geminiResult;

  // 2. Try Claude
  const claudeResult = await claudeSuggest(stocks, sentiment, strength);
  if (claudeResult) return claudeResult;

  // 3. Template fallback
  console.warn('⚠️  No AI API keys configured — using template fallback suggestions');
  return fallbackSuggestions(stocks, sentiment, strength);
}

// ============================================================
// Keyword Fallback Analysis (no API needed)
// ============================================================

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
      posReasoning: 'Favorable agricultural conditions improve crop yields and farm income, boosting demand for agri-inputs and rural consumer goods.',
      negReasoning: 'Agricultural stress reduces farm output and increases food prices, squeezing margins for food processors and reducing rural spending power.'
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

// ============================================================
// Fallback News Suggestions (template-based)
// ============================================================

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

// ============================================================
// Startup Logging
// ============================================================

function logAIStatus() {
  const gemini = getGeminiClient();
  const claude = getAnthropicClient();

  if (gemini) {
    console.log('🤖 AI Engine: Gemini (primary) ✅');
  }
  if (claude) {
    console.log('🤖 AI Engine: Claude (fallback) ✅');
  }
  if (!gemini && !claude) {
    console.log('⚠️  AI Engine: No API keys configured — using keyword fallback only');
  }
}

module.exports = { analyzeHeadline, generateNewsSuggestions, logAIStatus };
