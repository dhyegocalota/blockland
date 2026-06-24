//! Authoritative creature simulation: pure-ish AI shared by the whole room so every client renders
//! identical animals and monsters. The room owns the population and ids; this module decides per-kind
//! stats and advances one creature per tick given the players, the peace flag, and a ground function.
//!
//! Determinism without RNG state: wander jitter is derived from (id, tick), so a creature's motion is
//! reproducible and needs no stored seed. Hostiles chase the nearest player within `CHASE_RADIUS` only
//! when peace is off; otherwise everything wanders. The hp/reward/speed table mirrors the web
//! `CREATURE_DEFS` so client prediction and server truth agree.

use std::f32::consts::PI;

/// Horizontal distance within which a hostile creature homes in on a player (when not at peace). Must
/// cover `SPAWN_RADIUS` (28) so the hostiles spawned around a player actually chase + bite them rather
/// than wandering forever just outside chase range. Mirrors the web `stepCreatureDirection` threshold.
pub const CHASE_RADIUS: f32 = 30.0;
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
                hp: 2,
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
                hp: 2,
                reward: 5,
                hostile: true,
                speed: 3.0,
            },
        }
    }

    /// Compact wire index into the fixed kind table (`ALL` order), so the per-tick snapshot carries a
    /// small integer instead of the slug string. The client maps it back via the same table.
    pub fn index(self) -> u8 {
        match self {
            Self::Pig => 0,
            Self::Chicken => 1,
            Self::Cow => 2,
            Self::Slime => 3,
            Self::Spider => 4,
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
        // Once within biting distance a chaser orbits the player (a menacing circle) instead of standing
        // still: it strafes tangentially at ORBIT_SPEED while staying at the stop distance, so it keeps
        // touching the player and the room's bite still lands. Outside that band it homes in; with no
        // target it wanders. The orbit direction is a pure function of (id, tick) — no RNG, reproducible.
        let orbiting = matches!(target, Some((_, dist)) if dist < STOP_DISTANCE);
        let speed = if orbiting { ORBIT_SPEED } else { config.speed };
        self.yaw = match target {
            Some((player, _)) if orbiting => orbit_yaw(player, self.pos, self.id, tick),
            Some((player, _)) => (player[0] - self.pos[0]).atan2(player[1] - self.pos[2]),
            None => wander_yaw(self.id, tick),
        };
        let next_x = self.pos[0] + self.yaw.sin() * speed * dt;
        let next_z = self.pos[2] + self.yaw.cos() * speed * dt;
        let next_ground = ground_y(next_x, next_z, &height_at);
        // A creature can drop into a hole but climbs at most one block per step, so it never scales a
        // wall or pops two blocks out of a pit the player dug — it walks at its own level.
        if next_ground - self.pos[1] > MAX_CLIMB {
            return;
        }
        self.pos[0] = next_x;
        self.pos[2] = next_z;
        // Step up a single block instantly, but EASE down bigger drops at a falling speed instead of
        // snapping straight to the new ground — a whole-block vertical snap every step reads as a
        // teleport (and a flicker through blocks) on the interpolating client.
        let drop = (next_ground - self.pos[1]).max(-MAX_FALL_SPEED * dt);
        self.pos[1] += drop.min(MAX_CLIMB);
    }
}

/// How close a chasing creature presses before it stops closing and orbits the player instead — just
/// inside bite range, so a circling creature still touches and bites rather than overrunning the player
/// and oscillating at their feet. Exported to the web as `CREATURE_STOP_DISTANCE`.
pub const STOP_DISTANCE: f32 = 0.65;
/// Tangential strafe speed (blocks/sec) of a hostile circling the player at the stop distance, and how
/// often (in ticks) its orbit reverses so the menacing circle isn't a perfect loop. The circle direction
/// is deterministic per id (no RNG), so server and client orbit identically. Exported to the web as
/// `CREATURE_ORBIT_SPEED` / `CREATURE_ORBIT_FLIP_TICKS`.
pub const ORBIT_SPEED: f32 = 2.4;
pub const ORBIT_FLIP_TICKS: u64 = 80;
/// Tallest step a creature may climb in a single move (one block).
const MAX_CLIMB: f32 = 1.0;
/// How fast a creature falls when it walks off a ledge (blocks per second), so drops are smooth
/// instead of an instant vertical teleport.
const MAX_FALL_SPEED: f32 = 10.0;
/// Two creatures closer than this on the ground push apart so they never stack into one blob. Mirrors
/// the web `CREATURE_SEPARATION` so the server's truth and the client's prediction agree.
pub const CREATURE_SEPARATION: f32 = 0.9;

