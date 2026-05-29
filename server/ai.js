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

function buildAnalysisPrompt(headline, availableIndustries, stockContext, intendedStrength) {
  let stockInfo = '';
  if (stockContext && stockContext.length > 0) {
    stockInfo = '\n\n=== STOCKS IN THIS SIMULATION ===\n' + stockContext.map(s =>
      `• ${s.ticker} (${s.name}) — Industry: ${s.industry}${s.description ? `\n  Description: ${s.description}` : ''}`
    ).join('\n');
  }

  let strengthConstraint = '';
  if (intendedStrength) {
    strengthConstraint = `\n\n=== STRENGTH CONSTRAINT ===\nThis headline was generated to have a "${intendedStrength}" impact level. You MUST classify the strength as "${intendedStrength}". Do NOT override this classification. The strength has already been calibrated.`;
  }

  return `Analyze this news headline and determine its impact on the stock market simulation.

=== AVAILABLE INDUSTRIES ===
${availableIndustries.join(', ')}
${stockInfo}
${strengthConstraint}

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

CRITICAL CALIBRATION RULES:
- Impact MUST be exactly "${strength}" — not higher, not lower
- ${strength === 'mild' ? 'MILD means routine, everyday news. Examples: "Quarterly results slightly beat expectations", "Minor policy tweak announced". These should cause only 1-3% price movement. Do NOT use dramatic words like "massive", "unprecedented", "crisis", "breakthrough".' : strength === 'moderate' ? 'MODERATE means notable but not extraordinary news. Examples: "Government announces new sector policy", "Major contract secured". These should cause 3-6% price movement. Do NOT use extreme words like "crisis", "collapse", "revolutionary", "game-changing".' : 'STRONG means major, market-shaking events. Examples: "Massive fraud scandal uncovered", "Government unveils transformative stimulus". These should cause 7-12% price movement. Use impactful, dramatic language.'}
- Sentiment: ${sentiment}
- Headlines must be realistic and could appear in The Economic Times or Bloomberg
- Vary the types: government policy, market event, company-specific, global event, regulatory action
- Make headlines specific and detailed, not generic

Respond with ONLY this JSON: {"headlines": ["headline1", "headline2", "headline3", "headline4", "headline5"]}`;
}

// ============================================================
// Gemini API Calls
// ============================================================

