//! Authoritative creature simulation: pure-ish AI shared by the whole room so every client renders
//! identical animals and monsters. The room owns the population and ids; this module decides per-kind
//! stats and advances one creature per tick given the players, the peace flag, and a ground function.
//!
//! Determinism without RNG state: wander jitter is derived from (id, tick), so a creature's motion is
//! reproducible and needs no stored seed. Hostiles chase the nearest player within `CHASE_RADIUS` only
//! when peace is off; otherwise everything wanders. The hp/reward/speed table mirrors the web
//! `CREATURE_DEFS` so client prediction and server truth agree.

use std::f32::consts::PI;

/// Horizontal distance within which a hostile creature homes in on a player (when not at peace).
/// Mirrors the web `stepCreatureDirection` chase threshold.
pub const CHASE_RADIUS: f32 = 11.0;
/// A creature floats this many blocks above the ground column it stands on (its body center).
const GROUND_OFFSET: f32 = 0.5;

/// The five creature kinds the web already renders. Slugs are the wire `kind` strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CreatureKind {
    Pig,
    Chicken,
    Cow,
    Slime,
    Spider,
}

/// Per-kind stats. `hostile` creatures chase players; passive ones only wander. Mirrors the web defs.
pub struct CreatureConfig {
    pub hp: u8,
    pub reward: u32,
    pub hostile: bool,
    pub speed: f32,
}

impl CreatureKind {
    /// The wire `kind` string the client maps to a model. The server only ever emits these (it is
    /// authoritative over the population), so there is no inverse parse.
    pub fn slug(self) -> &'static str {
        match self {
            Self::Pig => "pig",
            Self::Chicken => "chicken",
            Self::Cow => "cow",
            Self::Slime => "slime",
            Self::Spider => "spider",
        }
    }

    pub fn config(self) -> CreatureConfig {
        match self {
            Self::Pig => CreatureConfig {
                hp: 2,
                reward: 2,
                hostile: false,
                speed: 2.2,
            },
            Self::Chicken => CreatureConfig {
                hp: 1,
                reward: 1,
                hostile: false,
                speed: 2.6,
            },
            Self::Cow => CreatureConfig {
                hp: 3,
                reward: 3,
                hostile: false,
                speed: 1.8,
            },
            Self::Slime => CreatureConfig {
                hp: 2,
                reward: 3,
                hostile: true,
                speed: 2.4,
            },
            Self::Spider => CreatureConfig {
                hp: 3,
                reward: 5,
                hostile: true,
                speed: 3.0,
            },
        }
    }

    /// Every kind, for spawning a varied population.
    pub const ALL: [CreatureKind; 5] = [
        Self::Pig,
        Self::Chicken,
        Self::Cow,
        Self::Slime,
        Self::Spider,
    ];
}

/// One simulated creature. `pos` is `[x, y, z]` in world units; `yaw` faces its travel direction.
pub struct Creature {
    pub id: u32,
    pub kind: CreatureKind,
    pub pos: [f32; 3],
    pub yaw: f32,
    pub hp: u8,
    pub max_hp: u8,
}

impl Creature {
    /// Spawn a creature of `kind` at a ground position (clamped onto the given terrain height).
    pub fn spawn(
        id: u32,
        kind: CreatureKind,
        x: f32,
        z: f32,
        height_at: impl Fn(i32, i32) -> i32,
    ) -> Self {
        let hp = kind.config().hp;
        let y = ground_y(x, z, &height_at);
        Self {
            id,
            kind,
            pos: [x, y, z],
            yaw: 0.0,
            hp,
            max_hp: hp,
        }
    }

    /// Advance one tick: steer (chase the nearest player if hostile and not at peace, else wander),
    /// step forward at the kind's speed, and clamp back onto the ground. `players` are `[x, z]` pairs.
    pub fn advance(
        &mut self,
        players: &[[f32; 2]],
        peace: bool,
        dt: f32,
        tick: u64,
        height_at: impl Fn(i32, i32) -> i32,
    ) {
        let config = self.kind.config();
        let target = nearest_player(self.pos, players)
            .filter(|&(_, dist)| config.hostile && !peace && dist < CHASE_RADIUS);
        self.yaw = match target {
            Some((player, _)) => (player[0] - self.pos[0]).atan2(player[1] - self.pos[2]),
            None => wander_yaw(self.id, tick),
        };
        let next_x = self.pos[0] + self.yaw.sin() * config.speed * dt;
        let next_z = self.pos[2] + self.yaw.cos() * config.speed * dt;
        let next_ground = ground_y(next_x, next_z, &height_at);
        // A creature can drop into a hole but climbs at most one block per step, so it never scales a
        // wall or pops two blocks out of a pit the player dug — it walks at its own level.
        if next_ground - self.pos[1] > MAX_CLIMB {
            return;
        }
        self.pos[0] = next_x;
        self.pos[2] = next_z;
        self.pos[1] = next_ground;
    }
}

