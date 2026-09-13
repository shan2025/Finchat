// services/cognitive/ToolRegistry.js — Static metadata registry for all available tools
// No execution logic here — just name/description/schema for ContextBuilder and ToolManager

const TOOLS = {
  search: {
    name: 'search',
    web: true, // open-web tool — gated by the chat composer's WEB toggle
    description: 'Search the web for current information. Use this when you need up-to-date facts, news, or data that you do not already know. If the result has "searchUnavailable": true, the search tool itself is broken — report that outage to the user and never claim the subject was not found or does not exist. If the result has "degraded": true, the results came from a limited Wikipedia-only fallback — say so when you answer.',
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
    description: 'Look up stock price and market data for a ticker. Without "days" it returns the current price and daily change; with "days" (e.g. 30, 90, 365) it returns daily price history plus start/end price and % change for one ticker. Use for stock prices, performance, and comparisons.',
    inputSchema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Stock ticker symbol (e.g. TSLA, AAPL, GOOGL)' },
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of ticker symbols to look up in one call (e.g. ["AAPL", "TSLA"])'
        },
        days: { type: 'number', description: 'Optional: past days of daily history for a single ticker (e.g. 30, 90, 365). Omit for the current price.' }
      },
      required: []
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
    description: 'Store, score, and tailor the user\'s resume. Actions: {"action":"save","content":"<full resume text>"} keeps it on file so scheduled tasks and later tailoring can read it without the user pasting again; {"action":"get"} reads the stored copy; {"action":"analyze","targetRole":"Product Manager"} scores fit and lists missing skills; {"action":"tailor","job":{"title":"…","company":"…","description":"…"}} rewrites the stored resume for ONE specific posting and reports exactly what it changed and which gaps it could not honestly close. If resumeText is omitted, the stored resume is used. Whenever the user shares their resume text, save it first. Tailoring never overwrites the stored master and never invents experience.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'save | get | analyze | tailor (default analyze)' },
        content: { type: 'string', description: 'For save: the full resume text' },
        resumeText: { type: 'string', description: 'Resume text to score/tailor (omit to use the stored resume)' },
        targetRole: { type: 'string', description: 'Target job role (e.g. "Full Stack Engineer", "Product Manager")' },
        job: { type: 'object', description: 'For tailor: the posting (title, company, url, description)' }
      },
      required: []
    },
    outputSchema: {
      type: 'object',
      properties: {
        matchScore: { type: 'number', description: 'Percentage match score 0-100' },
        matchingSkills: { type: 'array' },
        missingSkills: { type: 'array' },
        recommendations: { type: 'array' },
        tailoredResume: { type: 'string', description: 'For tailor: the rewritten resume + change list + gaps' }
      }
    },
    cacheTTLSeconds: 0, // stateful and unique per call — never cache
    rateLimitPerMinute: 20
  },

  mission: {
    name: 'mission',
    description: 'Create and manage the user\'s STANDING TASKS — work you re-run on a schedule and deliver as a report. Use this WHENEVER the user asks for something recurring ("every day", "each morning", "weekly", "keep checking"): nothing else in the system remembers a promise made in chat. Actions: create (needs title, goal, cadence), list, update, pause, resume, delete, run_now — the last three take {"mission":"<title>"}. The "goal" is re-read by a future run with NOBODY watching, so write it standalone: the filters, which tools to use, and what the report must contain. Cadence: "daily"/"6h"/"1h"/"15m", a phrase like "every day at 7am", or a 5-field cron; clock times are read as IST unless "timezone" is given. New tasks start enabled and are assigned to YOU, so only create work you have the tools to do.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'list | create | update | pause | resume | delete | run_now' },
        title: { type: 'string', description: 'Short name for the task, e.g. "Daily PM job hunt"' },
        goal: { type: 'string', description: 'The full standing instructions the future run will follow, written to be read with no conversation context' },
        cadence: { type: 'string', description: 'daily | 6h | 1h | 15m | a phrase like "every day at 7am" | a 5-field cron pattern' },
        timezone: { type: 'string', description: 'Zone for clock times, e.g. "IST", "UTC", "+05:30" (default IST)' },
        mission: { type: 'string', description: 'For update/pause/resume/delete/run_now: the task title or missionId' },
        enabled: { type: 'boolean', description: 'Set false to create a task without starting it' }
      },
      required: ['action']
    },
    outputSchema: {
      type: 'object',
      properties: {
        missions: { type: 'array', description: 'For list: the user\'s standing tasks' },
        mission: { type: 'object', description: 'The created/updated task, with its next run time' },
        schedule: { type: 'string', description: 'Human-readable schedule, including the UTC conversion' }
      }
    },
    cacheTTLSeconds: 0, // stateful — never cache
    rateLimitPerMinute: 20
  },

  applications: {
    name: 'applications',
    description: 'The user\'s job-application ledger — the system\'s only memory of which opportunities were found, drafted and applied to. {"action":"stats"} answers "how many have I applied to?"; "list" shows them; {"action":"log","jobs":[{"role":"…","company":"…","url":"…","source":"…","matchScore":78}]} records finds. ALWAYS log the postings you surface — duplicate URLs merge instead of counting twice, and a daily hunt reads this to avoid re-reporting yesterday\'s job. You may write status "drafted"/"shortlisted"/"skipped" only; "applied"/"interviewing"/"rejected"/"offer" describe what the HUMAN did, so set them only when the user says so, with "userConfirmed": true.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'log | list | stats | update | delete' },
        jobs: { type: 'array', description: 'For log: array of {role, company, location, url, source, matchScore, notes}' },
        role: { type: 'string', description: 'For log of a single job' },
        company: { type: 'string' },
        url: { type: 'string', description: 'Posting URL — also the de-duplication key' },
        status: { type: 'string', description: 'drafted | shortlisted | skipped (agent-writable); applied | interviewing | rejected | offer (user-confirmed only)' },
        userConfirmed: { type: 'boolean', description: 'True only when the user has said they took this action themselves' },
        application: { type: 'string', description: 'For update/delete: applicationId, URL, or "role at company"' },
        days: { type: 'number', description: 'For list: look-back window (default 90)' }
      },
      required: ['action']
    },
    outputSchema: {
      type: 'object',
      properties: {
        total: { type: 'number' },
        applied: { type: 'number' },
        awaitingSubmission: { type: 'number' },
        applications: { type: 'array' }
      }
    },
    cacheTTLSeconds: 0, // stateful — never cache
    rateLimitPerMinute: 20
  },

  gmail: {
    name: 'gmail',
    description: 'Read the user\'s JOB mail — the alerts and recruiter messages already sitting in their inbox from LinkedIn, Naukri, Indeed, Internshala and company careers/ATS addresses. {"action":"list","days":14,"keywords":"product manager"} returns matching messages (sender, subject, snippet); {"action":"read","messageId":"…"} opens ONE of them and returns its text plus the application links inside it; {"action":"status"} reports whether the user has connected their account. This searches ONLY job senders — it is not a search of their mailbox, the filter is fixed in code and you cannot widen it, so never tell the user you looked through their email. Read-only: you cannot reply, send, label or delete anything. If it reports connected:false, ask the user to connect Gmail on the Settings page; you cannot do that for them.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'list | read | status' },
        days: { type: 'number', description: 'For list: look-back window in days (default 14, max 90)' },
        keywords: { type: 'string', description: 'For list: optional role words to narrow to, e.g. "product manager analyst"' },
        limit: { type: 'number', description: 'For list: max messages (default 10, max 25)' },
        messageId: { type: 'string', description: 'For read: an id from a previous list' }
      },
      required: ['action']
    },
    outputSchema: {
      type: 'object',
      properties: {
        messages: { type: 'array', description: 'For list: messageId, from, subject, date, snippet' },
        body: { type: 'string', description: 'For read: the message text' },
        links: { type: 'array', description: 'For read: application URLs found in the message' }
      }
    },
    cacheTTLSeconds: 0, // a mailbox changes constantly — never cache
    rateLimitPerMinute: 10
  },

  portfolio: {
    name: 'portfolio',
    description: 'The user\'s ACTUAL holdings, priced live and totalled in INR (₹) — "watchlist" is only what they follow. Positions come from their connected brokerage accounts (Binance, Zerodha) and from anything recorded by hand; each carries "heldAt" saying which. {"action":"value"} is the full review: refreshes what it can, then returns per-position value and weight, allocation, unrealized P/L, a "sources" list with each account\'s freshness, and "flags". READ THE FLAGS AND REPORT THEM — Zerodha only refreshes when the user logs in, so its numbers are often from the last sync, and presenting stale figures as current is the one failure that matters here. {"action":"sync"} forces a refresh and says which accounts need the user to log in again. {"action":"history","days":30} answers "am I growing" from recorded daily snapshots (change since last, 7/30-day, peak, drawdown, movers) — read its "currency" field rather than assuming. Call "value" before "history"; never estimate past performance from memory. {"action":"add","symbol":"BTC","quantity":0.5,"avgCost":42000} records what the user tells you — never guess a quantity, ask. Also "list" and "remove" (manual entries only). If empty with nothing connected, say so and mention Settings; never review a hypothetical portfolio as theirs. Reads and records only — it NEVER places an order, and the stored Binance key is verified incapable of trading.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'value | list | add | update | remove | history | sync' },
        days: { type: 'number', description: 'For history: how far back to read, default 90' },
        symbol: { type: 'string', description: 'Ticker or asset name, e.g. BTC, TSLA, gold' },
        kind: { type: 'string', description: 'crypto | stock | commodity | cash (auto-detected if omitted)' },
        quantity: { type: 'number', description: 'Units/shares/coins held — ask the user, never guess' },
        avgCost: { type: 'number', description: 'Average cost per unit, if the user knows it' },
        holdings: { type: 'array', description: 'For add: several holdings at once' }
      },
      required: ['action']
    },
    outputSchema: {
      type: 'object',
      properties: {
        totalValueInr: { type: 'number', description: 'The headline number, in rupees' },
        totalValueUsd: { type: 'number' },
        fxUsdInr: { type: 'number', description: 'The USD→INR rate used for this valuation' },
        totalUnrealizedPnlInr: { type: 'number' },
        allocation: { type: 'object', description: 'Value and weight per asset class' },
        holdings: { type: 'array', description: 'Per-position price, value, weight, P/L, and which account holds it' },
        sources: { type: 'array', description: 'Per connected broker: status, last sync time, age in hours, and whether the user must log in again' },
        flags: { type: 'array', description: 'Concentration, staleness and data-gap warnings to report honestly' },
        sinceLast: { type: 'object', description: 'For history: change since the previous snapshot' },
        drawdownFromPeakPct: { type: 'number', description: 'For history: how far below the recorded peak' },
        movers: { type: 'array', description: 'For history: positions ranked by how much they moved the total' }
      }
    },
    cacheTTLSeconds: 0, // stateful and priced live — never cache
    rateLimitPerMinute: 10
  },

  analytics: {
    name: 'analytics',
    description: 'Professional risk and performance analytics from historical daily prices. {"action":"portfolio"} — the user\'s whole book: per-asset volatility/Sharpe/drawdown, covariance-based portfolio volatility, correlations, concentration (HHI, effective number of positions), and RISK CONTRIBUTION — how much of total risk each holding supplies, which often differs sharply from its share of value. {"action":"asset","symbol":"ETH"} — one asset: return, annualised volatility, Sharpe, Sortino, Calmar, max and current drawdown, 1-day VaR/expected shortfall, SMA 20/50/200, RSI(14), MACD, Bollinger %B, plus plain readings of each. {"action":"compare","symbols":["BTC","ETH","SOL"],"rankBy":"sortino"} — ranks assets by risk-adjusted return over a PAST window. {"action":"horizon","symbol":"ETH"} — what holding for 7/30/90/180/365 days has historically returned (share profitable, median, worst). Optional "days", "kind" ("crypto"|"stock"), "riskFreeRate" (annual, default 0). EVERYTHING HERE DESCRIBES THE PAST: a high Sharpe or a strong horizon history is not a forecast, a ranking can reverse in a different window, and none of it tells the user what to buy or how long to hold. Report it as evidence and say so.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'portfolio | asset | compare | horizon' },
        symbol: { type: 'string', description: 'For asset/horizon: e.g. BTC, ETH, RELIANCE' },
        symbols: { type: 'array', description: 'For compare: 2-10 symbols' },
        kind: { type: 'string', description: 'crypto | stock (default crypto)' },
        days: { type: 'number', description: 'History window (portfolio default 90, asset/compare 365, horizon 1095)' },
        rankBy: { type: 'string', description: 'For compare: sortino | sharpe | calmar | totalReturn | maxDrawdown | volatility' },
        horizons: { type: 'array', description: 'For horizon: holding periods in days, default [7,30,90,180,365]' },
        riskFreeRate: { type: 'number', description: 'Annual risk-free rate as a decimal, e.g. 0.065. Default 0 — always state what was used' }
      },
      required: ['action']
    },
    outputSchema: {
      type: 'object',
      properties: {
        risk: { type: 'object', description: 'Volatility, Sharpe, Sortino, drawdowns, VaR' },
        trend: { type: 'object', description: 'Moving averages, RSI, MACD, Bollinger' },
        riskContribution: { type: 'array', description: 'For portfolio: each holding\'s share of total risk vs its share of value' },
        readings: { type: 'array', description: 'Plain-language descriptions of the numbers — definitions, never instructions' }
      }
    },
    cacheTTLSeconds: 0, // the history is cached underneath; the result depends on the live portfolio
    rateLimitPerMinute: 10
  },

  alerts: {
    name: 'alerts',
    description: 'Risk alerts on the user\'s holdings, checked every 15 minutes and delivered to every channel they enabled (Telegram included). Material holdings (≥5% of the portfolio) get default protection automatically: 15% drawdown from the 30-day high, 10% fall in 24h, a 1% stablecoin depeg, and a 15% portfolio drawdown. {"action":"list"} shows what is watched and recent alerts. {"action":"create","type":"price_below","symbol":"ETH","threshold":2000} adds one — types: drawdown_from_peak (%, windowDays), sharp_drop (% in 24h), price_below / price_above (price in the asset\'s OWN quote currency: USD for crypto, INR for NSE/BSE), trend_break (below the windowDays average, default 200), volatility_spike (multiple of normal, default 2), depeg (%, stablecoins), portfolio_drawdown (%). {"action":"update","ruleId":"…","threshold":20} or "enabled":false; {"action":"remove","ruleId":"…"} (a default is switched off, not deleted); {"action":"check"} evaluates everything now without notifying — use it for "is anything wrong right now?"; {"action":"history"} lists past alerts. Alerts catch a move within minutes of crossing a line — they cannot see one coming, and they never tell the user to sell. Say both when setting one up.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'list | create | update | remove | check | history' },
        type: { type: 'string', description: 'For create: drawdown_from_peak | sharp_drop | price_below | price_above | trend_break | volatility_spike | depeg | portfolio_drawdown' },
        symbol: { type: 'string', description: 'For create: the asset (omit for portfolio_drawdown)' },
        threshold: { type: 'number', description: '% for relative rules, a price for price_*, a multiple for volatility_spike' },
        windowDays: { type: 'number', description: 'Lookback for drawdown/trend/volatility rules' },
        ruleId: { type: 'string', description: 'For update/remove: from list' },
        enabled: { type: 'boolean', description: 'For update: pause or resume a rule' },
        note: { type: 'string', description: 'For create: why the user wanted it, in their words' },
        days: { type: 'number', description: 'For history: look-back window' }
      },
      required: ['action']
    },
    outputSchema: {
      type: 'object',
      properties: {
        rules: { type: 'array', description: 'For list: each watched condition with its state' },
        wouldFireNow: { type: 'array', description: 'For check: lines crossed right now' },
        alerts: { type: 'array', description: 'For history: past alerts sent' }
      }
    },
    cacheTTLSeconds: 0, // stateful — never cache
    rateLimitPerMinute: 20
  },

  jobs: {
    name: 'jobs',
    description: 'Search REAL job listings for a role (analyst, data science, ML, AI, product manager, business analyst, etc.), optionally filtered by company and region — always pass the region, it selects the right boards. Every result carries "kind": "posting" is ONE opening (cite it, shortlist it, draft for it); "listing_page" is a board\'s search page such as "Business Analyst Jobs in Hyderabad — 2227 Vacancies" — offer those as "browse here", never as a specific job. Cite each result\'s URL and board label, and report the "sources" field honestly if a source was skipped or unconfigured.',
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

  forex: {
    name: 'forex',
    description: 'Look up the current foreign-exchange rate between two currencies (e.g. USD→INR, EUR→USD, GBP→JPY). Use this WHENEVER the user asks about a currency, exchange rate, or "dollar price in rupees" style question — do NOT just tell them to visit a website. Input: {"from":"USD","to":"INR"} or a phrase like "USD to INR".',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Base currency — ISO code or name, e.g. "USD", "dollar"' },
        to: { type: 'string', description: 'Quote currency — ISO code or name, e.g. "INR", "rupee"' }
      },
      required: ['from', 'to']
    },
    outputSchema: {
      type: 'object',
      properties: {
        pair: { type: 'string' },
        rate: { type: 'number' },
        change: { type: 'number' },
        changePercent: { type: 'number' },
        description: { type: 'string' },
        source: { type: 'string' }
      }
    },
    cacheTTLSeconds: 60, // FX moves continuously — keep it fresh
    rateLimitPerMinute: 15
  },

  fetch: {
    name: 'fetch',
    web: true,
    description: 'Fetch a specific URL and extract its readable text content, title, and links. Use this AFTER search/jobs/news gave you a URL and you need the actual page content. Automatically falls back to the Jina Reader renderer when a page is blocked, times out, or is a JavaScript shell, so it can read pages a plain fetch cannot. Input: {"url": "https://..."}',
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
    description: 'Get recent (last 48h) headlines AND the catalysts moving markets, from trusted RSS feeds (CoinDesk, Cointelegraph, CNBC, Reuters/Bloomberg, plus SEC, the Federal Reserve, and Al Jazeera for regulation/macro/geopolitics). Each headline is tagged with the catalyst it signals — regulation, macro, geopolitics, institutional (whales/ETFs), celebrity, adoption, earnings, security — and the result includes a catalystBreakdown count. Use this to answer WHY a price is moving and whether the setup looks bullish or bearish.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Symbol or topic to match, e.g. "BTC", "AI", "Fed", "Tesla". Leave broad (or omit terms) to scan the whole tape for catalysts.' },
        category: { type: 'string', description: 'Optional filter: crypto | markets | tech | regulation | macro | geopolitics' }
      },
      required: ['query']
    },
    outputSchema: {
      type: 'object',
      properties: {
        catalystBreakdown: { type: 'object', description: 'Count of headlines per catalyst category' },
        results: { type: 'array', description: 'Headlines with title, url, feed, publishedAt, and catalysts[] tags' }
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

  notifications: {
    name: 'notifications',
    description: 'Read the signed-in user\'s own notification feed (alerts, mission results, system messages). Use this whenever the user asks about their notifications — e.g. "where are my notifications", "do I have anything new", "any unread alerts". Input: {"action":"list"} for recent items or {"action":"unread"} for just the unread count. Read-only — it cannot mark items read or delete them.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'list | unread (default list)' },
        limit: { type: 'number', description: 'Max items to return for list (default 20, max 50)' }
      },
      required: ['action']
    },
    outputSchema: {
      type: 'object',
      properties: {
        unreadCount: { type: 'number' },
        notifications: { type: 'array', description: 'Recent notifications (type, title, content, read, link, createdAt)' }
      }
    },
    cacheTTLSeconds: 0, // per-user, changes anytime — never cache
    rateLimitPerMinute: 20
  },

  system_status: {
    name: 'system_status',
    description: 'Check whether the FinChat agents are ACTUALLY working, from live system state — not from what you remember about them. Returns, per agent: whether it is configured and addressable, whether it can deliver a reply at all, its recent runs and how many completed naturally, when it last answered this user in chat, and its standing tasks. Each agent carries a status of healthy | degraded | untested | broken with the specific problems behind it. Use this WHENEVER the user asks whether an agent or the system is working, why an agent did not answer, what the roster can do right now, or reports something as broken — the roster in your prompt describes what the agents are FOR, and says nothing about whether they are running. Input: {} for the whole roster, or {"agent":"atlas"} for one.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Optional: one agent id to check, e.g. "atlas", "aurelius", "rasha", "nova", "plato". Omit for all.' }
      },
      required: []
    },
    outputSchema: {
      type: 'object',
      properties: {
        agents: { type: 'array', description: 'Per agent: status, problems[], configured, canDeliver, tools, runs, lastRun, chat, standingTasks' },
        summary: { type: 'object', description: 'Agent ids grouped into broken / degraded / healthy / untested' }
      }
    },
    cacheTTLSeconds: 0, // a health check that answers from cache is not a health check
    rateLimitPerMinute: 20
  },

  neural_map: {
    name: 'neural_map',
    description: 'Read the signed-in user\'s own neural maps — the concept maps and network diagrams they build on the Neural Map page. Use this to understand how the user thinks or organises a topic, or when they say things like "read my map", "what\'s on my <name> map", or "use my maps to understand me". Input: {"action":"list"} to see all their maps, or {"action":"read","map":"<map name or id>"} to read one map\'s nodes, connections and notes. Read-only — it cannot create or change maps.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'list | read (default list)' },
        map: { type: 'string', description: 'For read: the map name or id (omit or "system" for the built-in System Map)' }
      },
      required: ['action']
    },
    outputSchema: {
      type: 'object',
      properties: {
        maps: { type: 'array', description: 'For list: the user\'s maps (mapId, name, kind, nodeCount)' },
        nodes: { type: 'array', description: 'For read: the map\'s nodes (label, type, note)' },
        edges: { type: 'array', description: 'For read: connections between nodes (from, to, note)' }
      }
    },
    cacheTTLSeconds: 0, // per-user, editable anytime — never cache
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

  wikipedia: {
    name: 'wikipedia',
    web: true,
    description: 'Look up authoritative, citation-backed encyclopedic facts on Wikipedia (people, companies, technologies, events, definitions). Because it is sourced, use this as your GROUND TRUTH to verify claims found on Reddit/Quora before reporting them. Input: {"query":"..."}',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Topic or entity to look up' } },
      required: ['query']
    },
    outputSchema: {
      type: 'object',
      properties: { topArticle: { type: 'object' }, results: { type: 'array' } }
    },
    cacheTTLSeconds: 3600, // encyclopedic facts change slowly
    rateLimitPerMinute: 15
  },

  reddit: {
    name: 'reddit',
    web: true,
    description: 'Search Reddit for real community discussion, sentiment, and first-hand experiences on any topic. Results are UNVERIFIED opinion — you MUST cross-check any factual claim with the wikipedia, news, or search tool before reporting it. If the result has "searchUnavailable": true, the lookup itself is broken — report that, and never say there is no discussion on the topic. Input: {"query":"...","subreddit":"optional"}',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search Reddit for' },
        subreddit: { type: 'string', description: 'Optional subreddit to restrict to, e.g. "wallstreetbets"' }
      },
      required: ['query']
    },
    outputSchema: {
      type: 'object',
      properties: { results: { type: 'array' }, crossCheckAdvice: { type: 'string' } }
    },
    cacheTTLSeconds: 300,
    rateLimitPerMinute: 10
  },

  quora: {
    name: 'quora',
    web: true,
    description: 'Find relevant Quora question threads and perspectives on a topic. Answers are anonymous opinion of varying quality — UNVERIFIED. Use for angles/viewpoints only and cross-check every fact with wikipedia/news/search. Use the fetch tool on a result URL to read a full thread. If the result has "searchUnavailable": true, the lookup itself is broken — report that, and never say nothing has been asked about the topic. Input: {"query":"..."}',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Question or topic to find on Quora' } },
      required: ['query']
    },
    outputSchema: {
      type: 'object',
      properties: { results: { type: 'array' }, crossCheckAdvice: { type: 'string' } }
    },
    cacheTTLSeconds: 600,
    rateLimitPerMinute: 6
  },

  youtube: {
    name: 'youtube',
    web: true,
    description: 'Search YouTube for videos, or read a specific video\'s metadata (title, channel, views, publish date, description) and its transcript. Great for earnings calls, analyst breakdowns, and company presentations. Give {"query":"..."} to search, or {"url":"https://youtu.be/..."} / {"videoId":"..."} for one video with its transcript. Transcript may be null if the video has no captions. If the result has "searchUnavailable": true, the lookup is misconfigured or over quota — report that and never say the topic does not exist.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms for finding videos' },
        url: { type: 'string', description: 'A YouTube URL for a specific video (returns details + transcript)' },
        videoId: { type: 'string', description: 'An 11-char YouTube video id (alternative to url)' }
      }
    },
    outputSchema: {
      type: 'object',
      properties: { results: { type: 'array' }, video: { type: 'object' }, transcript: { type: 'object' } }
    },
    cacheTTLSeconds: 600,
    rateLimitPerMinute: 10
  },

  agent_reach: {
    name: 'agent_reach',
    web: true,
    description: 'Reach authed/social platforms our other tools cannot — logged-in Reddit, Twitter/X, LinkedIn, Instagram, Facebook — via a self-hosted Agent-Reach worker. Results are UNVERIFIED social/UGC opinion: cross-check any factual claim with wikipedia/news/search before reporting it. If the result has "searchUnavailable": true, the worker/backend is offline (setup gap or the user\'s machine is off) — report that outage and never say the topic has no discussion. Input: {"platform":"twitter","query":"..."}',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', description: 'Platform to reach: reddit, twitter (x), linkedin, instagram, facebook' },
        query: { type: 'string', description: 'What to search that platform for' }
      },
      required: ['platform', 'query']
    },
    outputSchema: {
      type: 'object',
      properties: { results: { type: 'array' }, crossCheckAdvice: { type: 'string' } }
    },
    cacheTTLSeconds: 300,
    rateLimitPerMinute: 6
  },

  crypto: {
    name: 'crypto',
    description: 'Look up a cryptocurrency price. Without "days" it returns the current price, 24h change, and market cap. With "days" (e.g. 7, 30, 365) it returns daily price history plus the start/end price and % change over that window — use this for comparisons and "how has X performed" questions. Falls back to Binance/Coinbase if CoinGecko is rate-limited.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Cryptocurrency symbol or name (e.g. "BTC", "ethereum", "SOL", "solana")' },
        days: { type: 'number', description: 'Optional: number of past days of daily history to return (e.g. 7, 30, 90, 365). Omit for the current price only.' },
        compare: { type: 'boolean', description: 'Optional: if true, price the coin across all venues at once (CoinGecko, Binance, Kraken, Coinbase) and return each price plus a median consensus and spread. Use to verify a quote or spot venue divergence.' }
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
  },

  signal: {
    name: 'signal',
    web: true,
    description: 'Compute a deterministic BULLISH/BEARISH/NEUTRAL signal for a cryptocurrency OR a stock by fusing price momentum, trend vs its 30-day average, (crypto) cross-venue agreement, and news-catalyst sentiment. Returns the signal, a confidence (low/medium/high), a score from -100 to +100, and the per-factor contributions plus catalysts behind it — the explainable "why". Use this when the user asks whether to buy/sell/hold, "is X bullish or bearish", or wants a read on where an asset is heading. Educational only, never financial advice.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Ticker or name, e.g. "BTC", "ethereum", "SOL", "AAPL", "TSLA"' },
        kind: { type: 'string', description: 'Optional: "crypto" or "stock". If omitted it is auto-detected (known crypto tickers → crypto, otherwise stock).' }
      },
      required: ['symbol']
    },
    outputSchema: {
      type: 'object',
      properties: {
        signal: { type: 'string' },
        confidence: { type: 'string' },
        score: { type: 'number' },
        factors: { type: 'array', description: 'Each scoring factor with its numeric contribution' },
        catalystBreakdown: { type: 'object' }
      }
    },
    cacheTTLSeconds: 120,
    rateLimitPerMinute: 8
  },

  session: {
    name: 'session',
    web: true,
    description: 'Produce the user\'s "Market Intelligence Session": a ranked, sourced report over their whole watchlist (defaults to BTC/ETH/SOL if empty). For each crypto it runs the signal engine (bullish/bearish/neutral + score), ranks assets most-bullish to most-bearish, rolls up the catalysts driving the market, and returns a finished markdown report plus structured data. Use this when the user asks for a market brief/session, "what should I be watching", a portfolio-wide read, or "run my session". Optionally pass {"symbols":["BTC","ETH"]} to override the watchlist. Deliver the returned markdown; it already carries the not-financial-advice note.',
    inputSchema: {
      type: 'object',
      properties: {
        symbols: { type: 'array', description: 'Optional: override the watchlist with these crypto symbols, e.g. ["BTC","ETH","SOL"]' }
      }
    },
    outputSchema: {
      type: 'object',
      properties: {
        markdown: { type: 'string', description: 'The finished report — deliver this' },
        overall: { type: 'object' },
        assets: { type: 'array' },
        topCatalysts: { type: 'object' }
      }
    },
    cacheTTLSeconds: 180,
    rateLimitPerMinute: 4
  },

  diagnostics: {
    name: 'diagnostics',
    description: 'Read the system\'s own failure record: runs clustered by error, budget breaches, failing tools, failing standing tasks, and provider latency. Read-only — it diagnoses, it does not repair. Input: {"scope":"failures"|"providers"|"tools"|"execution","days":7,"agent":"nova","execution_id":"exec_..."}. Start with "failures", then drill into one execution_id.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          description: '"failures" (default: runs clustered by error), "providers" (inference latency and volume), "tools" (tool errors clustered), "execution" (one run in full — needs execution_id)'
        },
        days: { type: 'number', description: 'Look-back window in days, 1-90 (default 7)' },
        agent: { type: 'string', description: 'Optional: restrict to one agent id' },
        execution_id: { type: 'string', description: 'Required for scope "execution"' }
      }
    },
    cacheTTLSeconds: 30,
    rateLimitPerMinute: 20
  },

  bash: {
    name: 'bash',
    // NOT sandboxed — the previous wording claimed a Docker container that does not
    // exist (P0-1). This text goes into the system prompt and onto the human approval
    // card, so it must not imply containment that isn't there.
    description: 'Execute a shell command directly on the backend HOST with the server\'s own privileges. There is no sandbox, no command allowlist and no filesystem confinement. Restricted to the admin agent and gated on human approval. Input: {"command":"..."}',
    requires_approval: true,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
        timeout: { type: 'number', description: 'Optional timeout in ms (default 30000)' }
      },
      required: ['command']
    },
    cacheTTLSeconds: 0,
    rateLimitPerMinute: 20
  },

  file_read: {
    name: 'file_read',
    description: 'Read file contents from the local filesystem with line pagination. Use this to inspect code or data files. Input: {"file_path":"..."}',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute or relative file path' },
        offset: { type: 'number', description: 'Line number to start reading from (0-indexed, default 0)' },
        limit: { type: 'number', description: 'Number of lines to read (default 500, max 1000)' }
      },
      required: ['file_path']
    },
    cacheTTLSeconds: 0,
    rateLimitPerMinute: 60
  },

  file_write: {
    name: 'file_write',
    description: 'Write or overwrite a file entirely on the filesystem. Input: {"file_path":"...", "content":"..."}',
    requires_approval: true,
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute or relative file path' },
        content: { type: 'string', description: 'Full content to write to the file' }
      },
      required: ['file_path', 'content']
    },
    cacheTTLSeconds: 0,
    rateLimitPerMinute: 20
  },

  file_edit: {
    name: 'file_edit',
    description: 'Make targeted search-and-replace edits to existing files. Input: {"file_path":"...", "old_string":"...", "new_string":"..."}',
    requires_approval: true,
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute or relative file path' },
        old_string: { type: 'string', description: 'Exact string block to replace (must match perfectly)' },
        new_string: { type: 'string', description: 'New string block to replace it with' },
        replace_all: { type: 'boolean', description: 'If true, replaces all occurrences' }
      },
      required: ['file_path', 'old_string', 'new_string']
    },
    cacheTTLSeconds: 0,
    rateLimitPerMinute: 20
  },

  glob: {
    name: 'glob',
    description: 'Find files matching a glob pattern in a directory (default cwd). Use to explore the workspace. Input: {"pattern":"**/*.js"}',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.js")' },
        dir: { type: 'string', description: 'Directory to search in (default is current working directory)' }
      },
      required: ['pattern']
    },
    cacheTTLSeconds: 0,
    rateLimitPerMinute: 60
  }
};