async function geminiAnalyze(headline, availableIndustries, stockContext, intendedStrength) {
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

    const prompt = buildAnalysisPrompt(headline, availableIndustries, stockContext, intendedStrength);
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

async function claudeAnalyze(headline, availableIndustries, stockContext, intendedStrength) {
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
        content: `${SYSTEM_PROMPT}\n\n${buildAnalysisPrompt(headline, availableIndustries, stockContext, intendedStrength)}`
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
async function analyzeHeadline(headline, availableIndustries, stockContext = [], intendedStrength = null) {
  try {
    let result = null;
    let isFallback = false;

    // 1. Try Gemini (primary)
    const geminiResult = await geminiAnalyze(headline, availableIndustries, stockContext, intendedStrength);
    if (geminiResult) {
      result = geminiResult;
    } else {
      // 2. Try Claude (secondary)
      const claudeResult = await claudeAnalyze(headline, availableIndustries, stockContext, intendedStrength);
      if (claudeResult) {
        result = claudeResult;
      } else {
        // 3. Keyword fallback (always available)
        console.warn('⚠️  No AI API keys configured — using keyword fallback analysis');
        result = fallbackAnalysis(headline, availableIndustries, stockContext, intendedStrength);
        isFallback = true;
      }
    }

    // Force all impacts to have the intended strength if it was specified
    if (result && intendedStrength) {
      if (result.impacts && Array.isArray(result.impacts)) {
        result.impacts.forEach(imp => {
          imp.strength = intendedStrength;
        });
      }
      // Also update summary if it was generated by fallbackAnalysis or contains the old strength
      if (result.summary) {
        result.summary = result.summary.replace(
          /(\w+) \((\w+)\/(\w+)\)/g,
          (match, ind, sent, str) => `${ind} (${sent}/${intendedStrength})`
        );
      }
    }

    if (result) {
      result.isFallback = isFallback;
    }

    return result;
  } catch (error) {
    console.error('❌ Error in analyzeHeadline, using fallbackAnalysis:', error.message);
    try {
      const result = fallbackAnalysis(headline, availableIndustries, stockContext, intendedStrength);
      result.isFallback = true;
      return result;
    } catch (innerError) {
      console.error('❌ Critical error in fallbackAnalysis:', innerError.message);
      return {
        impacts: [],
        summary: `Fallback (Error): ${headline.substring(0, 60)}`,
        smartInvestorAction: 'Market volatility expected. Calibrate risk accordingly.',
        isFallback: true
      };
    }
  }
}

/**
 * Generate news headline suggestions. Tries Gemini first, then Claude, then templates.
 */
async function generateNewsSuggestions(stocks, sentiment, strength) {
  try {
    // 1. Try Gemini
    const geminiResult = await geminiSuggest(stocks, sentiment, strength);
    if (geminiResult) {
      geminiResult.isFallback = false;
      return geminiResult;
    }

    // 2. Try Claude
    const claudeResult = await claudeSuggest(stocks, sentiment, strength);
    if (claudeResult) {
      claudeResult.isFallback = false;
      return claudeResult;
    }
  } catch (error) {
    console.error('❌ Error in generateNewsSuggestions AI path:', error.message);
  }

  // 3. Template fallback
  console.warn('⚠️  No AI API keys configured — using template fallback suggestions');
  const fallback = fallbackSuggestions(stocks, sentiment, strength);
  fallback.isFallback = true;
  return fallback;
}

// ============================================================
// Keyword Fallback Analysis
// ============================================================
function fallbackAnalysis(headline, availableIndustries, stockContext = [], intendedStrength = null) {
  const lower = headline.toLowerCase();
  const impacts = [];

  // 1. Analyze broader sentiment & strength with weighted scoring
  const posStrong = ['unprecedented', 'mega', 'stimulus', 'breakthrough', 'disrupt', 'landmark', 'revolutionary', 'game-changing', 'soar', 'skyrocket', 'blockbuster', 'surge', 'boom', 'record high', 'historic'];
  const posMedium = ['grow', 'profit', 'gain', 'up', 'rally', 'approve', 'subsid', 'boost', 'expand', 'success', 'pioneer', 'unlock', 'clear', 'acquisition', 'merge', 'incentive', 'lucrative', 'demand'];
  const posMild = ['steady', 'tweak', 'slight', 'modest', 'constructive', 'stable', 'minor positive'];

  const negStrong = ['catastrophic', 'crash', 'collapse', 'fraud', 'scandal', 'moratorium', 'emergency', 'plunge', 'tank', 'severe', 'hack', 'governance', 'moratorium', 'irregularities', 'strike', 'unprecedented penalty'];
  const negMedium = ['fall', 'drop', 'decline', 'loss', 'crisis', 'fail', 'ban', 'penalty', 'fine', 'layoff', 'cut', 'slash', 'hike', 'inflation', 'recession', 'breach', 'shortage', 'struggle', 'delay', 'audit', 'investigation', 'tension', 'disruption'];
  const negMild = ['minor', 'slowdown', 'flat', 'cautious', 'temporary', 'brief', 'transient', 'headwind', 'resistance', 'tick', 'pressure'];

  let positiveScore = 0;
  let negativeScore = 0;

  posStrong.forEach(w => { if (lower.includes(w)) positiveScore += 3; });
  posMedium.forEach(w => { if (lower.includes(w)) positiveScore += 2; });
  posMild.forEach(w => { if (lower.includes(w)) positiveScore += 1; });

  negStrong.forEach(w => { if (lower.includes(w)) negativeScore += 3; });
  negMedium.forEach(w => { if (lower.includes(w)) negativeScore += 2; });
  negMild.forEach(w => { if (lower.includes(w)) negativeScore += 1; });

  let sentiment = 'neutral';
  if (positiveScore > negativeScore) sentiment = 'positive';
  else if (negativeScore > positiveScore) sentiment = 'negative';

  // 2. Identify target companies/tickers or industries in the headline
  let matchedStocks = [];
  let matchedIndustries = new Set();

  const genericWords = new Set([
    'ltd', 'limited', 'corp', 'corporation', 'solutions', 'systems', 'group', 'technologies', 'services', 
    'industries', 'holdings', 'co', 'and', 'the', 'of', 'global', 'national', 'indian', 'international', 
    'first', 'new', 'advanced', 'apex', 'alpha', 'state', 'united', 'india', 'consultancy', 'energy', 'technology',
    'healthcare', 'finance', 'consumer', 'goods', 'manufacturing', 'real', 'estate', 'telecom', 'aviation', 'defense'
  ]);

  if (Array.isArray(stockContext) && stockContext.length > 0) {
    stockContext.forEach(stock => {
      const tickerLower = stock.ticker.toLowerCase();
      const tickerRegex = new RegExp(`\\b${tickerLower}\\b`, 'i');

      // Ticker match is the strongest signal
      if (tickerRegex.test(lower)) {
        matchedStocks.push(stock);
        matchedIndustries.add(stock.industry);
        return;
      }

      // Cleaned company name match
      const fullNameClean = stock.name.toLowerCase()
        .replace(/limited|ltd|corp|corporation|co|inc|incorporated|group/g, '')
        .trim();
      
      if (fullNameClean.length > 3 && lower.includes(fullNameClean)) {
        matchedStocks.push(stock);
        matchedIndustries.add(stock.industry);
        return;
      }

      // Smart word matching: extract words from company name, filter generic words, and match
      const nameParts = stock.name.toLowerCase()
        .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, '')
        .split(/\s+/);
      
      const significantWords = nameParts.filter(word => word.length > 2 && !genericWords.has(word));
      
      if (significantWords.length > 0) {
        const longestWord = significantWords.reduce((a, b) => a.length > b.length ? a : b);
        const wordRegex = new RegExp(`\\b${longestWord}\\b`, 'i');
        
        if (wordRegex.test(lower)) {
          matchedStocks.push(stock);
          matchedIndustries.add(stock.industry);
        }
      }
    });
  }

  // If no direct company matched, match industries via industry keywords
  if (matchedIndustries.size === 0) {
    availableIndustries.forEach(ind => {
      const indKeywords = {
        'Energy': ['solar', 'wind', 'renew', 'oil', 'gas', 'power', 'coal', 'refine', 'petro', 'green energy', 'clean energy', 'electricity', 'grid', 'hydro', 'nuclear'],
        'Technology': ['tech', 'ai', 'artificial intelligence', 'semiconductor', 'chip', 'software', 'cloud', 'blockchain', 'quantum', 'digital', 'cyber', 'data', 'computer', 'it services', 'saas', 'iot'],
        'Healthcare': ['health', 'vaccine', 'drug', 'clinical', 'medical', 'pharma', 'cure', 'biotech', 'hospital', 'pandemic', 'outbreak', 'fda', 'patent', 'trial'],
        'Finance': ['bank', 'finance', 'interest', 'rate', 'credit', 'loan', 'nifty', 'sensex', 'market', 'stock', 'ipo', 'funding', 'capital', 'rbi', 'investment', 'monetary', 'treasury'],
        'Consumer Goods': ['retail', 'consumer', 'spend', 'fmcg', 'brand', 'shop', 'sale', 'holiday', 'apparel', 'food', 'beverage', 'e-commerce', 'online sale', 'delivery'],
        'Manufacturing': ['manufactur', 'factory', 'industrial', 'production', 'assembly', 'make in india', 'infrastructure', 'steel', 'metal', 'ore', 'commodity'],
        'Real Estate': ['housing', 'property', 'real estate', 'realty', 'construction', 'mortgage', 'building'],
        'Telecommunications': ['telecom', '5g', 'spectrum', 'network', 'broadband', 'mobile', 'operator', 'subscriber'],
        'Automotive': ['auto', 'car', 'vehicle', 'ev', 'electric', 'autonomous', 'drive', 'engine'],
        'Aviation': ['airline', 'flight', 'aviation', 'airport', 'jet', 'air travel'],
        'Agriculture': ['crop', 'farm', 'agri', 'harvest', 'monsoon', 'fertilizer', 'drought'],
        'Pharmaceuticals': ['pharmaceutical', 'drug', 'fda', 'clinical', 'vaccine', 'patent', 'trial'],
        'Defense & Aerospace': ['defense', 'military', 'aerospace', 'space', 'satellite', 'isro', 'drdo', 'missile', 'fighter'],
        'Mining & Metals': ['mining', 'gold', 'metal', 'copper', 'lithium', 'steel', 'ore', 'commodity'],
        'Logistics & Transport': ['shipping', 'logistics', 'port', 'freight', 'cargo', 'rail', 'truck', 'container'],
        'E-Commerce & Retail': ['e-commerce', 'online sale', 'payment', 'quick commerce', 'marketplace', 'delivery'],
        'Media & Entertainment': ['media', 'entertainment', 'movie', 'ott', 'streaming', 'music', 'box office']
      };

      const keywords = indKeywords[ind] || [ind.toLowerCase()];
      const matchedKeyword = keywords.find(kw => {
        const regex = new RegExp(`\\b${kw}\\b|${kw}`, 'i');
        return regex.test(lower);
      });
      if (matchedKeyword) {
        matchedIndustries.add(ind);
      }
    });
  }

  // If still no industries matched, default to the first available industries
  if (matchedIndustries.size === 0 && availableIndustries.length > 0) {
    matchedIndustries.add(availableIndustries[0]);
    if (availableIndustries.length > 1) {
      matchedIndustries.add(availableIndustries[1]);
    }
  }

  // 3. Determine Strength
  let strength = intendedStrength;
  if (!strength) {
    const totalScore = positiveScore + negativeScore;
    if (totalScore >= 5) {
      strength = 'strong';
    } else if (totalScore >= 2) {
      strength = 'moderate';
    } else {
      strength = 'mild';
    }
  }

  // 4. Generate Causal Analyst Reasoning
  const getIndustryReasoning = (ind, sent, str, stockName = null) => {
    const subject = stockName ? `${stockName} (${stockName.split(' ')[0]})` : `the ${ind} sector`;
    
    const templates = {
      Energy: {
        positive: {
          strong: `A major structural catalyst is driving aggressive investment in ${subject}. Analysts anticipate substantial margin expansion and cash flow growth as new capabilities scale. This creates a high-conviction backdrop for long-term equity appreciation.`,
          moderate: `Favorable regulatory developments or volume shifts are constructively impacting ${subject}. Reduced cost structures or rising capacity utilization are expected to expand operating margins over the next few quarters.`,
          mild: `Minor constructive trends are providing a stable tailwind for ${subject}, slightly improving short-term revenue visibility without significantly changing long-term valuation multiples.`
        },
        negative: {
          strong: `Severe supply chain disruptions or regulatory penalties present an immediate risk to ${subject}. Rising risk premiums and expected contraction in EBITDA margins are prompting defensive equity de-rating.`,
          moderate: `Increasing input costs and environmental compliance overheads are squeezing operating margins across ${subject}. Near-term profit visibility is clouded, leading to temporary multiple compression.`,
          mild: `Transient operational bottlenecks or minor regulatory changes are creating minor friction for ${subject}, although the core long-term investment thesis remains intact.`
        }
      },
      Technology: {
        positive: {
          strong: `A game-changing technological breakthrough positions ${subject} at the forefront of market expansion. High-margin software deployments and strong competitive moats are driving major upward earnings-per-share (EPS) revisions.`,
          moderate: `Growing enterprise demand and strong order book visibility are constructively positioning ${subject}. Accelerating cloud and digital adoption supports steady operating leverage and valuation re-rating.`,
          mild: `Steady software contract renewals provide stable recurring revenues for ${subject}, supporting neutral-to-positive near-term stock consolidation.`
        },
        negative: {
          strong: `A severe security compromise or significant technological obsolescence poses a critical threat to ${subject}. Analysts expect substantial customer churn, litigation liabilities, and deep multiple compression.`,
          moderate: `Macroeconomic slowdowns are prompting clients to scale back IT spending, directly impacting near-term revenue pipelines for ${subject}. Rising talent acquisition and wage costs further compress operating margins.`,
          mild: `A temporary delay in product launches or minor client attrition creates transient headwinds for ${subject}, though long-term growth trends are expected to recover.`
        }
      },
      Finance: {
        positive: {
          strong: `A highly supportive monetary pivot and expanding Net Interest Margins (NIMs) are driving a powerful capital cycle for ${subject}. Strong balance sheets and low non-performing assets (NPAs) provide an exceptional runway for credit expansion.`,
          moderate: `Steady credit growth and constructive capital market activity are boosting fee-based incomes for ${subject}. Stable liquidity profiles support robust return-on-equity (ROE) metrics.`,
          mild: `Minor positive shifts in treasury yields or deposit growth provide a marginal tailwind for ${subject}, maintaining steady near-term trading stability.`
        },
        negative: {
          strong: `Severe systemic risks, sudden credit defaults, or restrictive regulatory crackdowns present a catastrophic scenario for ${subject}. Risk-off sentiment is triggering rapid equity liquidation as asset qualities deteriorate.`,
          moderate: `Rising provisioning requirements and narrowing net interest margins are exerting notable pressure on ${subject}'s earnings quality. Higher cost of funds limits credit expansion capacity.`,
          mild: `Minor credit fluctuations or transient compliance overheads create slight near-term margin pressure for ${subject}, though broader solvency metrics remain healthy.`
        }
      },
      Consumer: {
        positive: {
          strong: `A powerful surge in consumer spending power and holiday demand triggers exceptional volume growth for ${subject}. Pricing power allows full pass-through of raw materials costs, driving record high margins.`,
          moderate: `Constructive retail demand patterns and solid brand equity support steady volume expansion for ${subject}. Inventory optimizations are improving cash conversion cycles.`,
          mild: `Slight improvements in local consumer footfalls provide minor revenue support for ${subject}, leading to range-bound price action with a positive bias.`
        },
        negative: {
          strong: `A severe contraction in real disposable incomes or an acute raw material supply crisis hits ${subject} hard. Rapidly escalating input inflation combined with demand price-elasticity is severely compressing margins.`,
          moderate: `Subdued consumer sentiment and rising promotional expenses are impacting the near-term profitability of ${subject}. Margins are compressed as operators compete aggressively on pricing.`,
          mild: `Slight inventory build-ups or minor logistics delays introduce brief operating friction for ${subject}, though underlying brand demand remains stable.`
        }
      }
    };

    const sectorKey = templates[ind] ? ind : 'Energy'; 
    const sentimentKey = sent === 'neutral' ? 'positive' : sent; 
    const strengthKey = sent === 'neutral' ? 'mild' : str;

    const mainText = templates[sectorKey][sentimentKey][strengthKey];
    return `Causal Chain: The headline news regarding '${headline}' acts as a major catalyst for ${subject}. ${mainText} Market analysts expect this development to trigger a ${sent === 'positive' ? 'constructive re-rating' : sent === 'negative' ? 'risk-off de-rating' : 'neutral, range-bound performance'} in near-term trading.`;
  };

  // 5. Construct Impacts
  matchedIndustries.forEach(ind => {
    const finalSent = sentiment;
    const stock = matchedStocks.find(s => s.industry === ind);
    const stockName = stock ? `${stock.name}` : null;
    const reasoning = getIndustryReasoning(ind, finalSent, strength, stockName);

    impacts.push({
      industry: ind,
      sentiment: finalSent,
      strength,
      reasoning
    });
  });

  // 6. Build overall smart investor action advice
  const posInds = impacts.filter(i => i.sentiment === 'positive').map(i => i.industry);
  const negInds = impacts.filter(i => i.sentiment === 'negative').map(i => i.industry);
  
  let smartAction = '';
  if (posInds.length > 0 && negInds.length > 0) {
    smartAction = `Portfolio optimization: Dynamically allocate capital into the surging ${posInds.join(', ')} sectors, while systematically trimming exposure or hedging downside risks in ${negInds.join(', ')}. Set tight stop-losses given the ${strength} volatility index.`;
  } else if (posInds.length > 0) {
    smartAction = `Capital allocation note: Increase portfolio exposure to the ${posInds.join(', ')} sector immediately. Institutional buying is expected to drive price discovery. This represents a clear ${strength} positive catalyst.`;
  } else if (negInds.length > 0) {
    smartAction = `De-risking alert: Swiftly reduce exposure to the vulnerable ${negInds.join(', ')} industries to mitigate drawdowns. Defensive capital rotation into safe-haven cash or gold is highly recommended during this ${strength} shock.`;
  } else {
    smartAction = `Tactical stance: Maintain neutral/cash-heavy allocations. The headline indicates general range-bound consolidation with no clear sector alpha catalysts. Capital preservation remains the priority.`;
  }

  // Build summary string
  let summary = '';
  if (impacts.length > 0) {
    summary = `Fallback Market Analysis: Headline triggers a ${sentiment.toUpperCase()} sentiment bias, impacting ${impacts.map(i => `${i.industry} (${i.sentiment}/${i.strength})`).join(', ')}.`;
  } else {
    summary = 'No actionable macroeconomic or industry-specific price catalysts detected in the headline.';
  }

  return {
    impacts,
    summary,
    smartInvestorAction: smartAction
  };
}

// ============================================================
// Fallback News Suggestions (template-based)
// ============================================================

function fallbackSuggestions(stocks, sentiment, strength) {
  const headlines = [];
  
  // A collection of specific realistic details to inject based on industry
  const details = {
    'Technology': {
      products: ['Quantum-Safe Encryption Core', 'Next-Gen Enterprise SaaS Platform', 'AI-Driven Cybersecurity Gateway', 'Automated Cloud Orchestration Suite', 'Llama-Based LLM Integration Framework'],
      actions: ['secures massive $500M multi-year cloud transformation contract', 'unveils breakthrough compiler that slashes AI model latency by 40%', 'launches global secure-edge computing network across 40 countries'],
      posThemes: ['AI-driven productivity gains', 'cloud migration acceleration', 'high-margin enterprise subscription growth'],
      negThemes: ['severe cybersecurity intrusion', 'prolonged enterprise software delivery delays', 'deteriorating tech consulting spends']
    },
    'Energy': {
      products: ['High-Efficiency Bifacial Solar Arrays', 'Grid-Scale Solid-State Battery Storage', 'Next-Gen Offshore Wind Turbines', 'Green Hydrogen Electrolyzers'],
      actions: ['wins landmark utility-scale solar hybrid project commission', 'partners with state grid to deploy automated power dispatch systems', 'successfully commissions 500MW renewable energy park ahead of schedule'],
      posThemes: ['surging clean energy tariffs', 'lucrative production-linked tax credits', 'accelerated coal-to-clean grid integration'],
      negThemes: ['severe turbine equipment failures', 'grid connectivity bottlenecks', 'unexpected solar panel import duty hikes']
    },
    'Finance': {
      products: ['AI-Enabled Automated Underwriting System', 'Cross-Border Real-Time Settlement Protocol', 'Premium Wealth Management API'],
      actions: ['reports record loan originations and expanding net interest margins', 'receives regulatory approval to launch institutional digital assets desk', 'wins major corporate mandate for multi-billion dollar debt restructuring'],
      posThemes: ['expanding credit growth cycles', 'declining non-performing assets (NPAs)', 'favorable central bank liquidity injections'],
      negThemes: ['unexpected capital adequacy requirement increases', 'rising bad loan provisioning', 'restrictive systemic credit tightening']
    },
    'Healthcare': {
      products: ['Targeted Oncological Immunotherapy', 'Next-Gen mRNA Vaccine Platform', 'AI-Powered Diagnostic Imaging Suite'],
      actions: ['receives accelerated FDA approval for flagship therapeutic drug', 'reports exceptionally positive Phase III clinical trial data', 'secures exclusive global licensing agreement with major distribution network'],
      posThemes: ['high-margin blockbuster drug launches', 'strong generic export volumes', 'supportive healthcare subsidy allocations'],
      negThemes: ['stringent clinical trial halts', 'unexpected patent litigation setbacks', 'regulatory compliance warning letters']
    },
    'Consumer Goods': {
      products: ['Premium Organic Beverages Line', 'Smart Connected Home Appliances', 'Eco-Friendly Personal Care Portfolio'],
      actions: ['unveils massive retail channel expansion across high-growth markets', 'reports blockbuster holiday sales beating all consensus estimates', 'signs exclusive distribution deal with leading e-commerce platforms'],
      posThemes: ['robust urban discretionary spending', 'premium product mix expansion', 'favorable raw material cost deflation'],
      negThemes: ['severe supply chain logistics bottlenecks', 'depressed rural consumption trends', 'surging packaging and freight costs']
    }
  };

  const defaultDetails = {
    products: ['Next-Generation Solutions Suite', 'Flagship Industry Platform', 'Core Proprietary Technology'],
    actions: ['secures lucrative multi-year corporate agreements', 'announces high-capacity facility expansions', 'receives positive institutional support'],
    posThemes: ['solid underlying demand gains', 'expanding operational efficiencies', 'favorable industry dynamics'],
    negThemes: ['unexpected regulatory compliance audits', 'rising operational raw materials costs', 'temporary macro headwinds']
  };

  // Positive Template patterns: {company}, {ticker}, {industry}, {product}, {action}, {posTheme}
  const posPatterns = {
    mild: [
      '{company} ({ticker}) reports steady volume growth in {industry} segment; margins hold firm',
      'Bloomberg reports modest pickup in market demand for {industry} services; constructive outlook ahead',
      '{company} ({ticker}) receives positive analyst feedback on its {product} rollout',
      'Government introduces minor tax incentives supporting domestic {industry} growth initiatives',
      '{company} ({ticker}) successfully completes pilot phase of new {product} with key client',
      'Steady institutional buying observed in leading {industry} equities during market consolidation',
      '{company} ({ticker}) optimizes local operations, driving incremental cost efficiencies'
    ],
    moderate: [
      '{company} ({ticker}) {action}',
      'Sweeping regulatory modifications expected to unlock significant capacity across the {industry} sector',
      '{company} ({ticker}) secures premium long-term licensing deal for its proprietary {product}',
      'FII inflows turn heavily constructive for {industry} leaders amid rising order book confidence',
      'Production-Linked Incentive (PLI) clearances trigger major capital expansion in the {industry} sector',
      '{company} ({ticker}) reports Q2 net profit surge of 15% YoY, beating analyst consensus forecasts',
      'Strategic corporate partnership set to accelerate {company} ({ticker})\'s presence in international markets'
    ],
    strong: [
      'Unprecedented breakthrough: {company} ({ticker}) {action} in major market disruption',
      'Cabinet clears massive multi-billion dollar strategic infrastructure and stimulus package targeting {industry}',
      '{company} ({ticker}) announces game-changing mega-merger with leading international peer',
      'Surging global market share and pricing power propel {company} ({ticker}) to record financial highs',
      'Systemic central bank monetary easing unleashes multi-year capital investment cycle for {industry}',
      '{company} ({ticker}) reports blockbuster earnings; EBITDA margins expand by an extraordinary 450 bps',
      'Historic regulatory clearance grants {company} ({ticker}) exclusive distribution rights for {product}'
    ]
  };

  const negPatterns = {
    mild: [
      'Minor supply chain friction creates transient headwinds for the {industry} sector',
      '{company} ({ticker}) reports temporary maintenance shutdown at local production unit',
      'Slight increase in raw material index costs likely to put short-term pressure on {industry} margins',
      'Analysts issue highly cautious near-term notes on premium {industry} equity valuations',
      '{company} ({ticker}) reports minor delay in the commercial launch of its new {product}',
      'Range-bound profit taking dampens near-term momentum for {industry} bluechips',
      '{company} ({ticker}) faces brief administrative review over operational licensing compliance'
    ],
    moderate: [
      '{company} ({ticker}) faces comprehensive forensic audit over corporate governance concerns',
      'Strict new compliance mandates impose notable operational overheads on {industry} operators',
      '{company} ({ticker}) reports Q2 earnings miss; margins compressed by rising WACC and wages',
      'Escalating regional trade tensions spark notable disruptions in {industry} supply networks',
      'Policy reversal: Cabinet scales back critical investment subsidies targeting {industry} development',
      '{company} ({ticker}) reports cancellation of a key customer contract, clouding near-term revenues',
      'Deteriorating macroeconomic indicators prompt institutional downgrades for {industry} sector leaders'
    ],
    strong: [
      'Severe accounting irregularities uncovered at {company} ({ticker}); regulatory investigation launched',
      '{company} ({ticker}) faces catastrophic multi-million dollar penalty and immediate licensing suspension',
      'Government issues emergency moratorium on high-emission or high-risk {industry} activities',
      'Severe credit crunch and borrowing constraints trigger multiple liquidity threats for {company} ({ticker})',
      'Global market crash: Sharp demand collapse sparks massive downward re-rating of the {industry} sector',
      '{company} ({ticker}) reports disastrous earnings; margins contract by a severe 600 bps YoY',
      'Catastrophic system failure and {negTheme} completely paralyze major operations at {company} ({ticker})'
    ]
  };
  
  const pool = (sentiment === 'positive' ? posPatterns[strength] : negPatterns[strength]) || posPatterns.moderate;
  const shuffledPool = [...pool].sort(() => Math.random() - 0.5);
  
  for (let i = 0; i < 5; i++) {
    const stock = stocks[Math.floor(Math.random() * stocks.length)];
    const ind = stock.industry;
    const indDetails = details[ind] || defaultDetails;
    
    const product = indDetails.products[Math.floor(Math.random() * indDetails.products.length)];
    const action = indDetails.actions[Math.floor(Math.random() * indDetails.actions.length)];
    const posTheme = indDetails.posThemes ? indDetails.posThemes[Math.floor(Math.random() * indDetails.posThemes.length)] : defaultDetails.posThemes;
    const negTheme = indDetails.negThemes ? indDetails.negThemes[Math.floor(Math.random() * indDetails.negThemes.length)] : defaultDetails.negThemes;
    
    let pattern = shuffledPool[i % shuffledPool.length];
    
    let headline = pattern
      .replace(/{company}/g, stock.name)
      .replace(/{ticker}/g, stock.ticker)
      .replace(/{industry}/g, stock.industry)
      .replace(/{product}/g, product)
      .replace(/{action}/g, action)
      .replace(/{posTheme}/g, posTheme)
      .replace(/{negTheme}/g, negTheme);
      
    headlines.push(headline);
  }
  
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
