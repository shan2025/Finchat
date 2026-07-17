// tools/ResumeTool.js — Resume analysis & career fit scoring engine (local, no API key required)

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

/**
 * Execute resume analysis against a target role.
 *
 * @param {string} input - JSON string or object with {resumeText, targetRole}
 * @returns {Promise<{ matchScore, matchingSkills, missingSkills, bonusSkills, recommendations, targetRole }>}
 */
async function execute(input) {
  let resumeText, targetRole;

  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      resumeText = parsed.resumeText || parsed.resume || input;
      targetRole = parsed.targetRole || parsed.role || 'Full Stack Engineer';
    } catch {
      resumeText = input;
      targetRole = 'Full Stack Engineer';
    }
  } else {
    resumeText = input?.resumeText || input?.resume || '';
    targetRole = input?.targetRole || input?.role || 'Full Stack Engineer';
  }

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

module.exports = { execute };