/**
 * Get metadata for a registered tool by name.
 */
function getToolMeta(toolName) {
  return TOOLS[toolName] || null;
}

// ── Host-access restrictions ─────────────────────────────────────
// These live here rather than in ToolManager because both ToolManager (to
// enforce them) and this module (to hide them from prompts) need them, and
// ToolManager already requires ToolRegistry — defining them the other way round
// would be a circular import.

/** Tools only the admin agent may hold. Enforced in ToolManager.checkPermission. */
const ADVANCED_SYSTEM_TOOLS = new Set(['bash', 'file_read', 'file_write', 'file_edit', 'glob']);

/**
 * Tools that reach the host directly — BashTool shells out via child_process.exec,
 * the file tools write to the real filesystem. Holding one of these is equivalent
 * to holding a host shell, so they are DENY-BY-DEFAULT (P0-1): an agent may use
 * them only with an explicit `allowed = 1` row, and every other answer is a denial.
 */
const HOST_ACCESS_TOOLS = new Set(['bash', 'file_write', 'file_edit']);

/** The one agent permitted to hold host-access tools. Must match migration 026. */
const ADMIN_AGENT_ID = 'plato';

// ── The diagnostician's narrower grant ───────────────────────────
//
// Hopper's job is to explain a failure and propose the patch, which needs to
// READ code — file_read and glob — and nothing more. Those two are in
// ADVANCED_SYSTEM_TOOLS (admin-only) but deliberately NOT in HOST_ACCESS_TOOLS:
// they open files, they do not change the machine. Granting the pair is what
// separates a diagnosis from a guess.
//
// The writing half stays off. On Render the filesystem is ephemeral and there is
// no git or PR tool here, so a file_edit applied in production is written into a
// container that is replaced on the next deploy and never reaches the repo — a
// "fix" that reports success and silently disappears. Locally it is a real
// workflow, so HOPPER_HOST_TOOLS=true opts in, and only there.
const DIAGNOSTIC_AGENT_ID = 'hopper';
const DIAGNOSTIC_READ_TOOLS = new Set(['file_read', 'glob']);
const HOPPER_HOST_TOOLS =
  String(process.env.HOPPER_HOST_TOOLS || '').toLowerCase() === 'true';