/// Tallest step a creature may climb in a single move (one block).
const MAX_CLIMB: f32 = 1.0;

fn ground_y(x: f32, z: f32, height_at: &impl Fn(i32, i32) -> i32) -> f32 {
    height_at(x.floor() as i32, z.floor() as i32) as f32 + GROUND_OFFSET
}

/// The nearest player to `pos` as `([x, z], distance)`, or `None` when no players are present.
fn nearest_player(pos: [f32; 3], players: &[[f32; 2]]) -> Option<([f32; 2], f32)> {
    players
        .iter()
        .map(|&p| {
            let dist = ((p[0] - pos[0]).powi(2) + (p[1] - pos[2]).powi(2)).sqrt();
            (p, dist)
        })
        .min_by(|a, b| a.1.total_cmp(&b.1))
}

/// A wander heading derived purely from (id, tick): smooth, reproducible, and seedless. The id offsets
/// each creature's phase so they don't all turn in lockstep.
fn wander_yaw(id: u32, tick: u64) -> f32 {
    let phase = (id as f32) * 1.61803;
    let slow = (tick as f32) * 0.03;
    (slow + phase).sin() * PI
}

#[cfg(test)]
mod tests {
    use super::*;

    // A flat ground at y=10 so motion is purely horizontal in these tests.
    fn flat() -> impl Fn(i32, i32) -> i32 {
        |_x, _z| 10
    }

    #[test]
    fn config_table_matches_kinds() {
        assert_eq!(CreatureKind::Pig.config().hp, 2);
        assert_eq!(CreatureKind::Pig.config().reward, 2);
        assert!(!CreatureKind::Pig.config().hostile);
        assert_eq!(CreatureKind::Chicken.config().hp, 1);
        assert_eq!(CreatureKind::Chicken.config().reward, 1);
        assert_eq!(CreatureKind::Cow.config().hp, 3);
        assert_eq!(CreatureKind::Cow.config().reward, 3);
        assert_eq!(CreatureKind::Slime.config().reward, 3);
        assert!(CreatureKind::Slime.config().hostile);
        assert_eq!(CreatureKind::Spider.config().hp, 3);
        assert_eq!(CreatureKind::Spider.config().reward, 5);
        assert!(CreatureKind::Spider.config().hostile);
    }

    #[test]
    fn slugs_are_the_web_kinds() {
        let slugs: Vec<&str> = CreatureKind::ALL.iter().map(|k| k.slug()).collect();
        assert_eq!(slugs, ["pig", "chicken", "cow", "slime", "spider"]);
    }

    #[test]
    fn spawn_sits_on_the_ground() {
        let c = Creature::spawn(1, CreatureKind::Pig, 5.0, 5.0, flat());
        assert_eq!(c.pos[1], 10.0 + GROUND_OFFSET);
        assert_eq!(c.hp, 2);
        assert_eq!(c.max_hp, 2);
    }

    #[test]
    fn never_climbs_a_tall_wall() {
        // Ground 5, with a 4-block-tall wall from x>=3. A slime chasing a nearby player cannot scale it.
        let terrain = |x: i32, _z: i32| if x >= 3 { 9 } else { 5 };
        let mut c = Creature::spawn(1, CreatureKind::Slime, 1.0, 0.5, terrain);
        for _ in 0..300 {
            c.advance(&[[10.0, 0.5]], false, 0.1, 0, terrain);
        }
        assert!(c.pos[0] < 3.0, "blocked before the wall, x={}", c.pos[0]);
        assert!(c.pos[1] < 9.0, "never reaches the wall top, y={}", c.pos[1]);
    }

