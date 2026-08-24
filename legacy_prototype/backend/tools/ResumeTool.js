// tools/ResumeTool.js — Resume store, fit scoring, and per-posting tailoring.
//
// Scoring is local and deterministic (no API key required). Storage and
// tailoring were added for standing tasks: a 4am job hunt has nobody to paste a
// resume at, so the resume lives in `user_resumes` and every run reads it from
// there. `tailor` rewrites that stored resume against one specific posting and
// returns the rewrite plus what changed — it never overwrites the stored copy,
// because a tailored variant is for one application, not the new master.
const { v4: uuidv4 } = require('uuid');
const { query } = require('../database');

// Comprehensive skill taxonomy across major tech/finance/research domains
const SKILL_TAXONOMY = {
  'Full Stack Engineer': {
    core: ['javascript', 'typescript', 'node.js', 'nodejs', 'react', 'vue', 'angular', 'html', 'css', 'rest', 'api', 'graphql', 'sql', 'postgresql', 'mongodb', 'docker', 'git', 'ci/cd', 'aws', 'gcp', 'azure'],
    bonus: ['next.js', 'express', 'tailwind', 'redis', 'kubernetes', 'terraform', 'microservices', 'websocket', 'testing', 'jest', 'cypress', 'agile', 'scrum']
  },
  'Backend Engineer': {
    core: ['python', 'java', 'go', 'node.js', 'rust', 'sql', 'postgresql', 'mysql', 'api', 'rest', 'docker', 'linux', 'git', 'microservices', 'aws'],
    bonus: ['kubernetes', 'redis', 'kafka', 'rabbitmq', 'grpc', 'graphql', 'terraform', 'monitoring', 'prometheus', 'elasticsearch', 'ci/cd']
  },
  'Frontend Engineer': {
    core: ['javascript', 'typescript', 'react', 'vue', 'angular', 'html', 'css', 'responsive', 'accessibility', 'git', 'webpack', 'testing'],
    bonus: ['next.js', 'tailwind', 'storybook', 'figma', 'performance', 'seo', 'pwa', 'animation', 'design system']
  },
  'Data Scientist': {
    core: ['python', 'sql', 'machine learning', 'statistics', 'pandas', 'numpy', 'scikit-learn', 'data visualization', 'jupyter', 'r'],
    bonus: ['tensorflow', 'pytorch', 'deep learning', 'nlp', 'spark', 'hadoop', 'tableau', 'power bi', 'a/b testing', 'bayesian']
  },
  'AI/ML Engineer': {
    core: ['python', 'machine learning', 'deep learning', 'tensorflow', 'pytorch', 'neural networks', 'nlp', 'computer vision', 'data pipelines', 'git'],
    bonus: ['transformers', 'llm', 'rag', 'langchain', 'huggingface', 'mlops', 'kubernetes', 'docker', 'cuda', 'onnx', 'reinforcement learning']
  },
  'Blockchain Developer': {
    core: ['solidity', 'ethereum', 'smart contracts', 'web3', 'javascript', 'blockchain', 'cryptography', 'defi', 'git'],
    bonus: ['rust', 'solana', 'anchor', 'hardhat', 'truffle', 'ipfs', 'token', 'nft', 'dao', 'consensus', 'zk-proofs']
  },
  'DevOps Engineer': {
    core: ['docker', 'kubernetes', 'ci/cd', 'linux', 'aws', 'terraform', 'ansible', 'monitoring', 'git', 'bash', 'networking'],
    bonus: ['gcp', 'azure', 'helm', 'prometheus', 'grafana', 'jenkins', 'github actions', 'security', 'iac', 'service mesh']
  },
  'Product Manager': {
    core: ['product strategy', 'roadmap', 'user research', 'analytics', 'agile', 'scrum', 'stakeholder management', 'data-driven', 'prioritization'],
    bonus: ['sql', 'a/b testing', 'figma', 'jira', 'okrs', 'market analysis', 'competitive analysis', 'user stories', 'wireframing']
  }
};

// Generic fallback for roles not in the taxonomy
const GENERIC_SKILLS = {
  core: ['communication', 'problem solving', 'teamwork', 'leadership', 'analytical', 'project management', 'technical writing'],
  bonus: ['presentation', 'mentoring', 'cross-functional', 'stakeholder management', 'strategic thinking']
};

/**
 * Extract keywords from text by normalizing and tokenizing.
 */
function extractKeywords(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s/.\-#+']/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1);
}

/**
 * Check if a skill phrase appears in the resume text.
 */
function skillFound(resumeText, skill) {
  return resumeText.toLowerCase().includes(skill.toLowerCase());
}

// ── Stored resumes ───────────────────────────────────────────────

async function loadStored(userId, label = null) {
  if (!userId || userId === 'system') return null;
  const res = label
    ? await query('SELECT * FROM user_resumes WHERE user_id = $1 AND label = $2', [userId, label])
    : await query('SELECT * FROM user_resumes WHERE user_id = $1 ORDER BY is_primary DESC, updated_at DESC LIMIT 1', [userId]);
  return res.rows[0] || null;
}