/// Push apart any two creatures whose horizontal (XZ) gap is under `CREATURE_SEPARATION`, splitting the
/// correction evenly so neither is favoured, then settle each back onto its ground column (separation is
/// XZ-only; the ground clamp owns y). Two exactly coincident creatures split along a stable axis chosen
/// by id so the result is deterministic. Mirrors the web `separateCreatures`.
pub fn separate_creatures(creatures: &mut [Creature], height_at: impl Fn(i32, i32) -> i32) {
    for i in 0..creatures.len() {
        for j in (i + 1)..creatures.len() {
            let (a, b) = creatures.split_at_mut(j);
            push_apart(&mut a[i], &mut b[0]);
        }
    }
    for creature in creatures.iter_mut() {
        creature.pos[1] = ground_y(creature.pos[0], creature.pos[2], &height_at);
    }
}

fn push_apart(a: &mut Creature, b: &mut Creature) {
    let delta_x = b.pos[0] - a.pos[0];
    let delta_z = b.pos[2] - a.pos[2];
    let distance = (delta_x * delta_x + delta_z * delta_z).sqrt();
    if distance >= CREATURE_SEPARATION {
        return;
    }
    let (axis_x, axis_z) = if distance > 0.0 {
        (delta_x / distance, delta_z / distance)
    } else if a.id < b.id {
        (1.0, 0.0)
    } else {
        (-1.0, 0.0)
    };
    let push = (CREATURE_SEPARATION - distance) / 2.0;
    a.pos[0] -= axis_x * push;
    a.pos[2] -= axis_z * push;
    b.pos[0] += axis_x * push;
    b.pos[2] += axis_z * push;
}

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

