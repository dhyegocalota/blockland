//! Deterministic-ish world simulation shared by the server (authoritative) and the
//! future WASM client. Pure logic: no I/O, no rendering, no networking.
//!
//! The terrain is procedural (a function of coordinates), so only player *edits* need
//! to be stored — a sparse overlay on top of the base. This mirrors the JS engine.

use std::collections::HashMap;

pub const SIZE_Y: i32 = 24;
pub const GROUND: i32 = 6;
pub const WATER_LEVEL: i32 = GROUND - 1;
pub const WORLD_SIZE: i32 = 16384;

pub const AIR: u8 = 0;
pub const WATER: u8 = 11;
pub const BEDROCK: u8 = 16;
pub const MAX_BLOCK: u8 = 19;

/// Highest block of the terrain column at (x, z).
pub fn height_at(x: i32, z: i32) -> i32 {
    let xf = x as f32;
    let zf = z as f32;
    let h = (xf * 0.05).sin() * 1.4
        + (zf * 0.045).cos() * 1.4
        + ((xf + zf) * 0.02).sin() * 2.6
        + (xf * 0.013).sin() * (zf * 0.017).cos() * 4.2;
    let top = GROUND + h.round() as i32;
    top.clamp(2, SIZE_Y - 5)
}

/// The procedurally-generated block at a coordinate, ignoring player edits.
pub fn base_voxel(x: i32, y: i32, z: i32) -> u8 {
    if !(0..SIZE_Y).contains(&y) {
        return AIR;
    }
    let top = height_at(x, z);
    if y > top {
        if y <= WATER_LEVEL {
            return WATER;
        }
        return AIR;
    }
    if y == 0 {
        return BEDROCK;
    }
    if y == top {
        return 1; // grass
    }
    if y >= top - 2 {
        return 2; // dirt
    }
    3 // stone
}

/// Authoritative world: procedural base + a sparse map of player edits.
#[derive(Default)]
pub struct World {
    edits: HashMap<(i32, i32, i32), u8>,
}

impl World {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, x: i32, y: i32, z: i32) -> u8 {
        if let Some(&v) = self.edits.get(&(x, y, z)) {
            return v;
        }
        base_voxel(x, y, z)
    }

    pub fn set(&mut self, x: i32, y: i32, z: i32, id: u8) {
        self.edits.insert((x, y, z), id);
    }

    pub fn is_solid(&self, x: i32, y: i32, z: i32) -> bool {
        let v = self.get(x, y, z);
        v != AIR && v != WATER
    }

    /// Number of player edits stored (handy for telemetry / persistence sizing).
    pub fn edit_count(&self) -> usize {
        self.edits.len()
    }

    /// All edits as a flat list (for persistence).
    pub fn snapshot(&self) -> Vec<(i32, i32, i32, u8)> {
        self.edits
            .iter()
            .map(|((x, y, z), &id)| (*x, *y, *z, id))
            .collect()
    }

    /// Apply a list of edits onto the world (used when restoring from storage).
    pub fn load_edits(&mut self, items: &[(i32, i32, i32, u8)]) {
        for &(x, y, z, id) in items {
            self.edits.insert((x, y, z), id);
        }
    }

    /// A reasonable spawn near the center of the world.
    pub fn spawn() -> [f32; 3] {
        let cx = WORLD_SIZE / 2;
        let cz = WORLD_SIZE / 2;
        let y = height_at(cx, cz) as f32 + 3.0;
        [cx as f32 + 0.5, y, cz as f32 + 0.5]
    }
}

// ---------- Cheap persistence codec ----------
// Edits are encoded as sorted linear indices, delta-varint (LEB128) + one id byte, then
// LZ4-compressed. Tiny on disk and microseconds of CPU; the base terrain is regenerated
// procedurally, so only player edits are stored.

fn linear(x: i32, y: i32, z: i32) -> u64 {
    let w = WORLD_SIZE as u64;
    (x as u64) + (z as u64) * w + (y as u64) * w * w
}

fn delinear(i: u64) -> (i32, i32, i32) {
    let w = WORLD_SIZE as u64;
    let x = (i % w) as i32;
    let z = ((i / w) % w) as i32;
    let y = (i / (w * w)) as i32;
    (x, y, z)
}

fn write_varint(buf: &mut Vec<u8>, mut v: u64) {
    loop {
        let mut byte = (v & 0x7f) as u8;
        v >>= 7;
        if v != 0 {
            byte |= 0x80;
        }
        buf.push(byte);
        if v == 0 {
            break;
        }
    }
}

fn read_varint(buf: &[u8], pos: &mut usize) -> Result<u64, String> {
    let mut result = 0u64;
    let mut shift = 0u32;
    loop {
        let byte = *buf.get(*pos).ok_or("unexpected end of buffer")?;
        *pos += 1;
        result |= ((byte & 0x7f) as u64) << shift;
        if byte & 0x80 == 0 {
            return Ok(result);
        }
        shift += 7;
        if shift >= 64 {
            return Err("varint too long".into());
        }
    }
}

