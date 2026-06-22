//! Deterministic-ish world simulation shared by the server (authoritative) and the
//! future WASM client. Pure logic: no I/O, no rendering, no networking.
//!
//! The terrain is procedural (a function of coordinates), so only player *edits* need
//! to be stored — a sparse overlay on top of the base. This mirrors the JS engine.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

pub const SIZE_Y: i32 = 48;
pub const GROUND: i32 = 10;
pub const WATER_LEVEL: i32 = GROUND - 1;
pub const WORLD_SIZE: i32 = 163840;
/// Blocks the spawn sits north of the exact world center so a player never lands inside the welcome
/// monument (which the shared worldgen builds at the center). Mirrors the web `spawnPoint` z offset.
const SPAWN_MONUMENT_CLEARANCE: i32 = 4;
/// Horizontal chunk edge for procedural decoration (trees + plants). Mirrors the TS `CHUNK`: the
/// decoration RNG is seeded per chunk so every player and a post-reset regen see the same world.
pub const CHUNK: i32 = 32;
/// Hard flight ceiling: a player may never go above this Y. Enforced in move validation so flying
/// can never leave the playable column and bug the simulation. Mirrors the TS `MAX_FLY_Y`.
pub const MAX_FLY_Y: i32 = SIZE_Y + 32;

// Final terrain top is clamped into this band so it always fits inside the column with headroom.
const MIN_HEIGHT: i32 = 2;
const MAX_HEIGHT: i32 = SIZE_Y - 6;

// Compile-time invariants: the flight ceiling clears the tallest terrain and the world height, so a
// flying player always has headroom yet can never leave the playable column and bug the simulation.
const _: () = assert!(MAX_FLY_Y > MAX_HEIGHT);
const _: () = assert!(MAX_FLY_Y > SIZE_Y);

pub const AIR: u8 = 0;
pub const GRASS: u8 = 1;
pub const DIRT: u8 = 2;
pub const STONE: u8 = 3;
pub const WOOD: u8 = 4;
pub const LEAF: u8 = 5;
pub const SAND: u8 = 6;
pub const GOLD: u8 = 8;
pub const FACE: u8 = 10;
pub const WATER: u8 = 11;
pub const WHITE: u8 = 12;
pub const BEDROCK: u8 = 16;
pub const MAX_BLOCK: u8 = 19;

/// Biome at a column, derived purely from coordinates (mirrors the TS `Biome`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Biome {
    Ocean,
    Beach,
    Plains,
    Forest,
    Desert,
    Savanna,
    Mountains,
    Snow,
}

/// Low-frequency continent/ocean signal. Positive over land, negative over deep water.
///
/// Every formula here is computed in f64 to stay bit-for-bit identical to the JavaScript client's
/// worldgen, so client and server agree on the terrain (verified by the shared golden vectors).
/// The literal constants and order of operations MUST match `worldgen.ts` exactly.
fn continent_at(x: i32, z: i32) -> f64 {
    let xf = x as f64;
    let zf = z as f64;
    (xf * 0.0008).sin() * 1.0 + (zf * 0.0009).cos() * 1.0 + ((xf + zf) * 0.0005).sin() * 0.8
}

/// Highest block of the terrain column at (x, z): layered continent + hills + detail + ridges.
pub fn height_at(x: i32, z: i32) -> i32 {
    let xf = x as f64;
    let zf = z as f64;
    let continent = continent_at(x, z);
    let hills =
        (xf * 0.012).sin() * 1.6 + (zf * 0.011).cos() * 1.6 + ((xf - zf) * 0.008).sin() * 2.2;
    let detail = (xf * 0.07).sin() * 0.6 + (zf * 0.063).cos() * 0.6;
    let ridge = (xf * 0.004).sin() * (zf * 0.0035).cos();
    let mountains = continent.max(0.0) * ridge * ridge * 22.0;
    let h = continent * 7.0 + hills + detail + mountains;
    let top = GROUND + h.round() as i32;
    top.clamp(MIN_HEIGHT, MAX_HEIGHT)
}

