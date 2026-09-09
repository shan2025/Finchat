/* eslint-disable camelcase */

// Agent sayings — the line an agent opens with, and the promise never to
// repeat it.
//
// Two different things live in one table on purpose:
//
//   origin 'seed'    — the agent's permanent character. A handful of real
//                      proverbs from its own field, written once here and
//                      shared by every user. These are what make Aurelius
//                      sound like a market veteran instead of a chat box.
//   origin 'learned' — something the agent actually read. After a run that
//                      consulted real sources, one striking sentence from the
//                      answer is kept alongside the URL it came from and the
//                      topic it belongs to, scoped to the user whose question
//                      surfaced it.
//
// They share a table because the surfacing rule is identical for both: pick a
// line this user has not been shown, show it, write it down. That ledger is
// the whole feature. Without it "never repeat the same thing" is a hope; with
// it, it is a NOT EXISTS clause.
//
// A learned row is per-user (a fact Nova dug up for one person is not another
// person's memory), while a seed row is global (user_id NULL). The ledger is
// always per-user, so two people meeting Aurelius both get to hear his best
// line once.

// Real sayings, each genuinely load-bearing in its agent's field. They are
// attributed where a human said them and left unattributed where they are
// common trade wisdom, because inventing an author is worse than having none.
const SEEDS = {
  plato: [
    ['The beginning is the most important part of the work.', 'Plato'],
    ['If you do not know to which port you are sailing, no wind is favourable.', 'Seneca'],
    ['Divide each difficulty into as many parts as is feasible and necessary to resolve it.', 'Descartes'],
    ['A problem well stated is a problem half solved.', 'Charles Kettering'],
    ['The first principle is that you must not fool yourself — and you are the easiest person to fool.', 'Richard Feynman'],
    ['Everything should be made as simple as possible, but not simpler.', 'attributed to Einstein'],
    ['Give me six hours to chop down a tree and I will spend the first four sharpening the axe.', 'attributed to Lincoln'],
    ['It is not enough to be busy; the question is what we are busy about.', 'Thoreau'],
    ['Delegation is not abdication — the work still has to come back and be judged.', null],
    ['Any plan that survives contact with the first fact was probably not specific enough.', null]
  ],
  aurelius: [
    ['The market can remain irrational longer than you can remain solvent.', 'attributed to Keynes'],
    ['Be fearful when others are greedy and greedy when others are fearful.', 'Warren Buffett'],
    ['Price is what you pay; value is what you get.', 'Warren Buffett'],
    ['The four most dangerous words in investing are: this time it is different.', 'John Templeton'],
    ['Bull markets are born on pessimism, grow on scepticism, mature on optimism and die on euphoria.', 'John Templeton'],
    ['Markets are never wrong; opinions often are.', 'Jesse Livermore'],
    ['In the short run the market is a voting machine, in the long run a weighing machine.', 'Benjamin Graham'],
    ['Risk comes from not knowing what you are doing.', 'Warren Buffett'],
    ['Every headline has an author with an interest — the move is usually explained by whoever benefits from it.', null],
    ['A catalyst is just a fact the market had not finished pricing yet.', null]
  ],
  atlas: [
    ['The investor’s chief problem, and even his worst enemy, is likely to be himself.', 'Benjamin Graham'],
    ['Diversification is the only free lunch in investing.', 'Harry Markowitz'],
    ['The big money is not in the buying and the selling, but in the waiting.', 'Charlie Munger'],
    ['Know what you own, and know why you own it.', 'Peter Lynch'],
    ['Time in the market beats timing the market.', null],
    ['Far more money has been lost preparing for corrections than in the corrections themselves.', 'Peter Lynch'],
    ['A portfolio drifts even when you do nothing — doing nothing is itself a decision.', null],
    ['Concentration builds wealth quietly and destroys it quickly.', null],
    ['You cannot know whether you are growing without writing down where you started.', null],
    ['The first job of a steward is to notice, not to act.', null]
  ],
  rasha: [
    ['Chance favours the prepared mind.', 'Louis Pasteur'],
    ['The best time to plant a tree was twenty years ago. The second best time is now.', null],
    ['Your network is the set of people who can vouch for work they have actually seen you do.', null],
    ['A resume is an argument, not an inventory.', null],
    ['People do not hire the most qualified candidate; they hire the one whose story they can retell to their boss.', null],
    ['The job you want is usually already posted under a title you would not have searched for.', null],
    ['Interviews are not exams — they are auditions for a working relationship.', null],
    ['Do not negotiate against yourself before anyone has made an offer.', null],
    ['Career moves compound: the role you take next decides which roles are visible after it.', null],
    ['Being underlevelled is expensive in ways salary alone never shows.', null]
  ],
  nova: [
    ['Extraordinary claims require extraordinary evidence.', 'Carl Sagan'],
    ['The most exciting phrase in science is not "Eureka!" but "That’s funny..."', 'attributed to Isaac Asimov'],
    ['Somewhere, something incredible is waiting to be known.', 'attributed to Carl Sagan'],
    ['If we knew what we were doing, it would not be called research.', 'attributed to Einstein'],
    ['It does not matter how beautiful your theory is; if it disagrees with experiment, it is wrong.', 'Richard Feynman'],
    ['Science is what we understand well enough to explain to a computer.', 'Donald Knuth'],
    ['Any sufficiently advanced technology is indistinguishable from magic.', 'Arthur C. Clarke'],
    ['The absence of evidence is not the evidence of absence.', 'Carl Sagan'],
    ['A result announced by press release has not yet been checked by anyone who wanted it to be false.', null],
    ['Replication is the part of the story that never makes the headline.', null]
  ]
};

