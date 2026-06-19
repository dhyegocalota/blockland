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
    if y < 0 || y >= SIZE_Y {
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

    /// A reasonable spawn near the center of the world.
    pub fn spawn() -> [f32; 3] {
        let cx = WORLD_SIZE / 2;
        let cz = WORLD_SIZE / 2;
        let y = height_at(cx, cz) as f32 + 3.0;
        [cx as f32 + 0.5, y, cz as f32 + 0.5]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn height_stays_in_bounds() {
        for x in 0..400 {
            for z in (0..400).step_by(7) {
                let h = height_at(x, z);
                assert!(h >= 2 && h <= SIZE_Y - 5, "height {h} out of bounds at {x},{z}");
            }
        }
    }

    #[test]
    fn height_is_deterministic() {
        assert_eq!(height_at(123, 456), height_at(123, 456));
    }

    #[test]
    fn base_voxel_layers() {
        let (x, z) = (100, 100);
        let top = height_at(x, z);
        assert_eq!(base_voxel(x, 0, z), BEDROCK, "y=0 must be bedrock");
        assert_eq!(base_voxel(x, top, z), 1, "surface must be grass");
        assert_eq!(base_voxel(x, top + 1, z), AIR, "above surface must be air");
        assert!(base_voxel(x, top - 1, z) != AIR, "below surface must be solid");
        assert_eq!(base_voxel(x, SIZE_Y, z), AIR, "out of vertical range is air");
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
}