/// A heading perpendicular to the player so the creature orbits at its current radius. Even-id creatures
/// circle one way, odd-id the other, and every ORBIT_FLIP_TICKS the whole orbit reverses — all pure
/// functions of (id, tick), so the circle is reproducible on server and client with no RNG. Mirrors the
/// web `orbitYaw`.
fn orbit_yaw(player: [f32; 2], pos: [f32; 3], id: u32, tick: u64) -> f32 {
    let toward_player = (player[0] - pos[0]).atan2(player[1] - pos[2]);
    let clockwise = id.is_multiple_of(2);
    let flipped = !(tick / ORBIT_FLIP_TICKS).is_multiple_of(2);
    let sign = if clockwise == flipped { 1.0 } else { -1.0 };
    toward_player + sign * (PI / 2.0)
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
        assert_eq!(CreatureKind::Cow.config().hp, 2);
        assert_eq!(CreatureKind::Cow.config().reward, 3);
        assert_eq!(CreatureKind::Slime.config().reward, 3);
        assert!(CreatureKind::Slime.config().hostile);
        assert_eq!(CreatureKind::Spider.config().hp, 2);
        assert_eq!(CreatureKind::Spider.config().reward, 5);
        assert!(CreatureKind::Spider.config().hostile);
    }

    #[test]
    fn slugs_are_the_web_kinds() {
        let slugs: Vec<&str> = CreatureKind::ALL.iter().map(|k| k.slug()).collect();
        assert_eq!(slugs, ["pig", "chicken", "cow", "slime", "spider"]);
    }

    #[test]
    fn index_is_the_position_in_the_kind_table() {
        let indices: Vec<u8> = CreatureKind::ALL.iter().map(|k| k.index()).collect();
        assert_eq!(indices, [0, 1, 2, 3, 4]);
    }

    #[test]
    fn spawn_sits_on_the_ground() {
        let c = Creature::spawn(1, CreatureKind::Pig, 5.0, 5.0, flat());
        assert_eq!(c.pos[1], 10.0 + GROUND_OFFSET);
        assert_eq!(c.hp, 2);
        assert_eq!(c.max_hp, 2);
    }

    #[test]
    fn a_chaser_orbits_the_player_within_biting_distance_instead_of_overrunning() {
        let player = [[5.0, 5.0]];
        // Spawned 0.5 away (inside STOP_DISTANCE): a hostile creature should circle the player rather
        // than walk into them and jitter at their feet — its angle around the player changes between
        // ticks while it stays near the engage band (so the room's bite still lands).
        let mut close = Creature::spawn(2, CreatureKind::Spider, 5.5, 5.0, flat());
        let angle_to_player =
            |c: &Creature| (c.pos[0] - player[0][0]).atan2(c.pos[2] - player[0][1]);
        let radius = |c: &Creature| {
            ((c.pos[0] - player[0][0]).powi(2) + (c.pos[2] - player[0][1]).powi(2)).sqrt()
        };
        let before_angle = angle_to_player(&close);
        close.advance(&player, false, 0.1, 0, flat());
        assert!(
            (angle_to_player(&close) - before_angle).abs() > 1e-3,
            "a creature within stop distance strafes around the player"
        );
        assert!(
            radius(&close) < STOP_DISTANCE + 0.5,
            "the orbit keeps it near the engage band, radius={}",
            radius(&close)
        );
        // From outside biting distance it still closes in.
        let mut far = Creature::spawn(2, CreatureKind::Spider, 9.0, 5.0, flat());
        far.advance(&player, false, 0.1, 0, flat());
        assert!(
            far.pos[0] < 9.0,
            "a chaser outside biting distance moves closer"
        );
    }

    #[test]
    fn orbit_yaw_is_perpendicular_and_flips_by_id_and_cadence() {
        let player = [0.0_f32, 5.0];
        let pos = [0.0_f32, 0.0, 4.0];
        let toward = (player[0] - pos[0]).atan2(player[1] - pos[2]);
        let gap = |a: f32, b: f32| (a - b).sin().atan2((a - b).cos()).abs();
        // Perpendicular to the player.
        assert!((gap(orbit_yaw(player, pos, 2, 0), toward) - PI / 2.0).abs() < 1e-4);
        // Even and odd ids circle opposite ways (a half-turn apart).
        assert!(
            (gap(orbit_yaw(player, pos, 2, 0), orbit_yaw(player, pos, 3, 0)) - PI).abs() < 1e-4
        );
        // The orbit reverses on the flip cadence.
        assert!(
            (gap(
                orbit_yaw(player, pos, 2, 0),
                orbit_yaw(player, pos, 2, ORBIT_FLIP_TICKS)
            ) - PI)
                .abs()
                < 1e-4
        );
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
    fn eases_off_a_ledge_instead_of_teleporting_down() {
        // A 15-block cliff just ahead: a hostile slime walks off chasing the player, but no single
        // 20Hz tick may drop more than the fall cap — it falls smoothly instead of snapping down.
        let terrain = |x: i32, _z: i32| if x >= 1 { 5 } else { 20 };
        let mut slime = Creature::spawn(1, CreatureKind::Slime, 0.5, 0.5, terrain);
        // Within CHASE_RADIUS so the hostile keeps walking toward (and off) the ledge each tick.
        let player = [[10.0_f32, 0.5_f32]];
        let dt = 0.05;
        for _ in 0..400 {
            let before = slime.pos[1];
            slime.advance(&player, false, dt, 1, terrain);
            assert!(
                slime.pos[1] >= before - MAX_FALL_SPEED * dt - 1e-3,
                "single-tick drop too large: {before} -> {}",
                slime.pos[1]
            );
        }
        assert!(
            (slime.pos[1] - (5.0 + GROUND_OFFSET)).abs() < 0.2,
            "settles on the lower ground, y={}",
            slime.pos[1]
        );
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

    #[test]
    fn separate_splits_two_creatures_sharing_a_spot() {
        let mut crowd = [
            Creature::spawn(1, CreatureKind::Pig, 5.0, 5.0, flat()),
            Creature::spawn(2, CreatureKind::Pig, 5.0, 5.0, flat()),
        ];
        separate_creatures(&mut crowd, flat());
        let gap = ((crowd[0].pos[0] - crowd[1].pos[0]).powi(2)
            + (crowd[0].pos[2] - crowd[1].pos[2]).powi(2))
        .sqrt();
        assert!(
            (gap - CREATURE_SEPARATION).abs() < 1e-4,
            "coincident creatures end exactly one separation apart, gap={gap}"
        );
        assert_eq!(
            crowd[0].pos[1],
            10.0 + GROUND_OFFSET,
            "separation re-settles onto the ground"
        );
    }

    #[test]
    fn separate_leaves_distant_creatures_untouched() {
        let mut crowd = [
            Creature::spawn(1, CreatureKind::Pig, 0.0, 0.0, flat()),
            Creature::spawn(2, CreatureKind::Pig, 5.0, 0.0, flat()),
        ];
        let before = [crowd[0].pos, crowd[1].pos];
        separate_creatures(&mut crowd, flat());
        assert_eq!(crowd[0].pos, before[0]);
        assert_eq!(crowd[1].pos, before[1]);
    }
}