async function saveStored(userId, { content, label = 'default', targetRole = null }) {
  // One primary per user is a partial unique index, so demote before promoting.
  await query('UPDATE user_resumes SET is_primary = false WHERE user_id = $1 AND label <> $2', [userId, label]);
  const res = await query(`
    INSERT INTO user_resumes (resume_id, user_id, label, content, target_role, is_primary)
    VALUES ($1, $2, $3, $4, $5, true)
    ON CONFLICT (user_id, label) DO UPDATE SET
      content = EXCLUDED.content,
      target_role = COALESCE(EXCLUDED.target_role, user_resumes.target_role),
      is_primary = true,
      updated_at = now()
    RETURNING *`, [`resume_${uuidv4()}`, userId, label, content, targetRole]);
  return res.rows[0];
}

function parseInput(input) {
  if (typeof input === 'object' && input !== null) return input;
  const s = String(input || '').trim();
  if (s.startsWith('{')) {
    try { return JSON.parse(s); } catch (e) { /* a bare resume string */ }
  }
  return { resumeText: s };
}

/**
 * Rewrite the stored resume for one specific posting.
 *
 * Returns the tailored resume, an explicit list of what changed, and the
 * keyword gaps the local scorer found — so the user can see the edit rather
 * than being handed a silently rewritten history. The prompt forbids inventing
 * experience: a tailored resume that claims skills the person does not have is
 * worse than no tailoring at all.
 */
async function tailor({ resumeText, job, targetRole, scoring }) {
  const { runInference } = require('../services/inference');
  const jobText = typeof job === 'object' && job !== null
    ? JSON.stringify(job, null, 1).slice(0, 4000)
    : String(job || '').slice(0, 4000);

  const prompt = `You are an expert resume writer tailoring an EXISTING resume to one specific opportunity.

TARGET ROLE: ${targetRole}
${jobText ? `JOB POSTING:\n${jobText}\n` : '(No posting text supplied — tailor to the target role generally.)'}

CURRENT RESUME:
${String(resumeText).slice(0, 6000)}

KEYWORD ANALYSIS (from a deterministic scorer — treat as fact):
- Match score: ${scoring.matchScore}%
- Present: ${(scoring.matchingSkills || []).join(', ') || 'none detected'}
- Missing from the resume: ${(scoring.missingSkills || []).join(', ') || 'none'}

ABSOLUTE RULES:
- NEVER invent employers, dates, degrees, metrics, or skills the candidate does not evidence. If a missing keyword is not supported by their real experience, leave it out and list it under Gaps instead.
- You may re-order, re-word, re-emphasise, and surface buried-but-real experience. That is the whole job.
- Keep every factual claim traceable to the current resume.

Produce EXACTLY this markdown structure:
## Tailored Resume
(the full rewritten resume, ready to use)
## What Changed
(bullets: each change and why it helps for THIS posting)
## Gaps I Could Not Close
(keywords the posting wants that the resume does not honestly support, with what the candidate could do about each)`;

  const result = await runInference({
    feature: 'resume_tailor',
    temperature: 0.4,
    messages: [{ role: 'user', content: prompt }]
  });
  return { markdown: result.content, model: result.model, tokens: result.tokens || 0 };
}

/**
 * Resume store + fit scoring + tailoring.
 *
 * Actions: analyze (default) | save | get | tailor.
 * The legacy single-argument form ({resumeText, targetRole} or a bare string)
 * still scores exactly as before.
 */
async function execute(input, context = {}) {
  const opts = parseInput(input);
  const userId = context.userId;
  const action = String(opts.action || 'analyze').toLowerCase();

  if (action === 'save') {
    const content = String(opts.content || opts.resumeText || opts.resume || '').trim();
    if (!userId || userId === 'system') throw new Error('Saving a resume requires a signed-in user.');
    if (content.length < 50) throw new Error('That is too short to store as a resume — ask the user for the full text.');
    const row = await saveStored(userId, {
      content, label: String(opts.label || 'default'), targetRole: opts.targetRole || null
    });
    return {
      action: 'save', saved: true, label: row.label, characters: content.length,
      message: 'Resume stored. Standing tasks and future tailoring will read this copy — the user does not need to paste it again.'
    };
  }

  if (action === 'get') {
    if (!userId || userId === 'system') throw new Error('Reading a stored resume requires a signed-in user.');
    const row = await loadStored(userId, opts.label || null);
    if (!row) {
      return { action: 'get', found: false, note: 'No resume stored yet. Ask the user to paste theirs, then store it with {"action":"save","content":"…"}.' };
    }
    return { action: 'get', found: true, label: row.label, targetRole: row.target_role, resumeText: row.content, updatedAt: row.updated_at };
  }

  // analyze and tailor both need the resume text — stored copy by default.
  let resumeText = String(opts.resumeText || opts.resume || opts.content || '').trim();
  let targetRole = opts.targetRole || opts.role || 'Full Stack Engineer';
  let usedStored = false;
  if (!resumeText && userId && userId !== 'system') {
    const row = await loadStored(userId, opts.label || null);
    if (row) {
      resumeText = row.content;
      usedStored = true;
      if (!opts.targetRole && !opts.role && row.target_role) targetRole = row.target_role;
    }
  }

  if (action === 'tailor') {
    if (!resumeText || resumeText.length < 50) {
      return {
        action: 'tailor',
        error: resumeText
          ? 'The resume on file is too short to tailor. Ask the user for their full resume text and store it with {"action":"save","content":"…"}.'
          : 'No resume available. Ask the user for their resume text and store it with {"action":"save","content":"…"} first.'
      };
    }
    const scoring = await scoreResume(resumeText, opts.job && opts.job.title ? opts.job.title : targetRole);
    const out = await tailor({ resumeText, job: opts.job, targetRole: scoring.targetRole, scoring });
    return {
      action: 'tailor',
      targetRole: scoring.targetRole,
      baselineMatchScore: scoring.matchScore,
      missingSkills: scoring.missingSkills,
      usedStoredResume: usedStored,
      tailoredResume: out.markdown,
      model: out.model,
      disclaimer: 'A tailored variant for this posting — the stored master resume is unchanged. Nothing was submitted anywhere.'
    };
  }

  const scored = await scoreResume(resumeText, targetRole);
  return usedStored ? { ...scored, usedStoredResume: true } : scored;
}

