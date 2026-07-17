// tools/PaperTool.js — Scientific paper search via arXiv public API (no API key required)
const axios = require('axios');

// Simple XML tag extractor (avoids heavy xml2js dependency)
function extractTag(xml, tag) {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : '';
}

function extractAllTags(xml, tag) {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const matches = [];
  let m;
  while ((m = regex.exec(xml)) !== null) {
    matches.push(m[1].trim());
  }
  return matches;
}

/**
 * Parse arXiv Atom XML response into structured paper objects.
 */
function parseArxivResponse(xml) {
  // Split into individual <entry> blocks
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
  const papers = [];
  let match;

  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[1];

    const id = extractTag(entry, 'id');
    const title = extractTag(entry, 'title').replace(/\s+/g, ' ');
    const summary = extractTag(entry, 'summary').replace(/\s+/g, ' ');
    const published = extractTag(entry, 'published');
    const updated = extractTag(entry, 'updated');

    // Extract author names
    const authorBlocks = extractAllTags(entry, 'author');
    const authors = authorBlocks.map(a => extractTag(a, 'name')).filter(Boolean);

    // Extract PDF link
    const pdfMatch = entry.match(/<link[^>]*title="pdf"[^>]*href="([^"]+)"/i);
    const pdfUrl = pdfMatch ? pdfMatch[1] : (id ? id.replace('/abs/', '/pdf/') : '');

    // Extract categories
    const categoryMatches = [...entry.matchAll(/term="([^"]+)"/g)];
    const categories = categoryMatches.map(m => m[1]).filter(c => !c.includes('http'));

    papers.push({
      id: id || '',
      title: title || 'Untitled',
      authors: authors.length > 0 ? authors : ['Unknown'],
      summary: summary ? summary.substring(0, 500) + (summary.length > 500 ? '...' : '') : 'No abstract available.',
      published: published || '',
      updated: updated || '',
      pdfUrl,
      categories: categories.slice(0, 5)
    });
  }

  return papers;
}

/**
 * Execute a scientific paper search on arXiv.
 *
 * @param {string} input - Search query string, or JSON with {query, maxResults}
 * @returns {Promise<{ papers: Array<{id, title, authors, summary, published, pdfUrl, categories}> }>}
 */
async function execute(input) {
  let queryText;
  let maxResults = 5;

  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      queryText = parsed.query || input;
      maxResults = parsed.maxResults || 5;
    } catch {
      queryText = input.trim();
    }
  } else {
    queryText = (input?.query || '').trim();
    maxResults = input?.maxResults || 5;
  }

  if (!queryText) {
    return { papers: [], error: 'No search query provided.' };
  }

  try {
    const response = await axios.get('http://export.arxiv.org/api/query', {
      params: {
        search_query: `all:${queryText}`,
        start: 0,
        max_results: Math.min(maxResults, 10),
        sortBy: 'relevance',
        sortOrder: 'descending'
      },
      timeout: 15000,
      headers: {
        'User-Agent': 'FinChat-Research-Agent/1.0'
      }
    });

    const papers = parseArxivResponse(response.data);

    if (papers.length === 0) {
      return {
        papers: [],
        message: `No papers found for "${queryText}". Try different keywords or broader terms.`
      };
    }

    return {
      papers,
      totalFound: papers.length,
      query: queryText
    };
  } catch (err) {
    console.warn(`⚠️ PaperTool: arXiv API failed: ${err.message}`);
    return {
      papers: [],
      error: `Unable to search arXiv for "${queryText}". ${err.message}`
    };
  }
}

module.exports = { execute };