/**
 * Which ADVANCED_SYSTEM_TOOLS this agent may hold.
 *
 * A function rather than a constant because the answer is now per-agent: the
 * admin holds all of them, the diagnostician holds the reading pair (plus the
 * writing ones only where an operator has opted in), everyone else holds none.
 * Both listTools (to hide) and ToolManager.checkPermission (to enforce) ask
 * this, so the prompt an agent sees and the calls it may make cannot drift
 * apart — which they did before, when agents were shown bash and then refused
 * it mid-plan.
 */
function systemToolsFor(agentId) {
  if (agentId === ADMIN_AGENT_ID) return ADVANCED_SYSTEM_TOOLS;
  if (agentId === DIAGNOSTIC_AGENT_ID) {
    return HOPPER_HOST_TOOLS
      ? new Set([...DIAGNOSTIC_READ_TOOLS, ...HOST_ACCESS_TOOLS])
      : DIAGNOSTIC_READ_TOOLS;
  }
  return new Set();
}

// Tools every agent keeps regardless of its configured domain.
//
// These are not a convenience: the RULES block in ContextBuilder ORDERS the
// model to verify any specific named work, person or organisation with
// `wikipedia` for encyclopedic subjects and `search` otherwise, before stating
// facts about it. Scoping either of them away from an agent would leave the
// prompt commanding a tool the same prompt never showed it — which the model
// resolves by either ignoring the rule or inventing the call.
const ALWAYS_AVAILABLE_TOOLS = new Set(['search', 'wikipedia']);