/**
 * Deterministic local fit scoring — the original engine, unchanged.
 */
async function scoreResume(resumeText, targetRole) {
  if (!resumeText || resumeText.length < 20) {
    return {
      error: 'Resume text is too short or empty. Please provide a more detailed resume.',
      matchScore: 0,
      targetRole
    };
  }

  // Find the closest matching role in our taxonomy
  const roleKey = Object.keys(SKILL_TAXONOMY).find(
    r => r.toLowerCase() === targetRole.toLowerCase()
  ) || Object.keys(SKILL_TAXONOMY).find(
    r => targetRole.toLowerCase().includes(r.toLowerCase().split(' ')[0])
  );

  const taxonomy = roleKey ? SKILL_TAXONOMY[roleKey] : GENERIC_SKILLS;
  const actualRole = roleKey || targetRole;

  // Score core skills
  const matchingCoreSkills = taxonomy.core.filter(s => skillFound(resumeText, s));
  const missingCoreSkills = taxonomy.core.filter(s => !skillFound(resumeText, s));

  // Score bonus skills
  const matchingBonusSkills = taxonomy.bonus.filter(s => skillFound(resumeText, s));

  // Calculate match score (core skills = 70% weight, bonus = 30% weight)
  const coreScore = taxonomy.core.length > 0 ? (matchingCoreSkills.length / taxonomy.core.length) : 0;
  const bonusScore = taxonomy.bonus.length > 0 ? (matchingBonusSkills.length / taxonomy.bonus.length) : 0;
  const matchScore = Math.round((coreScore * 0.7 + bonusScore * 0.3) * 100);

  // Generate targeted recommendations
  const recommendations = [];

  if (matchScore >= 80) {
    recommendations.push(`✅ Strong fit for ${actualRole}. Focus on highlighting your ${matchingCoreSkills.slice(0, 3).join(', ')} expertise prominently.`);
  } else if (matchScore >= 50) {
    recommendations.push(`⚡ Solid foundation for ${actualRole}. Bridging ${missingCoreSkills.length} core skill gap(s) would significantly boost your candidacy.`);
  } else {
    recommendations.push(`🎯 Building toward ${actualRole}. Consider upskilling in: ${missingCoreSkills.slice(0, 4).join(', ')}.`);
  }

  if (missingCoreSkills.length > 0) {
    recommendations.push(`📚 Priority skills to develop: ${missingCoreSkills.slice(0, 5).join(', ')}.`);
  }

  if (matchingBonusSkills.length > 0) {
    recommendations.push(`💎 Differentiators to highlight: ${matchingBonusSkills.join(', ')}.`);
  }

  const unmatchedBonus = taxonomy.bonus.filter(s => !skillFound(resumeText, s));
  if (unmatchedBonus.length > 0) {
    recommendations.push(`🚀 Advanced skills to stand out: ${unmatchedBonus.slice(0, 4).join(', ')}.`);
  }

  // Detect experience level signals
  const seniorSignals = ['lead', 'senior', 'architect', 'principal', 'director', 'manager', 'mentor', 'strategy', 'team'];
  const hasSenioritySignals = seniorSignals.some(s => skillFound(resumeText, s));
  if (hasSenioritySignals) {
    recommendations.push(`👔 Leadership signals detected — consider positioning for Senior / Lead ${actualRole} roles.`);
  }

  return {
    targetRole: actualRole,
    matchScore,
    matchingSkills: matchingCoreSkills,
    missingSkills: missingCoreSkills,
    bonusSkills: matchingBonusSkills,
    recommendations,
    analysis: {
      coreSkillsCoverage: `${matchingCoreSkills.length}/${taxonomy.core.length}`,
      bonusSkillsCoverage: `${matchingBonusSkills.length}/${taxonomy.bonus.length}`,
      seniorityDetected: hasSenioritySignals
    }
  };
}

module.exports = { execute, scoreResume, loadStored };