    #[test]
    fn climbs_a_single_block_step() {
        // A one-block step (5 -> 6) is climbable, so it keeps chasing past x=3.
        let terrain = |x: i32, _z: i32| if x >= 3 { 6 } else { 5 };
        let mut c = Creature::spawn(1, CreatureKind::Slime, 1.0, 0.5, terrain);
        for _ in 0..200 {
            c.advance(&[[10.0, 0.5]], false, 0.1, 0, terrain);
        }
        assert!(
            c.pos[0] > 3.0,
            "should step up the single block, x={}",
            c.pos[0]
        );
    }

    #[test]
    fn does_not_clip_out_of_a_deep_dug_pit() {
        // A creature standing at the floor of a 3-deep pit (surface 5) with surrounding ground at 8.
        // The two-block-plus rise traps it, so it never clips up through the pit wall.
        let surface = |x: i32, _z: i32| if x >= 3 { 8 } else { 5 };
        let mut c = Creature::spawn(1, CreatureKind::Slime, 1.0, 0.5, surface);
        for _ in 0..300 {
            c.advance(&[[10.0, 0.5]], false, 0.1, 0, surface);
        }
        assert!(c.pos[0] < 3.0, "trapped below the pit wall, x={}", c.pos[0]);
        assert!(c.pos[1] < 8.0, "never clips up the wall, y={}", c.pos[1]);
    }

    #[test]
    fn steps_up_a_single_block_rise() {
        // A one-block rise (5 -> 6) is still climbable, so the creature steps up onto it.
        let surface = |x: i32, _z: i32| if x >= 3 { 6 } else { 5 };
        let mut c = Creature::spawn(1, CreatureKind::Slime, 1.0, 0.5, surface);
        for _ in 0..200 {
            c.advance(&[[10.0, 0.5]], false, 0.1, 0, surface);
        }
        assert!(c.pos[0] > 3.0, "steps up the single block, x={}", c.pos[0]);
    }

    #[test]
    fn hostile_approaches_player_when_not_peace() {
        let mut spider = Creature::spawn(7, CreatureKind::Spider, 0.0, 0.0, flat());
        let player = [[0.0_f32, 6.0_f32]];
        let before = ((player[0][0] - spider.pos[0]).powi(2)
            + (player[0][1] - spider.pos[2]).powi(2))
        .sqrt();
        spider.advance(&player, false, 0.1, 1, flat());
        let after = ((player[0][0] - spider.pos[0]).powi(2)
            + (player[0][1] - spider.pos[2]).powi(2))
        .sqrt();
        assert!(
            after < before,
            "hostile should close the gap: {before} -> {after}"
        );
    }

    #[test]
    fn hostile_does_not_chase_under_peace() {
        let mut spider = Creature::spawn(7, CreatureKind::Spider, 0.0, 0.0, flat());
        spider.advance(&[[0.0, 6.0]], true, 0.1, 1, flat());
        assert_eq!(
            spider.yaw,
            wander_yaw(7, 1),
            "peace must make even a hostile wander, not face the player"
        );
    }

    #[test]
    fn passive_never_chases() {
        let mut pig = Creature::spawn(3, CreatureKind::Pig, 0.0, 0.0, flat());
        pig.advance(&[[0.0, 6.0]], false, 0.1, 1, flat());
        assert_eq!(
            pig.yaw,
            wander_yaw(3, 1),
            "a passive creature wanders even with a player in reach"
        );
    }

    #[test]
    fn stays_clamped_to_ground_on_sloped_terrain() {
        let slope = |x: i32, _z: i32| 10 + x.rem_euclid(4);
        let mut cow = Creature::spawn(2, CreatureKind::Cow, 0.0, 0.0, slope);
        cow.advance(&[], false, 0.5, 5, slope);
        let column = slope(cow.pos[0].floor() as i32, cow.pos[2].floor() as i32);
        assert_eq!(cow.pos[1], column as f32 + GROUND_OFFSET);
    }

    #[test]
    fn no_players_means_pure_wander() {
        let mut slime = Creature::spawn(4, CreatureKind::Slime, 0.0, 0.0, flat());
        let start = slime.pos;
        slime.advance(&[], false, 0.2, 3, flat());
        let moved = (slime.pos[0] - start[0]).abs() + (slime.pos[2] - start[2]).abs();
        assert!(
            moved > 0.0,
            "an idle world should still let creatures wander"
        );
    }
}
