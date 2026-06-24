//! Per-player area-of-interest (AOI) culling: a receiving player's snapshot carries only the entities
//! NEAR them, not the whole huge world (`WORLD_SIZE` = 163840). This pure module decides, by horizontal
//! distance, whether one entity belongs in one player's view. The room owns the per-connection set and
//! applies these rules; only thin glue lives there.
//!
//! Hysteresis stops boundary flicker: an entity ENTERS a player's set at `AOI_RADIUS` and only LEAVES
//! once it passes `AOI_RADIUS + AOI_HYSTERESIS` (the set is sticky at its upper bound). The receiving
//! player's own record is never AOI-filtered — it is always present (self-reconciliation must not be
//! culled), which the room enforces by including self unconditionally.

/// Horizontal radius within which an entity enters a player's snapshot view. Kept generously beyond the
/// client's maximum view distance so AOI never culls something the player could see: the client camera's
/// far plane is at most 380 (`apps/web/lib/engine/rendering/scene-setup.ts`) and fog ends well inside
/// that, so 512 leaves a wide margin past anything renderable.
pub const AOI_RADIUS: f32 = 512.0;
/// Once in-view, an entity stays in-view until its horizontal distance exceeds `AOI_RADIUS + AOI_HYSTERESIS`,
/// so an entity hovering near the boundary doesn't flicker in and out of the snapshot every tick.
pub const AOI_HYSTERESIS: f32 = 64.0;

/// Squared horizontal distance between two `(x, z)` points. Squared to avoid a per-entity `sqrt` on the
/// hot per-tick path; the radii are compared squared too.
fn horizontal_distance_sq(a: (f32, f32), b: (f32, f32)) -> f32 {
    let dx = a.0 - b.0;
    let dz = a.1 - b.1;
    dx * dx + dz * dz
}

/// Whether an entity at `entity_xz` is in `center`'s AOI this tick, given whether it was in-view last
/// tick. Enters at `AOI_RADIUS`; once in, stays until it passes `AOI_RADIUS + AOI_HYSTERESIS` (sticky).
pub fn in_view(center: (f32, f32), entity_xz: (f32, f32), was_in_view: bool) -> bool {
    let distance_sq = horizontal_distance_sq(center, entity_xz);
    let bound = if was_in_view {
        AOI_RADIUS + AOI_HYSTERESIS
    } else {
        AOI_RADIUS
    };
    distance_sq <= bound * bound
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enters_when_within_the_radius() {
        assert!(in_view((0.0, 0.0), (AOI_RADIUS - 1.0, 0.0), false));
    }

    #[test]
    fn stays_out_beyond_the_radius_when_not_already_in_view() {
        assert!(!in_view((0.0, 0.0), (AOI_RADIUS + 1.0, 0.0), false));
    }

    #[test]
    fn sticky_in_view_until_past_the_hysteresis_upper_bound() {
        // Just past the entry radius, an entity already in view stays in view (hysteresis band).
        let inside_band = (AOI_RADIUS + AOI_HYSTERESIS - 1.0, 0.0);
        assert!(
            in_view((0.0, 0.0), inside_band, true),
            "an in-view entity in the hysteresis band stays in view"
        );
        assert!(
            !in_view((0.0, 0.0), inside_band, false),
            "the same point does NOT enter from out-of-view (only the entry radius lets it in)"
        );
    }

    #[test]
    fn leaves_once_past_the_hysteresis_upper_bound() {
        let past_band = (AOI_RADIUS + AOI_HYSTERESIS + 1.0, 0.0);
        assert!(!in_view((0.0, 0.0), past_band, true));
    }

    #[test]
    fn distance_is_horizontal_only_ignoring_height() {
        // The y axis is absent from the (x, z) inputs, so a tall entity directly overhead is in-view.
        assert!(in_view((100.0, 200.0), (100.0, 200.0), false));
    }

    #[test]
    fn diagonal_distance_uses_both_axes() {
        // A point at (r, r) is sqrt(2)*r away — outside r even though each axis alone is within it.
        let r = AOI_RADIUS;
        assert!(!in_view((0.0, 0.0), (r * 0.8, r * 0.8), false));
    }
}