/**
 * List registered tools for injecting into system prompts.
 *
 * `allowWeb: false` hides open-web tools (composer WEB toggle off).
 *
 * `agentId` hides tools the agent is not permitted to use. Without it, every
 * agent's prompt advertised bash/file_write/file_edit/glob even though only
 * plato may run them — so agents planned steps that could never execute. The
 * seeded research-digest mission planned `bash "synthesis.sh"` and
 * `bash "brief.sh"`, invented scripts for work that is reasoning rather than
 * shell, and burned tool calls discovering it was not allowed.
 *
 * Omitting agentId hides the restricted tools rather than showing them: these
 * are the deny-by-default host-access tools, so a call site that forgets to
 * identify itself should lose capability, not gain it.
 *
 * This mirrors only the STATIC rule (ADVANCED_SYSTEM_TOOLS + ADMIN_AGENT_ID).
 * The per-agent `tool_permissions` rows are deliberately not consulted — that
 * would make prompt building async and add a DB round-trip to every turn, and
 * ToolManager still enforces those rows at call time. A tool shown here can
 * still be refused; nothing shown here is refused for the admin agent.
 *
 * `agentTools` narrows the catalogue to one agent's domain. It is PASSED IN
 * rather than read here for the same reason as above: the caller already has
 * the agent config in hand, and looking it up here would make prompt building
 * async.
 *
 * The lists come from `agent_configs.tools`, which has always held curated
 * per-agent sets (aurelius: stocks/crypto/commodities/news/watchlist; rasha:
 * jobs/resume/apply_draft; nova: paper/crawl/news) — nothing ever consulted
 * them, so every agent was shown all 18 research tools on every turn. Rasha,
 * a careers agent, carried forex and commodities schemas in every request at
 * ~1,744 tokens for the block.
 *
 * An EMPTY or missing list means "not configured", not "no tools". The two are
 * indistinguishable in the data, and guessing toward "none" would silently
 * strip an agent of every capability it has — so an unconfigured agent keeps
 * the full set and loses nothing.
 */
