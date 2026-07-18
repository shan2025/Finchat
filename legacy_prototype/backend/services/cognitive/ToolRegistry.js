// services/cognitive/ToolRegistry.js — Static metadata registry for all available tools
// No execution logic here — just name/description/schema for ContextBuilder and ToolManager

const TOOLS = {
  search: {
    name: 'search',
    web: true, // open-web tool — gated by the chat composer's WEB toggle
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

  fetch: {
    name: 'fetch',
    web: true,
    description: 'Fetch a specific URL and extract its readable text content, title, and links. Use this AFTER search/jobs/news gave you a URL and you need the actual page content. Input: {"url": "https://..."}',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The full URL to fetch' }
      },
      required: ['url']
    },
    outputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' }, title: { type: 'string' },
        text: { type: 'string', description: 'Clean readable page text' },
        links: { type: 'array' }
      }
    },
    cacheTTLSeconds: 300,
    rateLimitPerMinute: 10
  },

  crawl: {
    name: 'crawl',
    web: true,
    description: 'Crawl a website starting from a URL: fetches the page plus same-site linked pages (depth ≤ 2, max 10 pages, robots.txt respected). Use for research digests when one page is not enough. Input: {"url":"https://...","depth":1}',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Starting URL' },
        depth: { type: 'number', description: 'Link depth to follow (1 or 2, default 1)' },
        maxPages: { type: 'number', description: 'Page cap (max 10)' }
      },
      required: ['url']
    },
    outputSchema: {
      type: 'object',
      properties: {
        pages: { type: 'array', description: 'Crawled pages with url, title, excerpt' }
      }
    },
    cacheTTLSeconds: 600,
    rateLimitPerMinute: 3
  },

  news: {
    name: 'news',
    web: true,
    description: 'Get recent (last 48h) crypto, finance, and tech headlines from trusted RSS feeds (CoinDesk, Cointelegraph, CNBC, MIT Tech Review). Input a symbol or topic like "BTC", "solana", "AI"; optional category: crypto|markets|tech.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Symbol or topic to match, e.g. "BTC", "AI"' },
        category: { type: 'string', description: 'Optional: crypto | markets | tech' }
      },
      required: ['query']
    },
    outputSchema: {
      type: 'object',
      properties: {
        results: { type: 'array', description: 'Headlines with title, url, feed, publishedAt' }
      }
    },
    cacheTTLSeconds: 600,
    rateLimitPerMinute: 6
  },

  watchlist: {
    name: 'watchlist',
    description: 'Read or modify the user\'s market watchlist (crypto/stock/commodity symbols they track). Input: {"action":"list"} or {"action":"add","symbol":"BTC"} or {"action":"remove","symbol":"BTC"}. Use "list" before market briefs.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'list | add | remove' },
        symbol: { type: 'string', description: 'Symbol for add/remove, e.g. BTC, TSLA, gold' }
      },
      required: ['action']
    },
    outputSchema: {
      type: 'object',
      properties: {
        watchlist: { type: 'array', description: 'Current watchlist entries' }
      }
    },
    cacheTTLSeconds: 0, // stateful — never cache
    rateLimitPerMinute: 20
  },

  apply_draft: {
    name: 'apply_draft',
    description: 'Draft a tailored job application package (cover letter + fit analysis + checklist) for a specific job posting. DRAFT ONLY — never submits anything. Input: {"job":{"title":"...","company":"...","url":"...","description":"..."},"resumeText":"optional"}',
    inputSchema: {
      type: 'object',
      properties: {
        job: { type: 'object', description: 'The job posting (title, company, url, description)' },
        resumeText: { type: 'string', description: 'Candidate resume text (optional)' }
      },
      required: ['job']
    },
    outputSchema: {
      type: 'object',
      properties: {
        draft: { type: 'string', description: 'Markdown application package' }
      }
    },
    cacheTTLSeconds: 0, // every draft is unique
    rateLimitPerMinute: 6
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
 * Pass { allowWeb: false } to hide open-web tools (composer WEB toggle off).
 */
function listTools({ allowWeb = true } = {}) {
  return Object.values(TOOLS)
    .filter(t => allowWeb || !t.web)
    .map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      web: !!t.web
    }));
}

/**
 * Get all tool names.
 */
function getToolNames() {
  return Object.keys(TOOLS);
}

module.exports = { TOOLS, getToolMeta, listTools, getToolNames };
