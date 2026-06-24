//! Forwards `game-core`'s `tracing` events to the browser console, formatted like the web app's
//! `[BL:<scope>]` lines (`apps/web/lib/log.ts`), so the owner's debug logs show up in DevTools. The
//! scope is the event's target's last path segment (e.g. `game_core::room` → `room`); the level picks
//! `console.debug`/`warn`/`error`. Installation is gated by a debug flag so a normal session is quiet.

use std::fmt::Write as _;

use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::Layer;
use wasm_bindgen::JsValue;

#[wasm_bindgen::prelude::wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = debug)]
    fn console_debug(msg: &str);
    #[wasm_bindgen(js_namespace = console, js_name = warn)]
    fn console_warn(msg: &str);
    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn console_error(msg: &str);
}

/// Install the console bridge once, only when `debug` is on (mirrors the web logger's gate). A second
/// call is ignored (tracing allows a single global subscriber); failing to set it is not fatal.
pub fn install(debug: bool) {
    if !debug {
        return;
    }
    use tracing_subscriber::prelude::*;
    let _ = tracing_subscriber::registry().with(ConsoleLayer).try_init();
}

struct ConsoleLayer;

impl<S> Layer<S> for ConsoleLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let meta = event.metadata();
        let scope = meta.target().rsplit("::").next().unwrap_or(meta.target());

        let mut message = String::new();
        let mut visitor = LineVisitor { out: &mut message };
        event.record(&mut visitor);

        let line = format!("[BL:{scope}] {message}");
        match *meta.level() {
            Level::ERROR => console_error(&line),
            Level::WARN => console_warn(&line),
            _ => console_debug(&line),
        }
    }
}

/// Renders a `tracing` event into `[BL:scope] <message> key=value key=value`, putting the `message`
/// field first and appending the structured fields after it (the same useful-fields style the web logger
/// keeps), so a console line carries the ids/counts/coords the owner relies on.
struct LineVisitor<'a> {
    out: &'a mut String,
}

impl Visit for LineVisitor<'_> {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            let _ = write!(self.out, "{value:?}");
            return;
        }
        let sep = if self.out.is_empty() { "" } else { " " };
        let _ = write!(self.out, "{sep}{}={value:?}", field.name());
    }
}

/// Keep `JsValue` referenced so the `wasm-bindgen` extern block above always links cleanly.
#[allow(dead_code)]
fn _assert_jsvalue(_: JsValue) {}