function listTools({ allowWeb = true, agentId = null, agentTools = null } = {}) {
  const isAdmin = agentId === ADMIN_AGENT_ID;
  // The orchestrator is exempt: it is the fallback for every goal no specialist
  // matched, so it must be able to reach anything. Its own row lists only
  // ["search"], which as a restriction would break exactly the case it exists
  // to handle.
  const scoped = !isAdmin && Array.isArray(agentTools) && agentTools.length > 0
    ? new Set([...agentTools, ...ALWAYS_AVAILABLE_TOOLS])
    : null;

  // The system tools THIS agent may hold. Note this is separate from `isAdmin`
  // above: the diagnostician earns file_read and glob without also inheriting
  // the orchestrator's exemption from domain scoping — it stays scoped to its
  // own tools like every other specialist.
  const systemTools = systemToolsFor(agentId);

  return Object.values(TOOLS)
    .filter(t => allowWeb || !t.web)
    .filter(t => !ADVANCED_SYSTEM_TOOLS.has(t.name) || systemTools.has(t.name))
    .filter(t => !scoped || scoped.has(t.name))
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

module.exports = {
  TOOLS, getToolMeta, listTools, getToolNames,
  ADVANCED_SYSTEM_TOOLS, HOST_ACCESS_TOOLS, ADMIN_AGENT_ID, ALWAYS_AVAILABLE_TOOLS,
  systemToolsFor, DIAGNOSTIC_AGENT_ID, DIAGNOSTIC_READ_TOOLS, HOPPER_HOST_TOOLS
};