/// Biome at a column, derived purely from coordinates. Mirrors `biomeAt` in `worldgen.ts`.
pub fn biome_at(x: i32, z: i32) -> Biome {
    let top = height_at(x, z);
    if top <= WATER_LEVEL {
        return Biome::Ocean;
    }
    if top <= WATER_LEVEL + 1 {
        return Biome::Beach;
    }
    if top >= GROUND + 16 {
        return Biome::Snow;
    }
    if top >= GROUND + 10 {
        return Biome::Mountains;
    }
    let xf = x as f64;
    let zf = z as f64;
    let temperature =
        (xf * 0.0015).sin() * 1.0 + (zf * 0.0017).cos() * 1.0 + ((xf + zf) * 0.0007).sin() * 0.6;
    let humidity =
        (xf * 0.0013).cos() * 1.0 + (zf * 0.0019).sin() * 1.0 + ((xf - zf) * 0.0009).cos() * 0.6;
    if temperature > 1.1 && humidity < 0.0 {
        return Biome::Desert;
    }
    if temperature > 0.4 && humidity < 0.6 {
        return Biome::Savanna;
    }
    if humidity > 0.7 {
        return Biome::Forest;
    }
    Biome::Plains
}

/// Surface block for a biome (mirrors `surfaceBlock` in `worldgen.ts`).
fn surface_block(biome: Biome) -> u8 {
    match biome {
        Biome::Ocean | Biome::Beach | Biome::Desert => SAND,
        Biome::Snow => WHITE,
        Biome::Mountains => STONE,
        Biome::Savanna => DIRT,
        Biome::Plains | Biome::Forest => GRASS,
    }
}

/// The welcome monument, folded into the shared worldgen so this authoritative world contains it
/// (diggable via the normal edit path, visible to creatures) and the client renders the same
/// generation. A two-cell-tall tenant face on a four-cell gold cross, centred on the world.
/// Mirrors `welcomeMonumentBlock` in `worldgen.ts` bit-for-bit (coords, ids, order).
const MONUMENT_X: i32 = WORLD_SIZE / 2;
const MONUMENT_Z: i32 = WORLD_SIZE / 2;

pub fn welcome_monument_block(x: i32, y: i32, z: i32) -> u8 {
    let dx = x - MONUMENT_X;
    let dz = z - MONUMENT_Z;
    if !(-1..=1).contains(&dx) || !(-1..=1).contains(&dz) {
        return AIR;
    }
    let top = height_at(MONUMENT_X, MONUMENT_Z);
    if dx == 0 && dz == 0 && (y == top + 1 || y == top + 2) {
        return FACE;
    }
    if y == top + 1 && dx.abs() + dz.abs() == 1 {
        return GOLD;
    }
    AIR
}

/// The procedurally-generated block at a coordinate, ignoring player edits.
pub fn base_voxel(x: i32, y: i32, z: i32) -> u8 {
    if !(0..SIZE_Y).contains(&y) {
        return AIR;
    }
    let monument = welcome_monument_block(x, y, z);
    if monument != AIR {
        return monument;
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
        return surface_block(biome_at(x, z));
    }
    if y >= top - 2 {
        return DIRT;
    }
    STONE
}

/// A spatial hash of chunk coords -> a 32-bit seed. Mirrors `chunkSeed` in `world.ts`: combined
/// with [`Mulberry32`] it makes world decoration reproducible from chunk position alone.
fn chunk_seed(cx: i32, cz: i32) -> u32 {
    (cx as u32).wrapping_mul(374761393) ^ (cz as u32).wrapping_mul(668265263) ^ 0x9e3779b9
}

/// Tiny deterministic PRNG. Bit-for-bit identical to the TS `mulberry32` (the JS engine uses
/// `Math.imul`, which is exactly `wrapping_mul` on `u32`), so server decoration matches the client.
struct Mulberry32 {
    state: u32,
}

