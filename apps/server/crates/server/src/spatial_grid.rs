//! A uniform spatial hash over the horizontal `(x, z)` plane, used to turn the per-tick AOI neighbor
//! lookups from O(N²) (every receiver scanned against every entity) into O(neighbors). Entities are
//! bucketed by cell; `near(x, z)` returns the ids in the 3×3 block of cells around a point — a superset
//! of everything within `aoi::AOI_RADIUS + aoi::AOI_HYSTERESIS` of it, so the caller can run the exact
//! `in_view` test over only those candidates. Pure, no I/O; rebuilt cheaply each tick from live positions.
//!
//! `CELL_SIZE` is chosen so the 3×3 neighborhood always covers the AOI reach: a point's own cell plus its
//! eight neighbors span from one cell-edge before it to one cell-edge after, i.e. at least `CELL_SIZE` in
//! every direction from the point. With `CELL_SIZE = 640` that reach (640) clears `AOI_RADIUS +
//! AOI_HYSTERESIS` (512 + 64 = 576), so no in-range entity can fall outside the queried cells.

use std::collections::HashMap;

use crate::aoi::{AOI_HYSTERESIS, AOI_RADIUS};

/// Side length of a grid cell. Must be at least `AOI_RADIUS + AOI_HYSTERESIS` so the 3×3 cell block
/// around any point covers the full AOI reach; 640 is the clean value just past the 576 minimum.
pub const CELL_SIZE: f32 = 640.0;

const _: () = assert!(CELL_SIZE >= AOI_RADIUS + AOI_HYSTERESIS);

/// The integer cell a coordinate falls into (floor division, so negative coordinates bucket correctly).
fn cell_of(coordinate: f32) -> i32 {
    (coordinate / CELL_SIZE).floor() as i32
}

/// A uniform grid keyed by `(cell_x, cell_z)`, each cell holding the ids inserted into it this tick.
#[derive(Default)]
pub struct SpatialGrid {
    cells: HashMap<(i32, i32), Vec<u32>>,
}

impl SpatialGrid {
    pub fn new() -> Self {
        Self::default()
    }

    /// Place an entity's id into the cell its `(x, z)` falls in.
    pub fn insert(&mut self, id: u32, x: f32, z: f32) {
        self.cells
            .entry((cell_of(x), cell_of(z)))
            .or_default()
            .push(id);
    }

    /// The ids in the 3×3 block of cells centered on the point's cell. A superset of every id within
    /// `AOI_RADIUS + AOI_HYSTERESIS` of `(x, z)`; the caller filters it down with the exact `in_view` test.
    pub fn near(&self, x: f32, z: f32) -> Vec<u32> {
        let (cx, cz) = (cell_of(x), cell_of(z));
        let mut ids = Vec::new();
        for dx in -1..=1 {
            for dz in -1..=1 {
                if let Some(cell) = self.cells.get(&(cx + dx, cz + dz)) {
                    ids.extend_from_slice(cell);
                }
            }
        }
        ids
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sorted(mut ids: Vec<u32>) -> Vec<u32> {
        ids.sort_unstable();
        ids
    }

    #[test]
    fn cell_size_covers_the_full_aoi_reach() {
        // The 3×3 block reaches at least CELL_SIZE from the query point; that must clear the AOI upper bound.
        const { assert!(CELL_SIZE >= AOI_RADIUS + AOI_HYSTERESIS) };
    }

    #[test]
    fn near_returns_the_same_cell() {
        let mut grid = SpatialGrid::new();
        grid.insert(1, 10.0, 10.0);
        assert_eq!(grid.near(20.0, 20.0), vec![1]);
    }

    #[test]
    fn near_returns_the_three_by_three_neighborhood() {
        let mut grid = SpatialGrid::new();
        // One id in each of the nine cells around the origin's cell.
        let mut expected = Vec::new();
        let mut id = 1;
        for dx in -1..=1 {
            for dz in -1..=1 {
                let x = dx as f32 * CELL_SIZE + CELL_SIZE / 2.0;
                let z = dz as f32 * CELL_SIZE + CELL_SIZE / 2.0;
                grid.insert(id, x, z);
                expected.push(id);
                id += 1;
            }
        }
        assert_eq!(
            sorted(grid.near(CELL_SIZE / 2.0, CELL_SIZE / 2.0)),
            sorted(expected)
        );
    }

    #[test]
    fn near_excludes_ids_two_cells_away() {
        let mut grid = SpatialGrid::new();
        grid.insert(1, CELL_SIZE / 2.0, CELL_SIZE / 2.0); // same cell as the query
        grid.insert(2, CELL_SIZE * 2.5, CELL_SIZE / 2.0); // two cells away on x -> excluded
        assert_eq!(grid.near(CELL_SIZE / 2.0, CELL_SIZE / 2.0), vec![1]);
    }

    #[test]
    fn near_excludes_a_far_entity() {
        let mut grid = SpatialGrid::new();
        grid.insert(1, 0.0, 0.0);
        grid.insert(2, 50_000.0, 0.0);
        assert_eq!(grid.near(0.0, 0.0), vec![1]);
    }

    #[test]
    fn negative_coordinates_bucket_into_distinct_cells() {
        let mut grid = SpatialGrid::new();
        grid.insert(1, -10.0, -10.0); // cell (-1, -1)
        grid.insert(2, -CELL_SIZE * 3.0, -CELL_SIZE * 3.0); // far negative, outside the 3x3
        assert_eq!(grid.near(-10.0, -10.0), vec![1]);
    }

    #[test]
    fn an_entity_within_the_aoi_reach_is_always_a_candidate() {
        // Any point within AOI_RADIUS + AOI_HYSTERESIS of the query must land in the queried 3x3 block.
        let mut grid = SpatialGrid::new();
        let reach = AOI_RADIUS + AOI_HYSTERESIS;
        for (offset_x, offset_z) in [(reach, 0.0), (0.0, reach), (reach, reach), (-reach, -reach)] {
            grid.cells.clear();
            grid.insert(7, offset_x, offset_z);
            assert!(
                grid.near(0.0, 0.0).contains(&7),
                "an entity at the AOI reach must be a near() candidate",
            );
        }
    }
}
