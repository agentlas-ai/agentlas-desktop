"use strict";

// Minimal, exact mmCIF reader for the categories this plugin uses (atom_site, struct_conn, struct, pdbx_entity_nonpoly).
// It tokenizes the whole data block (quoted values, ;-delimited text fields, loop_ tables) and never guesses a value: a
// missing column is reported, "?" and "." stay distinguishable from text.

function tokenize(text) {
  const tokens = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.startsWith(";")) {
      const parts = [line.slice(1)];
      index++;
      while (index < lines.length && !lines[index].startsWith(";")) { parts.push(lines[index]); index++; }
      tokens.push({ value: parts.join("\n").trim(), quoted: true });
      continue;
    }
    let position = 0;
    while (position < line.length) {
      const char = line[position];
      if (char === " " || char === "\t") { position++; continue; }
      if (char === "#") break;
      if (char === "'" || char === '"') {
        let end = position + 1;
        for (;;) {
          end = line.indexOf(char, end);
          if (end < 0) { end = line.length; break; }
          if (end + 1 >= line.length || line[end + 1] === " " || line[end + 1] === "\t") break;
          end++;
        }
        tokens.push({ value: line.slice(position + 1, end), quoted: true });
        position = end + 1;
        continue;
      }
      let end = position;
      while (end < line.length && line[end] !== " " && line[end] !== "\t") end++;
      tokens.push({ value: line.slice(position, end), quoted: false });
      position = end;
    }
  }
  return tokens;
}

/** Returns { blockId, items: Map<tag, value>, loops: Map<category, { tags, rows }> }. */
function parseMmcif(text, wanted = null) {
  const tokens = tokenize(text);
  const items = new Map();
  const loops = new Map();
  let blockId = null;
  const keep = (tag) => !wanted || wanted.some((category) => tag.startsWith(`${category}.`));
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (!token.quoted && token.value.startsWith("data_")) { blockId = token.value.slice(5); index++; continue; }
    if (!token.quoted && token.value === "loop_") {
      index++;
      const tags = [];
      while (index < tokens.length && !tokens[index].quoted && tokens[index].value.startsWith("_")) { tags.push(tokens[index].value); index++; }
      const values = [];
      while (index < tokens.length) {
        const next = tokens[index];
        if (!next.quoted && (next.value === "loop_" || next.value.startsWith("_") || next.value.startsWith("data_"))) break;
        values.push(next.value);
        index++;
      }
      if (!tags.length) continue;
      const category = tags[0].slice(0, tags[0].indexOf("."));
      if (!keep(tags[0])) continue;
      if (values.length % tags.length !== 0) throw new Error(`mmcif-loop-shape-invalid:${category}`);
      const rows = [];
      for (let offset = 0; offset < values.length; offset += tags.length) rows.push(values.slice(offset, offset + tags.length));
      loops.set(category, { tags: tags.map((tag) => tag.slice(category.length + 1)), rows });
      continue;
    }
    if (!token.quoted && token.value.startsWith("_")) {
      const value = tokens[index + 1];
      if (keep(token.value) && value) items.set(token.value, value.value);
      index += 2;
      continue;
    }
    index++;
  }
  return { blockId, items, loops };
}

/** A category as row objects whether it was written as a loop or as single key-value items. */
function categoryRows(parsed, category) {
  const loop = parsed.loops.get(category);
  if (loop) return loop.rows.map((row) => Object.fromEntries(loop.tags.map((tag, column) => [tag, row[column]])));
  const prefix = `${category}.`;
  const single = {};
  for (const [tag, value] of parsed.items) if (tag.startsWith(prefix)) single[tag.slice(prefix.length)] = value;
  return Object.keys(single).length ? [single] : [];
}

const missing = (value) => value === undefined || value === "?" || value === ".";

function atomSites(parsed) {
  const rows = categoryRows(parsed, "_atom_site");
  if (!rows.length) throw new Error("mmcif-atom-site-missing");
  for (const column of ["group_PDB", "label_atom_id", "label_comp_id", "label_asym_id", "Cartn_x", "Cartn_y", "Cartn_z", "auth_seq_id", "auth_asym_id"]) {
    if (!(column in rows[0])) throw new Error(`mmcif-atom-site-column-missing:${column}`);
  }
  return rows.map((row) => ({
    group: row.group_PDB,
    id: row.id,
    element: missing(row.type_symbol) ? null : row.type_symbol,
    atom: row.auth_atom_id && !missing(row.auth_atom_id) ? row.auth_atom_id : row.label_atom_id,
    altId: missing(row.label_alt_id) ? "" : row.label_alt_id,
    compId: row.auth_comp_id && !missing(row.auth_comp_id) ? row.auth_comp_id : row.label_comp_id,
    labelAsymId: row.label_asym_id,
    labelEntityId: missing(row.label_entity_id) ? null : row.label_entity_id,
    labelSeqId: missing(row.label_seq_id) ? null : Number(row.label_seq_id),
    authSeqId: Number(row.auth_seq_id),
    authAsymId: row.auth_asym_id,
    insertionCode: missing(row.pdbx_PDB_ins_code) ? "" : row.pdbx_PDB_ins_code,
    x: Number(row.Cartn_x), y: Number(row.Cartn_y), z: Number(row.Cartn_z),
    bFactor: missing(row.B_iso_or_equiv) ? null : Number(row.B_iso_or_equiv),
    occupancy: missing(row.occupancy) ? null : Number(row.occupancy),
    modelNum: missing(row.pdbx_PDB_model_num) ? 1 : Number(row.pdbx_PDB_model_num),
  }));
}

function structConnections(parsed) {
  return categoryRows(parsed, "_struct_conn").map((row) => ({
    id: row.id,
    type: row.conn_type_id,
    partner1: { labelAsymId: row.ptnr1_label_asym_id, compId: row.ptnr1_auth_comp_id || row.ptnr1_label_comp_id, atom: row.ptnr1_label_atom_id, authAsymId: row.ptnr1_auth_asym_id, authSeqId: Number(row.ptnr1_auth_seq_id), labelSeqId: missing(row.ptnr1_label_seq_id) ? null : Number(row.ptnr1_label_seq_id) },
    partner2: { labelAsymId: row.ptnr2_label_asym_id, compId: row.ptnr2_auth_comp_id || row.ptnr2_label_comp_id, atom: row.ptnr2_label_atom_id, authAsymId: row.ptnr2_auth_asym_id, authSeqId: Number(row.ptnr2_auth_seq_id), labelSeqId: missing(row.ptnr2_label_seq_id) ? null : Number(row.ptnr2_label_seq_id) },
    distance: missing(row.pdbx_dist_value) ? null : Number(row.pdbx_dist_value),
  }));
}

module.exports = { parseMmcif, categoryRows, atomSites, structConnections, missing };