impl Mulberry32 {
    fn new(seed: u32) -> Self {
        Self { state: seed }
    }

    fn next(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x6d2b79f5);
        let mut t = self.state;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }
}

/// Lazily-materialized procedural decoration (trees + plants), keyed by chunk. Seeded by chunk
/// coords so it is deterministic and order-free; populated on first access to any voxel in a chunk
/// so `get`/`is_solid`/`surface_y` see tree trunks and leaves just like the client.
#[derive(Default)]
struct Decor {
    voxels: HashMap<(i32, i32, i32), u8>,
    done: HashSet<(i32, i32)>,
}

/// Block at a voxel as seen *during decoration*: a block already placed by this chunk's decoration,
/// else the procedural base. Mirrors the TS `rawGet` over base terrain + water + prior decoration.
fn decoration_voxel_at(x: i32, y: i32, z: i32, placed: &HashMap<(i32, i32, i32), u8>) -> u8 {
    if let Some(&v) = placed.get(&(x, y, z)) {
        return v;
    }
    base_voxel(x, y, z)
}

/// Place a single tree: a wood trunk topped with a leaf blob, clamped to the chunk like the client.
/// Mirrors `placeTree` in `world.ts` exactly (same trunk height, leaf id, and blob shape).
fn place_tree(
    x: i32,
    top: i32,
    z: i32,
    chunk_origin: (i32, i32),
    biome: Biome,
    rng: &mut Mulberry32,
    placed: &mut HashMap<(i32, i32, i32), u8>,
) {
    let (x0, z0) = chunk_origin;
    let trunk = 3 + (rng.next() * 3.0).floor() as i32;
    for t in 1..=trunk {
        placed.insert((x, top + t, z), WOOD);
    }
    let leaf = if biome == Biome::Snow { WHITE } else { LEAF };
    let cy = top + trunk;
    for dx in -2..=2 {
        for dz in -2..=2 {
            for dy in 0..=2 {
                let lx = x + dx;
                let lz = z + dz;
                if lx < x0 || lx >= x0 + CHUNK || lz < z0 || lz >= z0 + CHUNK {
                    continue;
                }
                if dx.abs() + dz.abs() + dy > 3 {
                    continue;
                }
                if decoration_voxel_at(lx, cy + dy, lz, placed) == AIR {
                    placed.insert((lx, cy + dy, lz), leaf);
                }
            }
        }
    }
}

/// Materialize a chunk's procedural decoration into `placed`. Mirrors `decorateChunk` in `world.ts`:
/// same RNG seed, iteration order, density thresholds and block ids, so the server world is
/// identical to the client's (and `surface_y` accounts for trees).
fn decorate_chunk(cx: i32, cz: i32, placed: &mut HashMap<(i32, i32, i32), u8>) {
    let x0 = cx * CHUNK;
    let z0 = cz * CHUNK;
    let mut rng = Mulberry32::new(chunk_seed(cx, cz));
    for _ in 0..30 {
        let x = x0 + 2 + (rng.next() * (CHUNK - 4) as f64).floor() as i32;
        let z = z0 + 2 + (rng.next() * (CHUNK - 4) as f64).floor() as i32;
        let top = height_at(x, z);
        if top <= WATER_LEVEL {
            continue;
        }
        let biome = biome_at(x, z);
        let density = match biome {
            Biome::Forest => 0.75,
            Biome::Plains => 0.22,
            Biome::Snow => 0.16,
            _ => 0.02,
        };
        if rng.next() < density {
            place_tree(x, top, z, (x0, z0), biome, &mut rng, placed);
            continue;
        }
        if biome != Biome::Desert
            && rng.next() < 0.1
            && decoration_voxel_at(x, top + 1, z, placed) == AIR
        {
            placed.insert((x, top + 1, z), 9);
        }
    }
    for (chance, id) in [(0.5, 8u8), (0.28, 14), (0.08, 15)] {
        if rng.next() >= chance {
            continue;
        }
        let x = x0 + (rng.next() * CHUNK as f64).floor() as i32;
        let z = z0 + (rng.next() * CHUNK as f64).floor() as i32;
        let top = height_at(x, z);
        if top > WATER_LEVEL && decoration_voxel_at(x, top + 1, z, placed) == AIR {
            placed.insert((x, top + 1, z), id);
        }
    }
}

