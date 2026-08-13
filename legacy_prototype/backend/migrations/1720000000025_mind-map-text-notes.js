/* eslint-disable camelcase */

// Sprint Z · Track A · A6 — Typed text as a first-class mind map source
//
// Until now the only way to give a map source material was to upload a file.
// That is the wrong shape for the common case: a paragraph of your own notes,
// a passage pasted out of something you were reading, a correction you want the
// branch to reflect. Those are not files and forcing them through an upload
// (write a .txt, then attach it) is friction with nothing on the other side.
//
// Rather than a second table, a text note is a mind_map_docs row with
// kind = 'text': stored_name NULL (there is no blob), `extracted` IS the note.
// Every path that already reads sources — inheritedDocs, sourceBlock, the node
// chat's attachments, gap grounding — then picks notes up for free, because
// they all read `extracted` and none of them care where it came from.
//
// mind_maps.source_type gains 'text' so a map built from a pasted passage is
// not mislabelled as a document map on the provenance panel.

exports.up = async (pgm) => {
  pgm.dropConstraint('mind_map_docs', 'mind_map_docs_kind_check');
  pgm.addConstraint('mind_map_docs', 'mind_map_docs_kind_check',
    { check: "kind IN ('document', 'image', 'text')" });

  pgm.dropConstraint('mind_maps', 'mind_maps_source_type_check');
  pgm.addConstraint('mind_maps', 'mind_maps_source_type_check',
    { check: "source_type IN ('topic', 'chat', 'document', 'text', 'graph', 'mission')" });
};

exports.down = async (pgm) => {
  // Text notes would violate the narrower check, so fold them back into
  // 'document' rather than failing the rollback on live data.
  pgm.sql("UPDATE mind_map_docs SET kind = 'document' WHERE kind = 'text'");
  pgm.dropConstraint('mind_map_docs', 'mind_map_docs_kind_check');
  pgm.addConstraint('mind_map_docs', 'mind_map_docs_kind_check',
    { check: "kind IN ('document', 'image')" });

  pgm.sql("UPDATE mind_maps SET source_type = 'document' WHERE source_type = 'text'");
  pgm.dropConstraint('mind_maps', 'mind_maps_source_type_check');
  pgm.addConstraint('mind_maps', 'mind_maps_source_type_check',
    { check: "source_type IN ('topic', 'chat', 'document', 'graph', 'mission')" });
};