/// Encode a set of edits into a compact, compressed blob.
pub fn encode_edits(items: &[(i32, i32, i32, u8)]) -> Vec<u8> {
    let mut entries: Vec<(u64, u8)> = items
        .iter()
        .map(|&(x, y, z, id)| (linear(x, y, z), id))
        .collect();
    entries.sort_unstable_by_key(|&(i, _)| i);

    let mut raw = Vec::with_capacity(entries.len() * 3 + 8);
    write_varint(&mut raw, entries.len() as u64);
    let mut prev = 0u64;
    for (idx, id) in entries {
        write_varint(&mut raw, idx - prev);
        raw.push(id);
        prev = idx;
    }
    lz4_flex::compress_prepend_size(&raw)
}

/// Recover edits from a blob produced by [`encode_edits`].
pub fn decode_edits(blob: &[u8]) -> Result<Vec<(i32, i32, i32, u8)>, String> {
    let raw = lz4_flex::decompress_size_prepended(blob).map_err(|e| e.to_string())?;
    let mut pos = 0usize;
    let count = read_varint(&raw, &mut pos)?;
    let mut out = Vec::with_capacity(count as usize);
    let mut idx = 0u64;
    for _ in 0..count {
        idx += read_varint(&raw, &mut pos)?;
        let id = *raw.get(pos).ok_or("unexpected end of buffer")?;
        pos += 1;
        let (x, y, z) = delinear(idx);
        out.push((x, y, z, id));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn height_stays_in_bounds() {
        for x in 0..400 {
            for z in (0..400).step_by(7) {
                let h = height_at(x, z);
                assert!(
                    (2..=SIZE_Y - 5).contains(&h),
                    "height {h} out of bounds at {x},{z}"
                );
            }
        }
    }

    #[test]
    fn height_is_deterministic() {
        assert_eq!(height_at(123, 456), height_at(123, 456));
    }

    #[test]
    fn base_voxel_layers() {
        // Pick a column above the water line so "above surface" is air, not water.
        let (x, z) = (0..200)
            .flat_map(|x| (0..200).map(move |z| (x, z)))
            .find(|&(x, z)| height_at(x, z) > WATER_LEVEL)
            .expect("a dry column must exist");
        let top = height_at(x, z);
        assert_eq!(base_voxel(x, 0, z), BEDROCK, "y=0 must be bedrock");
        assert_eq!(base_voxel(x, top, z), 1, "surface must be grass");
        assert_eq!(
            base_voxel(x, top + 1, z),
            AIR,
            "above a dry surface must be air"
        );
        assert!(
            base_voxel(x, top - 1, z) != AIR,
            "below surface must be solid"
        );
        assert_eq!(
            base_voxel(x, SIZE_Y, z),
            AIR,
            "out of vertical range is air"
        );
    }

    #[test]
    fn edits_override_base() {
        let mut w = World::new();
        let (x, y, z) = (10, 5, 10);
        let base = w.get(x, y, z);
        let other = if base == 8 { 9 } else { 8 };
        w.set(x, y, z, other);
        assert_eq!(w.get(x, y, z), other);
        assert_eq!(w.edit_count(), 1);
        w.set(x, y, z, AIR);
        assert!(!w.is_solid(x, y, z));
    }

    #[test]
    fn water_is_not_solid() {
        let mut w = World::new();
        w.set(3, 4, 3, WATER);
        assert!(!w.is_solid(3, 4, 3));
        w.set(3, 4, 3, 3);
        assert!(w.is_solid(3, 4, 3));
    }

    #[test]
    fn spawn_inside_world() {
        let s = World::spawn();
        assert!(s[0] > 0.0 && s[0] < WORLD_SIZE as f32);
        assert!(s[2] > 0.0 && s[2] < WORLD_SIZE as f32);
        assert!(s[1] > 0.0 && s[1] < SIZE_Y as f32 + 8.0);
    }

    fn sorted(mut v: Vec<(i32, i32, i32, u8)>) -> Vec<(i32, i32, i32, u8)> {
        v.sort_unstable();
        v
    }

    #[test]
    fn codec_roundtrips() {
        let edits = vec![
            (0, 0, 0, BEDROCK),
            (8191, 23, 8191, 8),
            (100, 5, 200, 19),
            (16383, 0, 16383, 1),
            (4096, 12, 9000, 14),
        ];
        let blob = encode_edits(&edits);
        let back = decode_edits(&blob).expect("decode");
        assert_eq!(sorted(back), sorted(edits));
    }

    #[test]
    fn codec_empty() {
        let blob = encode_edits(&[]);
        assert!(decode_edits(&blob).unwrap().is_empty());
    }

    #[test]
    fn codec_keeps_last_id_per_cell_via_world() {
        // Encode -> decode -> reload into a world reproduces the same voxels.
        let mut w = World::new();
        w.set(10, 5, 10, 8);
        w.set(11, 6, 12, 0);
        let blob = encode_edits(&w.snapshot());
        let mut w2 = World::new();
        w2.load_edits(&decode_edits(&blob).unwrap());
        assert_eq!(w2.get(10, 5, 10), 8);
        assert_eq!(w2.get(11, 6, 12), 0);
    }

    #[test]
    fn codec_is_compact() {
        // A clustered build should compress to well under a byte per edit.
        let mut edits = Vec::new();
        for x in 0..40 {
            for z in 0..40 {
                edits.push((1000 + x, 8, 1000 + z, 8));
            }
        }
        let blob = encode_edits(&edits);
        assert!(
            blob.len() < edits.len(),
            "expected compact blob, got {}",
            blob.len()
        );
    }
}
