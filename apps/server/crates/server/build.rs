// Bake the short git SHA into the binary at compile time so the debug panel's backend version is the
// same TYPE as the frontend's (a 7-char commit SHA), not the crate version. Best-effort: if git or the
// repo isn't available at build, BUILD_GIT_SHA is left unset and `server_version()` falls back.
use std::process::Command;

fn main() {
    let Ok(output) = Command::new("git").args(["rev-parse", "--short", "HEAD"]).output() else {
        return;
    };
    if !output.status.success() {
        return;
    }
    let sha = String::from_utf8_lossy(&output.stdout);
    let sha = sha.trim();
    if sha.is_empty() {
        return;
    }
    println!("cargo:rustc-env=BUILD_GIT_SHA={sha}");
}
