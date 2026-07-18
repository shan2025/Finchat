const db = require('./database');

(async () => {
  try {
    const n = await db.query(`SELECT * FROM neural_map_nodes LIMIT 5`);
    console.log('Nodes:', JSON.stringify(n.rows, null, 2));
    
    const e = await db.query(`SELECT * FROM neural_map_edges LIMIT 5`);
    console.log('Edges:', JSON.stringify(e.rows, null, 2));
    
    const m = await db.query(`SELECT * FROM neural_maps LIMIT 5`);
    console.log('Maps:', JSON.stringify(m.rows, null, 2));

    process.exit(0);
  } catch(err) {
    console.error(err.message);
    process.exit(1);
  }
})();
