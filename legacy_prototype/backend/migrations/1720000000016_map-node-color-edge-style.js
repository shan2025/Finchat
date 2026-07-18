/* eslint-disable camelcase */

// Sprint 6 — per-node colour + per-edge line style.
//
// Both live in the annotation tables so they work for ANY node/edge — derived
// or custom — and are already scoped per (user_id, map_id, key), so one user's
// styling never leaks into another user's view or another map.
//
//   neural_map_node_meta.color : '#rrggbb' override for the node fill.
//                                NULL → fall back to the type palette.
//   neural_map_edge_meta.style : 'solid' | 'dashed'. NULL → solid (default).

exports.up = async (pgm) => {
  pgm.addColumns('neural_map_node_meta', {
    color: { type: 'text' }
  });
  pgm.addColumns('neural_map_edge_meta', {
    style: { type: 'text' }
  });
  pgm.addConstraint('neural_map_edge_meta', 'neural_map_edge_meta_style_check',
    { check: "style IS NULL OR style IN ('solid', 'dashed')" });
};

exports.down = async (pgm) => {
  pgm.dropConstraint('neural_map_edge_meta', 'neural_map_edge_meta_style_check');
  pgm.dropColumns('neural_map_edge_meta', ['style']);
  pgm.dropColumns('neural_map_node_meta', ['color']);
};