exports.up = async (pgm) => {
  pgm.createTable('agent_sayings', {
    saying_id: { type: 'text', primaryKey: true },
    agent_id: { type: 'text', notNull: true },
    // NULL for a seed line: it belongs to the agent, not to anyone's history.
    // Set for a learned line, which was earned inside one user's conversation.
    user_id: { type: 'text', references: '"users"', onDelete: 'CASCADE' },
    text: { type: 'text', notNull: true },
    attribution: { type: 'text' },
    origin: { type: 'text', notNull: true, default: 'seed' },
    // Where a learned line came from, so it can be shown with a citation and
    // audited later. Seeds carry neither.
    source_url: { type: 'text' },
    source_title: { type: 'text' },
    // Lowercased keywords used to decide whether a line is relevant to the
    // question being asked. Seeds get none and so only ever open a greeting.
    topics: { type: 'jsonb', notNull: true, default: '[]' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.createIndex('agent_sayings', ['agent_id', 'origin']);
  pgm.createIndex('agent_sayings', ['user_id']);
  // The same sentence should never be banked twice for one agent.
  pgm.addConstraint('agent_sayings', 'agent_sayings_unique_text',
    { unique: ['agent_id', 'text'] });

  // The never-repeat ledger. One row the first time a user is shown a line;
  // the picker excludes anything already in here for that user.
  pgm.createTable('agent_saying_shown', {
    saying_id: { type: 'text', notNull: true, references: '"agent_sayings"', onDelete: 'CASCADE' },
    user_id: { type: 'text', notNull: true },
    shown_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') }
  });
  pgm.addConstraint('agent_saying_shown', 'agent_saying_shown_pk',
    { primaryKey: ['saying_id', 'user_id'] });
  pgm.createIndex('agent_saying_shown', ['user_id']);

  // Same posture as 023/024/038/044: RLS on, no policies, so Supabase's anon
  // and authenticated roles cannot read these while the backend (owner)
  // enforces ownership in the service layer. Learned rows quote what a
  // specific person was researching, which is not public.
  pgm.sql('ALTER TABLE "agent_sayings" ENABLE ROW LEVEL SECURITY');
  pgm.sql('ALTER TABLE "agent_saying_shown" ENABLE ROW LEVEL SECURITY');

  const rows = [];
  for (const [agentId, list] of Object.entries(SEEDS)) {
    list.forEach((entry, i) => {
      const [text, attribution] = entry;
      const id = `seed_${agentId}_${String(i + 1).padStart(2, '0')}`;
      const attr = attribution === null ? 'NULL' : `'${attribution.replace(/'/g, "''")}'`;
      rows.push(`('${id}', '${agentId}', NULL, '${text.replace(/'/g, "''")}', ${attr}, 'seed')`);
    });
  }
  pgm.sql(`
    INSERT INTO agent_sayings (saying_id, agent_id, user_id, text, attribution, origin)
    VALUES ${rows.join(',\n           ')}
    ON CONFLICT (agent_id, text) DO NOTHING;
  `);
};

exports.down = async (pgm) => {
  pgm.dropTable('agent_saying_shown');
  pgm.dropTable('agent_sayings');
};
