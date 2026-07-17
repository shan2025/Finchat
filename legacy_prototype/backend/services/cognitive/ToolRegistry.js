// services/cognitive/ToolRegistry.js — Static metadata registry for all available tools
// No execution logic here — just name/description/schema for ContextBuilder and ToolManager

const TOOLS = {
  search: {
    name: 'search',
    description: 'Search the web for current information. Use this when you need up-to-date facts, news, or data that you do not already know.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' }
      },
      required: ['query']
    },
    outputSchema: {
      type: 'object',
      properties: {
        results: { type: 'array', description: 'Array of search result snippets' }
      }
    },
    cacheTTLSeconds: 300, // 5 minutes
    rateLimitPerMinute: 10
  },

  stocks: {
    name: 'stocks',
    description: 'Look up the current stock price and market data for a given ticker symbol. Use this when the user asks about stock prices, market performance, or financial ticker data.',
    inputSchema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Stock ticker symbol (e.g. TSLA, AAPL, GOOGL)' }
      },
      required: ['ticker']
    },
    outputSchema: {
      type: 'object',
      properties: {
        ticker: { type: 'string' },
        price: { type: 'number' },
        change: { type: 'number' },
        changePercent: { type: 'number' },
        currency: { type: 'string' }
      }
    },
    cacheTTLSeconds: 60, // 1 minute — stock data should be fresher
    rateLimitPerMinute: 15
  },

  paper: {
    name: 'paper',
    description: 'Search for scientific and technical research papers on arXiv. Use this when the user asks about academic research, scientific papers, studies, or frontier technology topics.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Research topic or paper keywords (e.g. "neural interfaces", "transformer architectures")' }
      },
      required: ['query']
    },
    outputSchema: {
      type: 'object',
      properties: {
        papers: { type: 'array', description: 'Array of paper objects with id, title, authors, summary, pdfUrl' }
      }
    },
    cacheTTLSeconds: 600, // 10 minutes — academic papers don't change fast
    rateLimitPerMinute: 8
  },

  resume: {
    name: 'resume',
    description: 'Analyze a resume or professional profile against a target role. Use this when the user shares their resume, skills, or asks for career fit analysis.',
    inputSchema: {
      type: 'object',
      properties: {
        resumeText: { type: 'string', description: 'The full resume or skills text to analyze' },
        targetRole: { type: 'string', description: 'Target job role (e.g. "Full Stack Engineer", "Data Scientist")' }
      },
      required: ['resumeText']
    },
    outputSchema: {
      type: 'object',
      properties: {
        matchScore: { type: 'number', description: 'Percentage match score 0-100' },
        matchingSkills: { type: 'array' },
        missingSkills: { type: 'array' },
        recommendations: { type: 'array' }
      }
    },
    cacheTTLSeconds: 0, // No caching — each resume is unique
    rateLimitPerMinute: 20
  },

  jobs: {
    name: 'jobs',
    description: 'Search REAL job listings for a role (analyst, data science, ML, AI, product manager, business analyst, etc.), optionally filtered by company and region. Returns direct application URLs — always cite them.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'Job title / role — e.g. "product analyst", "ai engineer intern", "data scientist"' },
        company: { type: 'string', description: 'Company name (optional) — e.g. "IBM", "Google"' },
        region: { type: 'string', description: 'Region / country (optional) — e.g. "India", "remote", "United States"' }
      },
      required: ['role']
    },
    outputSchema: {
      type: 'object',
      properties: {
        results: { type: 'array', description: 'Job listings with title, company, location, and application URL' }
      }
    },
    cacheTTLSeconds: 300,
    rateLimitPerMinute: 10
  },

  commodities: {
    name: 'commodities',
    description: 'Look up current prices for commodities like gold, silver, oil, natural gas, copper, coffee. Use this when the user asks about anything that is NOT a stock or crypto — precious metals, energy, agricultural commodities.',
    inputSchema: {
      type: 'object',
      properties: {
        commodity: { type: 'string', description: 'Commodity name — e.g. "gold", "silver", "oil", or a comma-separated list like "gold, silver"' }
      },
      required: ['commodity']
    },
    outputSchema: {
      type: 'object',
      properties: {
        results: { type: 'array', description: 'Array with commodity, price, change, currency, and source URL' }
      }
    },
    cacheTTLSeconds: 60,
    rateLimitPerMinute: 15
  },

  crypto: {
    name: 'crypto',
    description: 'Look up the current price, 24h change, and market cap of a cryptocurrency. Use this when the user asks about crypto prices, DeFi tokens, or digital asset performance.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Cryptocurrency symbol or name (e.g. "BTC", "ethereum", "SOL", "solana")' }
      },
      required: ['symbol']
    },
    outputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        name: { type: 'string' },
        priceUsd: { type: 'number' },
        change24h: { type: 'number' },
        marketCapUsd: { type: 'number' }
      }
    },
    cacheTTLSeconds: 90, // 1.5 minutes — crypto moves fast but not microsecond-level
    rateLimitPerMinute: 12
  }
};

/**
 * Get metadata for a registered tool by name.
 */
function getToolMeta(toolName) {
  return TOOLS[toolName] || null;
}

/**
 * List all registered tools (for injecting into system prompts).
 */
function listTools() {
  return Object.values(TOOLS).map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema
  }));
}

/**
 * Get all tool names.
 */
function getToolNames() {
  return Object.keys(TOOLS);
}

module.exports = { TOOLS, getToolMeta, listTools, getToolNames };
