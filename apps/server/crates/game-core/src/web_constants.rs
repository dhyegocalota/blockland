//! Single source of truth for the gameplay/physics/world constants the web client must agree on.
//! The values live where the simulation uses them (`sim`, [`crate::room`], [`crate::creatures`]); the
//! `export_web_constants` test below writes them to `apps/web/lib/engine/constants.gen.ts` (the same
//! ts-rs-style codegen as `protocol.gen.ts`), so the client never hand-mirrors a server number that
//! could silently drift. Regenerate with `cargo test -p game-core`.

#[cfg(test)]
mod export {
    use crate::{creatures, room};

    /// The shared constants emitted to the web, each `(ts_name, rust_value_as_ts_literal)`. The Rust
    /// value is the authority; the TypeScript file is generated, never edited.
    fn web_constants() -> Vec<(&'static str, String)> {
        vec![
            ("SIZE_X", sim::WORLD_SIZE.to_string()),
            ("SIZE_Z", sim::WORLD_SIZE.to_string()),
            ("SIZE_Y", sim::SIZE_Y.to_string()),
            ("CHUNK", sim::CHUNK.to_string()),
            ("GROUND", sim::GROUND.to_string()),
            ("WATER_LEVEL", sim::WATER_LEVEL.to_string()),
            ("MAX_FLY_Y", sim::MAX_FLY_Y.to_string()),
            ("DIG_HITS", room::DIG_HITS.to_string()),
            ("MAX_HEARTS", room::MAX_HP.to_string()),
            ("EYE_HEIGHT", room::PLAYER_EYE_HEIGHT.to_string()),
            ("DEATH_FALL_MS", room::DEATH_FALL.as_millis().to_string()),
            ("HURT_COOLDOWN", seconds(room::HURT_COOLDOWN)),
            ("HEART_PICKUP_RADIUS", room::PICKUP_RADIUS.to_string()),
            ("HEART_DROP_TTL_MS", room::HEART_TTL.as_millis().to_string()),
            (
                "CREATURE_SEPARATION",
                creatures::CREATURE_SEPARATION.to_string(),
            ),
            (
                "CREATURE_STOP_DISTANCE",
                creatures::STOP_DISTANCE.to_string(),
            ),
            ("CREATURE_ORBIT_SPEED", creatures::ORBIT_SPEED.to_string()),
            (
                "CREATURE_ORBIT_FLIP_TICKS",
                creatures::ORBIT_FLIP_TICKS.to_string(),
            ),
            ("SPAWN_OFFSET_Z", sim::SPAWN_MONUMENT_CLEARANCE.to_string()),
            ("SPAWN_AREA_RADIUS", sim::SPAWN_AREA_RADIUS.to_string()),
            ("SPAWN_SEARCH_RADIUS", sim::SPAWN_SEARCH_RADIUS.to_string()),
            ("SPAWN_CLEARANCE_GAP", sim::SPAWN_CLEARANCE_GAP.to_string()),
        ]
    }

    /// The shared voxel block ids, each `(ts_name, rust_value)`. These are the ids the worldgen and
    /// world edits encode, so `sim` is the authority; the client kept a hand-written mirror (which
    /// could silently drift) until this emitted them. Client-only ids (palette-only colours with no
    /// server meaning) and naming aliases stay hand-written in `constants.ts`.
    fn web_block_ids() -> Vec<(&'static str, u8)> {
        vec![
            ("AIR", sim::AIR),
            ("GRASS_ID", sim::GRASS),
            ("DIRT_ID", sim::DIRT),
            ("STONE_ID", sim::STONE),
            ("WOOD_ID", sim::WOOD),
            ("LEAF_ID", sim::LEAF),
            ("SAND_ID", sim::SAND),
            ("GOLD_ID", sim::GOLD),
            ("FACE_ID", sim::FACE),
            ("WATER_ID", sim::WATER),
            ("WHITE_ID", sim::WHITE),
            ("BEDROCK_ID", sim::BEDROCK),
        ]
    }

    fn seconds(duration: std::time::Duration) -> String {
        duration.as_secs_f32().to_string()
    }

    fn render() -> String {
        let mut out = String::new();
        out.push_str("// AUTO-GENERATED from apps/server/crates (sim + game-core). Do not edit.\n");
        out.push_str("// Regenerate with: cargo test -p game-core\n");
        out.push_str(
            "// The Rust simulation is the single source of truth for these gameplay/physics/world\n",
        );
        out.push_str(
            "// constants; constants.ts re-exports them so client and server can never drift.\n\n",
        );
        for (name, value) in web_constants() {
            out.push_str(&format!("export const {name} = {value};\n"));
        }
        out.push_str(
            "\n// Shared voxel block ids — the ids the worldgen and world edits encode. The client-only\n",
        );
        out.push_str(
            "// palette ids and naming aliases stay hand-written in constants.ts; these are the shared set.\n",
        );
        for (name, value) in web_block_ids() {
            out.push_str(&format!("export const {name} = {value};\n"));
        }
        out
    }

    /// Regenerate `constants.gen.ts` from the Rust source AND guard that the committed file was already
    /// up to date. Run via `cargo test` (`cargo test -p game-core`): the file is rewritten so a value
    /// change here propagates to the web client, and CI fails if the committed copy was stale (a number
    /// changed without regenerating), so the client can never hand-mirror a server value that drifts.
    /// A single test owns the file (no second reader) so the write and the check never race.
    #[test]
    fn export_web_constants_and_assert_committed_is_up_to_date() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../web/lib/engine/constants.gen.ts"
        );
        let generated = render();
        let committed = std::fs::read_to_string(path).unwrap();
        std::fs::write(path, &generated).unwrap();
        assert_eq!(
            committed, generated,
            "constants.gen.ts was stale — it has now been regenerated; commit the result"
        );
    }
}