/// Authoritative world: procedural base + a sparse map of player edits + lazily-materialized
/// procedural decoration. The decoration cache is interior-mutable (built on demand under a mutex)
/// so the read-only `get`/`surface_y` surface stays `&self` while remaining `Send + Sync`.
#[derive(Default)]
pub struct World {
    edits: HashMap<(i32, i32, i32), u8>,
    decor: Mutex<Decor>,
}

impl World {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, x: i32, y: i32, z: i32) -> u8 {
        if let Some(&v) = self.edits.get(&(x, y, z)) {
            return v;
        }
        if let Some(v) = self.decor_voxel(x, y, z) {
            return v;
        }
        base_voxel(x, y, z)
    }

    /// Procedural decoration at a voxel (tree trunk/leaf or plant), materializing the owning chunk on
    /// first touch. Returns `None` when no decoration occupies the cell.
    fn decor_voxel(&self, x: i32, y: i32, z: i32) -> Option<u8> {
        if !(0..SIZE_Y).contains(&y) {
            return None;
        }
        let cx = x.div_euclid(CHUNK);
        let cz = z.div_euclid(CHUNK);
        let mut decor = self.decor.lock().expect("decor mutex poisoned");
        if decor.done.insert((cx, cz)) {
            decorate_chunk(cx, cz, &mut decor.voxels);
        }
        decor.voxels.get(&(x, y, z)).copied()
    }

    pub fn set(&mut self, x: i32, y: i32, z: i32, id: u8) {
        self.edits.insert((x, y, z), id);
    }

    pub fn is_solid(&self, x: i32, y: i32, z: i32) -> bool {
        let v = self.get(x, y, z);
        v != AIR && v != WATER
    }

    /// The topmost solid block y in a column, accounting for player edits (the edit-aware analog of
    /// [`height_at`]). Scans the column top-down; returns 0 (the bedrock floor) when nothing is solid.
    pub fn surface_y(&self, x: i32, z: i32) -> i32 {
        (0..SIZE_Y)
            .rev()
            .find(|&y| self.is_solid(x, y, z))
            .unwrap_or(0)
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

    /// A reasonable spawn near the center of the world, offset a few blocks off the exact centre so the
    /// player never lands inside the welcome monument (built at the center) and gets wedged.
    pub fn spawn() -> [f32; 3] {
        let cx = WORLD_SIZE / 2;
        let cz = WORLD_SIZE / 2 + SPAWN_MONUMENT_CLEARANCE;
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
        for x in 0..4000 {
            for z in (0..4000).step_by(7) {
                let h = height_at(x, z);
                assert!(
                    (MIN_HEIGHT..=MAX_HEIGHT).contains(&h),
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
    fn biome_at_only_returns_known_biomes() {
        // Sample broadly; every column must classify into one of the eight biomes (the match is
        // total, so this also guards against an unreachable arm via the surface_block mapping).
        for i in 0..400 {
            let (x, z) = (i * 271 - 50000, i * 409 - 50000);
            let biome = biome_at(x, z);
            let _ = surface_block(biome);
        }
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
        assert_eq!(
            base_voxel(x, top, z),
            surface_block(biome_at(x, z)),
            "surface must be the biome's surface block"
        );
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
    fn welcome_monument_is_generated_at_the_centre() {
        let cx = WORLD_SIZE / 2;
        let cz = WORLD_SIZE / 2;
        let top = height_at(cx, cz);
        assert_eq!(welcome_monument_block(cx, top + 1, cz), FACE);
        assert_eq!(welcome_monument_block(cx, top + 2, cz), FACE);
        assert_eq!(welcome_monument_block(cx - 1, top + 1, cz), GOLD);
        assert_eq!(welcome_monument_block(cx + 1, top + 1, cz), GOLD);
        assert_eq!(welcome_monument_block(cx, top + 1, cz - 1), GOLD);
        assert_eq!(welcome_monument_block(cx, top + 1, cz + 1), GOLD);
        assert_eq!(welcome_monument_block(cx, top, cz), AIR);
        assert_eq!(welcome_monument_block(cx, top + 3, cz), AIR);
        assert_eq!(welcome_monument_block(cx + 2, top + 1, cz), AIR);
        assert_eq!(welcome_monument_block(10, top + 1, 10), AIR);
        assert_eq!(base_voxel(cx, top + 1, cz), FACE);
        assert_eq!(base_voxel(cx, top + 2, cz), FACE);
        assert_eq!(base_voxel(cx - 1, top + 1, cz), GOLD);
        assert_eq!(base_voxel(cx, top + 3, cz), AIR);
    }

    #[test]
    fn welcome_monument_block_is_solid_and_diggable() {
        let mut w = World::new();
        let cx = WORLD_SIZE / 2;
        let cz = WORLD_SIZE / 2;
        let top = height_at(cx, cz);
        assert!(w.is_solid(cx, top + 1, cz), "monument block must be solid");
        w.set(cx, top + 1, cz, AIR);
        assert!(
            !w.is_solid(cx, top + 1, cz),
            "digging the monument must break it"
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
    fn surface_y_tracks_terrain_and_decoration_without_edits() {
        // Without player edits the surface is the bare terrain unless procedural decoration (a tree)
        // sits on top, which only ever raises it — never below the terrain, never the wrong block.
        let w = World::new();
        for i in 0..50 {
            let (x, z) = (i * 137, i * 211);
            let terrain = height_at(x, z);
            assert!(
                w.surface_y(x, z) >= terrain,
                "decoration must not lower the surface at {x},{z}"
            );
            assert_eq!(
                w.get(x, terrain, z),
                base_voxel(x, terrain, z),
                "terrain block under decoration must be untouched at {x},{z}"
            );
        }
    }

    #[test]
    fn surface_y_rises_with_a_placed_block() {
        let mut w = World::new();
        let (x, z) = (20, 30);
        let top = height_at(x, z);
        w.set(x, top + 3, z, STONE);
        assert_eq!(w.surface_y(x, z), top + 3);
    }

    #[test]
    fn surface_y_lowers_when_top_block_is_broken() {
        let mut w = World::new();
        let (x, z) = (40, 50);
        let top = height_at(x, z);
        w.set(x, top, z, AIR);
        assert_eq!(w.surface_y(x, z), top - 1);
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
    fn mulberry32_matches_js_reference() {
        // Bit-for-bit parity with the TS `mulberry32(chunkSeed(3, 5))` sequence (computed in Node).
        assert_eq!(chunk_seed(3, 5), 438098241);
        let mut rng = Mulberry32::new(chunk_seed(3, 5));
        let expected = [
            0.7037569049280137,
            0.5581657572183758,
            0.5128003796562552,
            0.41803828929550946,
            0.3890336675103754,
            0.11730545782484114,
        ];
        for (i, want) in expected.iter().enumerate() {
            assert_eq!(rng.next(), *want, "rng draw {i}");
        }
    }

    #[test]
    fn decoration_is_deterministic() {
        // Generating the same chunk twice yields identical voxels (independent worlds agree too).
        let mut a = HashMap::new();
        let mut b = HashMap::new();
        decorate_chunk(0, 0, &mut a);
        decorate_chunk(0, 0, &mut b);
        assert_eq!(a, b);
        assert!(!a.is_empty(), "chunk (0,0) is known to decorate");

        let w1 = World::new();
        let w2 = World::new();
        for y in 0..SIZE_Y {
            assert_eq!(w1.get(4, y, 10), w2.get(4, y, 10), "y={y}");
        }
    }

    #[test]
    fn tree_raises_surface_above_bare_terrain() {
        // Chunk (0,0) deterministically grows a tree whose trunk is at column (4,10).
        let w = World::new();
        let terrain = height_at(4, 10);
        assert!(
            w.surface_y(4, 10) > terrain,
            "the tree trunk/leaves must raise surface_y above bare terrain"
        );
        assert!(w.is_solid(4, terrain + 1, 10), "trunk base must be solid");
    }

    #[test]
    fn decoration_matches_web_known_column() {
        // Cross-check against the TS engine: chunk (0,0), trunk column (4,10), trunk height 4.
        // Wood at y20..=23, leaf at y24..=25, air above; surface_y is the leaf top (computed in Node).
        let w = World::new();
        assert_eq!(height_at(4, 10), 19);
        let expected: [(i32, u8); 8] = [
            (19, GRASS),
            (20, WOOD),
            (21, WOOD),
            (22, WOOD),
            (23, WOOD),
            (24, LEAF),
            (25, LEAF),
            (26, AIR),
        ];
        for (y, id) in expected {
            assert_eq!(w.get(4, y, 10), id, "voxel at (4,{y},10)");
        }
        assert_eq!(w.surface_y(4, 10), 25);
    }

    #[test]
    fn decoration_does_not_overwrite_player_edits() {
        // A player edit always wins over procedural decoration at the same cell.
        let mut w = World::new();
        w.set(4, 21, 10, AIR);
        assert_eq!(w.get(4, 21, 10), AIR, "edit must mask the tree trunk");
    }

    #[test]
    fn spawn_inside_world() {
        let s = World::spawn();
        assert!(s[0] > 0.0 && s[0] < WORLD_SIZE as f32);
        assert!(s[2] > 0.0 && s[2] < WORLD_SIZE as f32);
        assert!(s[1] > 0.0 && s[1] < SIZE_Y as f32 + 8.0);
    }

    #[test]
    fn spawn_clears_the_centre_monument() {
        // The shared worldgen builds a welcome monument at the exact world center; the spawn must sit clear
        // of it (and its 1-block neighbours) so a co-op player who adopts this spawn is never wedged inside it.
        let s = World::spawn();
        let centre = (WORLD_SIZE / 2) as f32 + 0.5;
        assert_eq!(s[0], centre, "spawn stays on the centre x");
        assert!(
            s[2] - centre >= SPAWN_MONUMENT_CLEARANCE as f32,
            "spawn is offset clear of the centre monument, got z offset {}",
            s[2] - centre
        );
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

    // Deterministic sample grid shared with the web worldgen parity test. The web test must
    // iterate coordinates in the SAME order: for i in 0..32 { for j in 0..32 { (i*271, j*409) } }.
    fn golden_heights() -> Vec<i32> {
        (0..32)
            .flat_map(|i| (0..32).map(move |j| (i * 271, j * 409)))
            .map(|(x, z)| height_at(x, z))
            .collect()
    }

    /// Pins the worldgen output so the Rust server and the TypeScript client can never silently
    /// diverge. Writes the golden file on first run, asserts against it afterwards.
    #[test]
    fn worldgen_matches_shared_golden() {
        let json = format!(
            "[{}]",
            golden_heights()
                .iter()
                .map(|h| h.to_string())
                .collect::<Vec<_>>()
                .join(",")
        );
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../web/lib/engine/worldgen.golden.json"
        );
        match std::fs::read_to_string(path) {
            Ok(existing) => assert_eq!(
                existing.trim(),
                json,
                "worldgen drifted from the golden vectors"
            ),
            Err(_) => {
                let parent = std::path::Path::new(path).parent().unwrap();
                std::fs::create_dir_all(parent).unwrap();
                std::fs::write(path, &json).unwrap();
            }
        }
    }
}
